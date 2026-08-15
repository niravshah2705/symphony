'use strict';

const crypto = require('node:crypto');

/** Proxy-owned HMAC signing for short-lived EventSource authorization tokens. */
const TTL_MS = 5 * 60 * 1000;

function contextKey(context = {}) {
  const organizationId = String(context.organizationId || '').trim();
  const projectId = String(context.projectId || '').trim();
  return `${organizationId}.${projectId}`;
}

function createStreamTokenService(options = {}) {
  const configured = options.secret === undefined ? process.env.STREAM_TOKEN_SECRET : options.secret;
  const secret = configured ? String(configured) : '';
  if (!secret) {
    throw new Error('STREAM_TOKEN_SECRET is required for the stream-token proxy capability');
  }
  const now = options.now || Date.now;

  function sign(channelId, expiresAt, context = {}) {
    return crypto.createHmac('sha256', secret)
      .update(`${channelId}.${expiresAt}.${contextKey(context)}`)
      .digest('base64url');
  }

  function mint(channelId, context = {}) {
    const expiresAt = now() + TTL_MS;
    return {
      token: `${expiresAt}.${sign(channelId, expiresAt, context)}`,
      expiresAt,
    };
  }

  function verify(token, channelId, context = {}) {
    if (!token || !channelId) return false;
    const [expiresAtString, signature] = String(token).split('.');
    const expiresAt = Number(expiresAtString);
    if (!Number.isFinite(expiresAt) || expiresAt < now() || !signature) return false;
    const expected = sign(channelId, expiresAt, context);
    const provided = Buffer.from(signature);
    const wanted = Buffer.from(expected);
    if (provided.length !== wanted.length) return false;
    return crypto.timingSafeEqual(provided, wanted);
  }

  return { mint, verify };
}

module.exports = { createStreamTokenService, TTL_MS };
