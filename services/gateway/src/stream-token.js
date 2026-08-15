'use strict';

const { WORKSPACE_CHANNEL } = require('@ai-fleet/shared-core/messaging/events');

/**
 * Gateway client for the proxy sidecar's loopback-only stream-token capability.
 * The gateway deliberately contains no signing secret or HMAC implementation.
 */

const STREAM_TOKEN_TIMEOUT_MS = 2_000;

class StreamTokenUnavailableError extends Error {
  constructor(message = 'Stream token service is unavailable.', options = {}) {
    super(message, options);
    this.name = 'StreamTokenUnavailableError';
    this.code = 'stream_token_unavailable';
  }
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function normalizeProxyBase(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('STREAM_TOKEN_PROXY_URL is required');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('STREAM_TOKEN_PROXY_URL must be a valid loopback HTTP URL');
  }
  if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('STREAM_TOKEN_PROXY_URL must be a loopback HTTP origin');
  }
  return parsed.origin;
}

function normalizeContext(context = {}) {
  return {
    organizationId: String(context.organizationId || '').trim(),
    projectId: String(context.projectId || '').trim(),
  };
}

function unavailable(cause) {
  if (cause instanceof StreamTokenUnavailableError) return cause;
  return new StreamTokenUnavailableError(undefined, { cause });
}

function validMintResponse(data) {
  if (!data || typeof data !== 'object' || typeof data.token !== 'string'
      || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= Date.now()) return false;
  const token = data.token.trim();
  const match = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(token);
  return Boolean(match) && match[1] === String(data.expiresAt);
}

function createStreamTokenClient(options = {}) {
  const baseUrl = normalizeProxyBase(options.baseUrl);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs === undefined ? STREAM_TOKEN_TIMEOUT_MS : options.timeoutMs;
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');

  async function post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response || !response.ok) throw unavailable();

      let data;
      try {
        const text = await response.text();
        data = text ? JSON.parse(text) : null;
      } catch (cause) {
        throw unavailable(cause);
      }
      return data;
    } catch (cause) {
      throw unavailable(cause);
    } finally {
      clearTimeout(timer);
    }
  }

  async function mintStreamToken(channelId, context = {}) {
    const data = await post('/internal/stream-token/mint', {
      channelId: String(channelId || '').trim(),
      context: normalizeContext(context),
    });
    if (!validMintResponse(data)) throw unavailable();
    return data.token.trim();
  }

  async function mintWorkspaceToken(context = {}) {
    return mintStreamToken(WORKSPACE_CHANNEL, context);
  }

  async function verifyStreamToken(token, channelId, context = {}) {
    const data = await post('/internal/stream-token/verify', {
      token: String(token || '').trim(),
      channelId: String(channelId || '').trim(),
      context: normalizeContext(context),
    });
    if (!data || typeof data !== 'object' || typeof data.valid !== 'boolean') {
      throw unavailable();
    }
    return data.valid;
  }

  return { mintStreamToken, mintWorkspaceToken, verifyStreamToken };
}

const defaultClient = createStreamTokenClient({
  baseUrl: process.env.STREAM_TOKEN_PROXY_URL,
});

module.exports = {
  ...defaultClient,
  createStreamTokenClient,
  StreamTokenUnavailableError,
  STREAM_TOKEN_TIMEOUT_MS,
  normalizeProxyBase,
};
