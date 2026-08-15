'use strict';

const http = require('http');
const log = require('@ai-fleet/shared-core/logger');
const { createProxyHandler } = require('./proxy');
const { createStreamTokenService } = require('./stream-token');
const { createStreamTokenRpcHandler } = require('./stream-token-rpc');

/**
 * AI Fleet egress proxy sidecar. Provider egress remains the default behavior;
 * narrowly-scoped internal capabilities are opt-in through PROXY_CAPABILITIES.
 */

const PORT = Number(process.env.PROXY_PORT) || 4030;
const DEFAULT_PROXY_BIND_HOST = '127.0.0.1';
const CLOUD_RUN_BIND_HOST = '0.0.0.0';

function resolveBindHost(value = process.env.PROXY_BIND_HOST) {
  const host = String(value || '').trim() || DEFAULT_PROXY_BIND_HOST;
  if (host !== DEFAULT_PROXY_BIND_HOST && host !== CLOUD_RUN_BIND_HOST) {
    throw new Error('PROXY_BIND_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  return host;
}

// Resolve before the server is constructed or listen is attempted so a typo
// cannot silently expose the credential-bearing relay on an arbitrary address.
const PROXY_BIND_HOST = resolveBindHost();

function parseCapabilities(value = process.env.PROXY_CAPABILITIES) {
  return new Set(String(value || '')
    .split(',')
    .map((capability) => capability.trim().toLowerCase())
    .filter(Boolean));
}

function pathname(req) {
  try {
    return new URL(req.url, 'http://127.0.0.1').pathname;
  } catch (_) {
    return '';
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function createServer(options = {}) {
  const logger = options.logger || log;
  const proxyHandler = options.proxyHandler || createProxyHandler();
  const capabilities = options.capabilities instanceof Set
    ? options.capabilities
    : parseCapabilities(options.capabilities);
  let streamTokenHandler = options.streamTokenHandler;

  if (capabilities.has('stream-token') && !streamTokenHandler) {
    const service = options.streamTokenService || createStreamTokenService();
    streamTokenHandler = createStreamTokenRpcHandler({ service, logger });
  }

  const server = http.createServer((req, res) => {
    const path = pathname(req);
    if (path === '/healthz' || path === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (path.startsWith('/internal/stream-token/')) {
      if (!capabilities.has('stream-token')) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      Promise.resolve(streamTokenHandler(req, res)).catch((error) => {
        logger.error(`stream-token proxy handler error: ${error && error.message ? error.message : error}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'stream token operation failed' });
        else res.end();
      });
      return;
    }
    Promise.resolve(proxyHandler(req, res)).catch((error) => {
      logger.error(`egress proxy handler error: ${error && error.message ? error.message : error}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'proxy error' });
      else res.end();
    });
  });

  // Long-lived streaming responses (LLM SSE, git packfiles) must not be cut off.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  return server;
}

const server = createServer();

if (require.main === module) {
  // Local development stays loopback-only. Cloud Run explicitly opts into the
  // wildcard bind required by its sidecar startup probe; the application still
  // reaches this container only through the instance's shared loopback.
  server.listen(PORT, PROXY_BIND_HOST, () => {
    log.info(`AI Fleet egress proxy sidecar listening on http://${PROXY_BIND_HOST}:${PORT}`);
  });
}

module.exports = server;
module.exports.createServer = createServer;
module.exports.parseCapabilities = parseCapabilities;
module.exports.resolveBindHost = resolveBindHost;
module.exports.PROXY_BIND_HOST = PROXY_BIND_HOST;
module.exports.DEFAULT_PROXY_BIND_HOST = DEFAULT_PROXY_BIND_HOST;
module.exports.CLOUD_RUN_BIND_HOST = CLOUD_RUN_BIND_HOST;
