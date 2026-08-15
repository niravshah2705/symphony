'use strict';

const MAX_BODY_BYTES = 8 * 1024;

class RpcRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(value)
    || /^::ffff:127(?:\.\d{1,3}){3}$/.test(value);
}

async function readJsonBody(req) {
  const declaredLength = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RpcRequestError(413, 'request body too large');
  }

  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new RpcRequestError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (bytes === 0) throw new RpcRequestError(400, 'JSON body is required');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('body is not an object');
    }
    return value;
  } catch (_) {
    throw new RpcRequestError(400, 'invalid JSON body');
  }
}

function cleanContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcRequestError(400, 'context is required');
  }
  for (const key of ['organizationId', 'projectId']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') {
      throw new RpcRequestError(400, `context.${key} must be a string`);
    }
  }
  return {
    organizationId: String(value.organizationId || '').trim(),
    projectId: String(value.projectId || '').trim(),
  };
}

function cleanChannelId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcRequestError(400, 'channelId is required');
  }
  return value.trim();
}

function requestPath(req) {
  try {
    return new URL(req.url, 'http://127.0.0.1').pathname;
  } catch (_) {
    return '';
  }
}

/** Create the capability handler. It is safe to mount only under /internal/stream-token/. */
function createStreamTokenRpcHandler({ service, logger } = {}) {
  if (!service || typeof service.mint !== 'function' || typeof service.verify !== 'function') {
    throw new Error('A stream-token service is required');
  }
  const log = logger || require('@ai-fleet/shared-core/logger');

  return async function handleStreamTokenRpc(req, res) {
    const path = requestPath(req);
    if (path !== '/internal/stream-token/mint' && path !== '/internal/stream-token/verify') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
      sendJson(res, 403, { error: 'loopback access required' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const channelId = cleanChannelId(body.channelId);
      const context = cleanContext(body.context);
      if (path === '/internal/stream-token/mint') {
        sendJson(res, 200, service.mint(channelId, context));
        return;
      }
      if (typeof body.token !== 'string') {
        throw new RpcRequestError(400, 'token must be a string');
      }
      sendJson(res, 200, { valid: service.verify(body.token, channelId, context) });
    } catch (error) {
      if (error instanceof RpcRequestError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      log.error(`stream-token proxy operation failed: ${error && error.message ? error.message : error}`);
      sendJson(res, 500, { error: 'stream token operation failed' });
    }
  };
}

module.exports = {
  createStreamTokenRpcHandler,
  isLoopbackAddress,
  readJsonBody,
  MAX_BODY_BYTES,
};
