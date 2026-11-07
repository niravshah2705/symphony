'use strict';

const { Readable } = require('stream');
const { LLM_GATEWAY_ORG_HEADER, matchRoute } = require('@ai-fleet/shared-core/egress');
const credentials = require('./credentials');
const { validateProjectId } = require('./secrets-client');

/**
 * Authenticating reverse proxy: match an inbound request to an egress route,
 * inject the route's real credential, and stream to the true upstream. The agent
 * container speaks plaintext HTTP to us over loopback with a sentinel token; we
 * strip all inbound auth and swap in the provider credential. Bodies stream both
 * ways (SSE-safe): nothing is buffered.
 */

// Connection-scoped headers that must not be forwarded (RFC 7230 §6.1) plus ones
// we regenerate. `accept-encoding` is dropped so upstreams return identity — the
// proxy then never has to reconcile a compressed body with content metadata.
const DROP_REQUEST_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'accept-encoding',
  // Inbound auth is never forwarded — the proxy injects its own credential.
  'authorization', 'private-token', 'x-api-key', 'x-goog-api-key',
  'x-internal-token', 'x-org-internal-token', 'x-forwarded-authorization',
  'chatgpt-account-id', 'cookie',
  // Request context is consumed locally and must never reach a provider.
  'x-ai-fleet-project-id',
  // The per-org LangSmith policy identity is stamped only by the proxy.
  LLM_GATEWAY_ORG_HEADER.toLowerCase(),
  // Do not let a caller forge proxy-chain or client identity metadata.
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port',
  'x-forwarded-proto', 'x-real-ip',
  // OAuth-only; credentials.buildInjection re-adds it for a Claude OAuth
  // selection and omits it for an Anthropic API-key selection.
  'anthropic-beta',
]);

const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade',
  // Body was normalized by fetch (identity); let Node frame the piped stream.
  'content-length', 'content-encoding',
]);

/** Build the absolute upstream URL for a matched route + path remainder. */
function buildUpstreamUrl(route, rest, resolvedUpstream = route.upstream) {
  const tail = !rest || rest === '/' ? '' : rest;
  return `${resolvedUpstream}${tail}`;
}

/** Forwarded request headers: copy safe inbound headers, retarget Host, inject. */
function buildForwardHeaders(incoming, upstreamUrl, inject) {
  const host = (() => {
    try {
      return new URL(upstreamUrl).host;
    } catch (_) {
      return undefined;
    }
  })();
  const out = {};
  const connectionTokens = new Set(
    String(incoming && incoming.connection || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
  for (const [key, value] of Object.entries(incoming || {})) {
    if (DROP_REQUEST_HEADERS.has(key.toLowerCase()) || connectionTokens.has(key.toLowerCase())) continue;
    out[key.toLowerCase()] = value;
  }
  if (host) out.host = host;
  for (const [key, value] of Object.entries(inject || {})) out[key.toLowerCase()] = value;
  return out;
}

/** Response headers passed back to the agent (hop-by-hop + body-frame stripped). */
function filterResponseHeaders(headers) {
  const out = {};
  const entries = typeof headers.entries === 'function' ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) {
    if (DROP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function requestProjectId(headers) {
  const raw = headers && headers['x-ai-fleet-project-id'];
  if (raw === undefined || raw === null || raw === '') return '';
  if (Array.isArray(raw) && raw.length !== 1) {
    throw new Error('X-AI-Fleet-Project-ID must be a single UUID');
  }
  return validateProjectId(Array.isArray(raw) ? raw[0] : raw);
}

/**
 * One structured decision record per request. The sidecar is the only component
 * that sees every egress attempt, and "which organization could not get a
 * credential" is unanswerable from a prose error line — `cred_unavailable` and
 * `no_route` are fail-closed and open-relay-probing signals respectively, so
 * both need to be countable, not grep-able.
 *
 * Never in here: injected header values, the sentinel, resolved credentials,
 * request bodies (prompts carry customer secrets), or a full URL/query string —
 * some providers accept a key in the query, hence `upstreamHost` and a
 * sanitized first segment instead of `req.url`.
 */
const DECISION_SEVERITY = Object.freeze({
  forwarded: 'info',
  no_route: 'warn',
  bad_context: 'warn',
  cred_unavailable: 'error',
  redirect_rejected: 'error',
  upstream_error: 'error',
});

function statusClass(status) {
  if (!status) return 'none';
  return `${Math.floor(Number(status) / 100)}xx`;
}

/** The unmatched path is attacker-selected, so it may not be echoed verbatim. */
function probeSegment(url) {
  const first = String(url || '').replace(/^\/+/, '').split(/[/?#]/)[0] || '';
  return first.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32);
}

function upstreamHost(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return '';
  }
}

/**
 * Create the request handler. Dependencies are injectable for tests.
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] fetch implementation
 * @param {object}   [opts.oauthManager] { getClaudeAuth, getCodexAuth }
 * @param {object}   [opts.logger] { info, warn, error }
 */
function createProxyHandler(opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const oauthManager = opts.oauthManager || require('./oauth-manager');
  const log = opts.logger || require('@ai-fleet/shared-core/logger');
  const routeResolver = opts.routeResolver || credentials;
  // Pinned at boot: a misconfigured sidecar (PROXY_ORG_ID ≠ FLEET_ORG_ID) must not
  // turn the log path itself into a request failure.
  let proxyOrgId = '';
  try {
    proxyOrgId = (routeResolver.configuredProxyOrgId || credentials.configuredProxyOrgId)(opts.env || process.env) || '';
  } catch (_) {
    proxyOrgId = '';
  }

  return async function handle(req, res) {
    const startedAt = Date.now();
    let decided = false;
    const matched = matchRoute(req.url);
    const prefix = matched ? matched.route.prefix : `unmatched:${probeSegment(req.url)}`;
    const decide = (decision, extra = {}) => {
      if (decided) return;
      decided = true;
      const record = {
        prefix,
        upstreamHost: extra.upstreamHost || '',
        orgId: proxyOrgId,
        decision,
        statusClass: statusClass(extra.status),
        // Time to response headers, not stream completion: an agent turn streams
        // for minutes and must not read as a multi-minute gateway incident.
        latencyMs: Date.now() - startedAt,
        method: String(req.method || '').toUpperCase(),
      };
      if (extra.error) record.error = extra.error;
      log[DECISION_SEVERITY[decision]](`egress ${decision}`, record);
    };

    if (!matched) {
      // No known upstream → reject (no open relay / SSRF via a caller-chosen host).
      decide('no_route', { status: 404 });
      sendJson(res, 404, { error: 'no egress route for path' });
      return;
    }
    const { route, rest } = matched;

    let projectId;
    try {
      projectId = requestProjectId(req.headers);
    } catch (_) {
      decide('bad_context', { status: 400 });
      sendJson(res, 400, { error: 'invalid project egress context' });
      return;
    }

    let inject;
    let resolvedUpstream;
    try {
      const resolved = await routeResolver.resolveRoute(route, {
        fetchImpl,
        oauthManager,
        env: opts.env || process.env,
        projectId,
      });
      inject = resolved.headers;
      resolvedUpstream = resolved.upstream;
    } catch (err) {
      // Fail closed: a missing/unresolvable credential must not go out unauthenticated.
      decide('cred_unavailable', { status: err.status || 502, error: err.message });
      sendJson(res, err.status || 502, { error: 'egress credential unavailable' });
      return;
    }

    const upstreamUrl = buildUpstreamUrl(route, rest, resolvedUpstream);
    const headers = buildForwardHeaders(req.headers, upstreamUrl, inject);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

    try {
      const upstream = await fetchImpl(upstreamUrl, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? 'half' : undefined,
        redirect: 'manual',
      });
      // Never expose an upstream redirect to the caller. Returning Location
      // would let an SDK follow it outside this proxy and bypass credential
      // isolation. The proxy also must not follow it itself.
      if (upstream.status >= 300 && upstream.status < 400) {
        if (upstream.body && typeof upstream.body.cancel === 'function') {
          await upstream.body.cancel().catch(() => {});
        }
        decide('redirect_rejected', { status: 502, upstreamHost: upstreamHost(upstreamUrl) });
        res.writeHead(502);
        res.end();
        return;
      }
      decide('forwarded', { status: upstream.status, upstreamHost: upstreamHost(upstreamUrl) });
      res.writeHead(upstream.status, filterResponseHeaders(upstream.headers));
      if (upstream.body) {
        Readable.fromWeb(upstream.body).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      decide('upstream_error', { status: 502, upstreamHost: upstreamHost(upstreamUrl), error: err.message });
      if (!res.headersSent) sendJson(res, 502, { error: 'upstream unreachable' });
      else res.end();
    }
  };
}

module.exports = {
  buildUpstreamUrl,
  buildForwardHeaders,
  filterResponseHeaders,
  createProxyHandler,
  statusClass,
  probeSegment,
  DROP_REQUEST_HEADERS,
  DROP_RESPONSE_HEADERS,
  requestProjectId,
};
