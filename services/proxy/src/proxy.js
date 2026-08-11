'use strict';

const { Readable } = require('stream');
const { matchRoute } = require('@ai-fleet/shared-core/egress');
const credentials = require('./credentials');

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
  'authorization', 'x-internal-token', 'x-forwarded-authorization', 'cookie',
]);

const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade',
  // Body was normalized by fetch (identity); let Node frame the piped stream.
  'content-length', 'content-encoding',
]);

/** Build the absolute upstream URL for a matched route + path remainder. */
function buildUpstreamUrl(route, rest) {
  const tail = !rest || rest === '/' ? '' : rest;
  return `${route.upstream}${tail}`;
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
  for (const [key, value] of Object.entries(incoming || {})) {
    if (DROP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
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

  return async function handle(req, res) {
    const matched = matchRoute(req.url);
    if (!matched) {
      // No known upstream → reject (no open relay / SSRF via a caller-chosen host).
      sendJson(res, 404, { error: 'no egress route for path' });
      return;
    }
    const { route, rest } = matched;

    let inject;
    try {
      inject = await credentials.buildInjection(route, { fetchImpl, oauthManager });
    } catch (err) {
      // Fail closed: a missing/unresolvable credential must not go out unauthenticated.
      log.error(`egress credential unavailable for ${route.prefix}: ${err.message}`);
      sendJson(res, err.status || 502, { error: 'egress credential unavailable' });
      return;
    }

    const upstreamUrl = buildUpstreamUrl(route, rest);
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
};
