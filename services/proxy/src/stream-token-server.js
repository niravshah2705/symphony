'use strict';

const http = require('node:http');
const { createStreamTokenService } = require('./stream-token');
const {
  createStreamTokenRpcHandler,
  ACCESS_MODE_CLOUD_RUN_IAM,
} = require('./stream-token-rpc');

/**
 * Dedicated stream-token broker entrypoint.
 *
 * Unlike the egress-proxy sidecar server, this process deliberately has no
 * provider routing surface. Cloud Run IAM authenticates the gateway before a
 * request reaches this listener; the RPC handler's explicit remote mode only
 * removes the sidecar-specific socket check.
 */

const DEFAULT_BROKER_BIND_HOST = '127.0.0.1';
const CLOUD_RUN_BIND_HOST = '0.0.0.0';
const DEFAULT_BROKER_PORT = 8080;
const MINT_PATH = '/internal/stream-token/mint';
const VERIFY_PATH = '/internal/stream-token/verify';

function writeLog(stream, level, message) {
  const timestamp = new Date().toISOString();
  const text = `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}`;
  stream.write(`${text}\n`);
  return text;
}

// The broker is intentionally independent from the main application's config.
// Cloud Run captures stdout/stderr, so it needs no filesystem-backed logger.
const brokerLogger = Object.freeze({
  info: (message) => writeLog(process.stdout, 'info', message),
  error: (message) => writeLog(process.stderr, 'error', message),
});

function requestPath(req) {
  try {
    return new URL(req.url, 'http://127.0.0.1').pathname;
  } catch (_) {
    return '';
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function resolveBindHost(value = process.env.STREAM_TOKEN_BIND_HOST) {
  const host = String(value || '').trim() || DEFAULT_BROKER_BIND_HOST;
  if (host !== DEFAULT_BROKER_BIND_HOST && host !== CLOUD_RUN_BIND_HOST) {
    throw new Error('STREAM_TOKEN_BIND_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  return host;
}

function createStreamTokenServer(options = {}) {
  const logger = options.logger || brokerLogger;
  const service = options.streamTokenService || createStreamTokenService();
  const rpcHandler = options.rpcHandler || createStreamTokenRpcHandler({
    service,
    logger,
    accessMode: ACCESS_MODE_CLOUD_RUN_IAM,
  });

  return http.createServer((req, res) => {
    const path = requestPath(req);
    if ((path === '/healthz' || path === '/health')
        && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (path !== MINT_PATH && path !== VERIFY_PATH) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    Promise.resolve(rpcHandler(req, res)).catch((error) => {
      logger.error(`stream-token broker handler error: ${error && error.message ? error.message : error}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'stream token operation failed' });
      else res.end();
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_BROKER_PORT;
  const bindHost = resolveBindHost();
  const server = createStreamTokenServer();
  server.listen(port, bindHost, () => {
    brokerLogger.info(`AI Fleet stream-token broker listening on http://${bindHost}:${port}`);
  });
}

module.exports = {
  createStreamTokenServer,
  resolveBindHost,
  DEFAULT_BROKER_BIND_HOST,
  CLOUD_RUN_BIND_HOST,
  DEFAULT_BROKER_PORT,
  MINT_PATH,
  VERIFY_PATH,
};
