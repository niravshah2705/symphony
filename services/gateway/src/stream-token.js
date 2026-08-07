'use strict';

const crypto = require('node:crypto');
const { CONFIG } = require('@ai-fleet/shared/config');
const { WORKSPACE_CHANNEL } = require('@ai-fleet/shared/messaging/events');

/**
 * Short-lived, HMAC-signed stream tokens.
 *
 * EventSource cannot send an Authorization header, so after the SPA authenticates
 * it fetches a stream token (bound to one conversationId, ~5 min TTL) and passes
 * it in the SSE URL. The token is signed server-side, so it cannot be forged and
 * expires quickly.
 *
 * Secret resolution FAILS CLOSED: when app auth is enabled (any real deployment)
 * STREAM_TOKEN_SECRET must be provided (from Secret Manager) or the module throws
 * at load, so a misconfigured revision refuses to start rather than signing with
 * a predictable value. When auth is disabled (local dev) a fresh per-process
 * random secret is used — never a shared hardcoded literal.
 */

const TTL_MS = 5 * 60 * 1000;

const ENV_SECRET = process.env.STREAM_TOKEN_SECRET || '';
if (CONFIG.AUTH && CONFIG.AUTH.enabled && !ENV_SECRET) {
  throw new Error('STREAM_TOKEN_SECRET is required when authentication is enabled');
}
const SECRET = ENV_SECRET || crypto.randomBytes(32).toString('base64url');

function secret() {
  return SECRET;
}

function sign(conversationId, exp) {
  return crypto.createHmac('sha256', secret()).update(`${conversationId}.${exp}`).digest('base64url');
}

function mintStreamToken(conversationId) {
  const exp = Date.now() + TTL_MS;
  return `${exp}.${sign(conversationId, exp)}`;
}

/**
 * Mint a token for the reserved GLOBAL workspace channel. Bound to the fixed
 * channel id (not a conversation), so the read-only home can stream workspace
 * status/jobs/coder/gate events without owning a conversation.
 */
function mintWorkspaceToken() {
  return mintStreamToken(WORKSPACE_CHANNEL);
}

function verifyStreamToken(token, conversationId) {
  if (!token || !conversationId) return false;
  const [expStr, sig] = String(token).split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const expected = sign(conversationId, exp);
  const provided = Buffer.from(sig);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length) return false;
  return crypto.timingSafeEqual(provided, wanted);
}

module.exports = { mintStreamToken, mintWorkspaceToken, verifyStreamToken, TTL_MS };
