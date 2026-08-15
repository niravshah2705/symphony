'use strict';

const { Readable } = require('stream');
const { matchRoute } = require('@ai-fleet/shared-core/egress');
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

  return async function handle(req, res) {
    const matched = matchRoute(req.url);
    if (!matched) {
      // No known upstream → reject (no open relay / SSRF via a caller-chosen host).
      sendJson(res, 404, { error: 'no egress route for path' });
      return;
    }
    const { route, rest } = matched;

    let projectId;
    try {
      projectId = requestProjectId(req.headers);
    } catch (_) {
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
      log.error(`egress credential unavailable for ${route.prefix}: ${err.message}`);
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
        log.error(`egress upstream redirect rejected for ${route.prefix}`);
        if (upstream.body && typeof upstream.body.cancel === 'function') {
          await upstream.body.cancel().catch(() => {});
        }
        res.writeHead(502);
        res.end();
        return;
      }
      res.writeHead(upstream.status, filterResponseHeaders(upstream.headers));
      if (upstream.body) {
        Readable.fromWeb(upstream.body).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      log.error(`egress upstream error for ${route.prefix}: ${err.message}`);
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
  DROP_REQUEST_HEADERS,
  DROP_RESPONSE_HEADERS,
  requestProjectId,
};
