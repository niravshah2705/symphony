'use strict';

const { WORKSPACE_CHANNEL } = require('@ai-fleet/shared-core/messaging/events');
const { idTokenHeader } = require('./service-client');

/**
 * Gateway client for the isolated stream-token capability. Production calls an
 * IAM-gated Cloud Run broker over HTTPS; local/rollback deployments may retain
 * the loopback-only sidecar. The gateway deliberately contains no signing
 * secret or HMAC implementation.
 */

const STREAM_TOKEN_TIMEOUT_MS = 2_000;
const STREAM_TOKEN_TTL_MS = 5 * 60 * 1000;
const STREAM_TOKEN_CLOCK_SKEW_MS = 60 * 1000;
const STREAM_TOKEN_MAX_FUTURE_MS = STREAM_TOKEN_TTL_MS + STREAM_TOKEN_CLOCK_SKEW_MS;

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

function normalizeServiceBase(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('STREAM_TOKEN_SERVICE_URL or STREAM_TOKEN_PROXY_URL is required');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('Stream-token service URL must be a valid HTTPS or loopback HTTP URL');
  }
  const loopbackHttp = parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !loopbackHttp)
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('Stream-token service URL must be an HTTPS or loopback HTTP origin');
  }
  return parsed.origin;
}

// Backward-compatible export name for callers/tests from the sidecar-only phase.
const normalizeProxyBase = normalizeServiceBase;

function configuredServiceUrl(env = process.env) {
  return String(env.STREAM_TOKEN_SERVICE_URL || '').trim()
    || String(env.STREAM_TOKEN_PROXY_URL || '').trim();
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

function validMintResponse(data, currentTime = Date.now()) {
  if (!data || typeof data !== 'object' || typeof data.token !== 'string'
      || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= currentTime
      || data.expiresAt > currentTime + STREAM_TOKEN_MAX_FUTURE_MS) return false;
  const token = data.token.trim();
  const match = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(token);
  return Boolean(match) && match[1] === String(data.expiresAt);
}

function createStreamTokenClient(options = {}) {
  const baseUrl = normalizeServiceBase(options.baseUrl);
  const parsedBase = new URL(baseUrl);
  const remote = !isLoopbackHostname(parsedBase.hostname);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const identityHeader = options.identityHeader || idTokenHeader;
  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs === undefined ? STREAM_TOKEN_TIMEOUT_MS : options.timeoutMs;
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  if (typeof identityHeader !== 'function') throw new Error('An identity-header provider is required');
  if (typeof now !== 'function') throw new Error('A clock implementation is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');

  async function post(path, body) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(unavailable(new Error('stream-token service request timed out')));
      }, timeoutMs);
    });

    const operation = async () => {
      const headers = { 'content-type': 'application/json' };
      if (remote) {
        const authorization = String(await identityHeader(baseUrl) || '').trim();
        if (!authorization) throw unavailable(new Error('stream-token service identity is unavailable'));
        headers.authorization = authorization;
      }
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
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
    };

    try {
      return await Promise.race([operation(), deadline]);
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
    if (!validMintResponse(data, now())) throw unavailable();
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
  baseUrl: configuredServiceUrl(),
});

module.exports = {
  ...defaultClient,
  createStreamTokenClient,
  StreamTokenUnavailableError,
  STREAM_TOKEN_TIMEOUT_MS,
  STREAM_TOKEN_TTL_MS,
  STREAM_TOKEN_CLOCK_SKEW_MS,
  STREAM_TOKEN_MAX_FUTURE_MS,
  normalizeProxyBase,
  normalizeServiceBase,
  configuredServiceUrl,
  validMintResponse,
};
