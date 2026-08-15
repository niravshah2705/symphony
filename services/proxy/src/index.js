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
const PROXY_BIND_HOST = '127.0.0.1';

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
  // Both capability surfaces are sidecar-only. Binding the wildcard interface
  // would make the egress relay reachable from the container network even
  // though its intended client is co-located over shared loopback.
  server.listen(PORT, PROXY_BIND_HOST, () => {
    log.info(`AI Fleet egress proxy sidecar listening on http://127.0.0.1:${PORT}`);
  });
}

module.exports = server;
module.exports.createServer = createServer;
module.exports.parseCapabilities = parseCapabilities;
module.exports.PROXY_BIND_HOST = PROXY_BIND_HOST;
