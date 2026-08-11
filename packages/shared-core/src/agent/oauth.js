'use strict';

const { CONFIG } = require('../config');
const pkce = require('./pkce');

/**
 * OAuth 2.0 Authorization Code + PKCE (S256) helper for the Codex (OpenAI)
 * provider. Follows the oauth-oidc checklist:
 *   - PKCE with S256 only (no `plain`).
 *   - `state` is cryptographically random, server-generated, single-use, and
 *     short-lived (the pending-login map is the server-side binding for this
 *     single-user local tool — an attacker cannot forge a state we never issued).
 *   - redirect_uri is server-derived (never from the request) and reused
 *     exact-match in the code exchange.
 *   - authorization codes are single-use (the provider enforces this; we also
 *     delete the pending login on first callback).
 *   - refresh tokens are rotated: a new refresh_token in the response replaces
 *     the old one.
 * Provider endpoint URLs and client id come from trusted server-side config
 * (CONFIG.OAUTH), never from user input.
 */

const { OAUTH } = CONFIG;

// PKCE primitives are shared across providers (see ./pkce). Re-exported below.
const { base64url, generateVerifier, challengeFromVerifier, generateState } = pkce;

/* --------------------- pending login (state) registry ------------------- */
// state -> { codeVerifier, redirectUri, expiresAt }. Single-use, short-lived.
const pendingLogins = new Map();

function prunePending(now = Date.now()) {
  for (const [state, entry] of pendingLogins) {
    if (entry.expiresAt <= now) pendingLogins.delete(state);
  }
}

/**
 * Begin a login: generate state + PKCE, register them server-side, and return
 * the authorize URL to send the browser to.
 */
function createLogin() {
  prunePending();
  const state = generateState();
  const codeVerifier = generateVerifier();
  const codeChallenge = challengeFromVerifier(codeVerifier);
  const redirectUri = OAUTH.redirectUri;
  pendingLogins.set(state, { codeVerifier, redirectUri, expiresAt: Date.now() + OAUTH.loginTtlMs });
  return { state, authorizeUrl: buildAuthorizeUrl({ state, codeChallenge, redirectUri }) };
}

/** Validate and consume a state (single-use). Returns the login entry or null. */
function consumeLogin(state) {
  prunePending();
  if (!state || typeof state !== 'string') return null;
  const entry = pendingLogins.get(state);
  if (!entry) return null;
  pendingLogins.delete(state); // single-use
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}

/** Test seam: current number of pending logins. */
function pendingCount() {
  prunePending();
  return pendingLogins.size;
}

/** Build the provider authorization URL (S256 PKCE + state). */
function buildAuthorizeUrl({ state, codeChallenge, redirectUri }) {
  const url = new URL(OAUTH.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OAUTH.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', OAUTH.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Normalize a raw token endpoint response into our stored shape. */
function normalizeTokenResponse(json, previous = null) {
  const expiresIn = Number(json.expires_in);
  const now = Date.now();
  return {
    accessToken: json.access_token || '',
    // Rotation: keep the old refresh token only if the provider didn't issue one.
    refreshToken: json.refresh_token || (previous && previous.refreshToken) || '',
    idToken: json.id_token || (previous && previous.idToken) || '',
    tokenType: json.token_type || 'Bearer',
    scope: json.scope || (previous && previous.scope) || OAUTH.scope,
    expiresAt: Number.isFinite(expiresIn) ? now + expiresIn * 1000 : now + 3600 * 1000,
    obtainedAt: now,
  };
}

async function postToken(params) {
  const resp = await fetch(OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = {};
  }
  if (!resp.ok) {
    const detail = json.error_description || json.error || text.slice(0, 200) || `HTTP ${resp.status}`;
    const err = new Error(`Token endpoint error: ${detail}`);
    err.status = 502;
    throw err;
  }
  return json;
}

/** Exchange an authorization code (bound to the same redirect_uri + verifier). */
async function exchangeCodeForTokens({ code, codeVerifier, redirectUri }) {
  const json = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: OAUTH.clientId,
    code_verifier: codeVerifier,
  });
  return normalizeTokenResponse(json);
}

/** Refresh an access token; rotates the refresh token when a new one is issued. */
async function refreshTokens(previous) {
  if (!previous || !previous.refreshToken) {
    const err = new Error('No refresh token available; sign in again.');
    err.status = 401;
    throw err;
  }
  const json = await postToken({
    grant_type: 'refresh_token',
    refresh_token: previous.refreshToken,
    client_id: OAUTH.clientId,
    scope: OAUTH.scope,
  });
  return normalizeTokenResponse(json, previous);
}

/** True when a token set is missing or within the refresh-skew of expiry. */
function isExpired(tokens, now = Date.now()) {
  if (!tokens || !tokens.accessToken) return true;
  return tokens.expiresAt - OAUTH.refreshSkewMs <= now;
}

/**
 * Extract the ChatGPT account id from the OIDC id_token. The ChatGPT-plan Codex
 * backend requires this as a `chatgpt-account-id` header. The claim lives under
 * the `https://api.openai.com/auth` namespaced claim. Returns '' when absent or
 * the token is not a decodable JWT (never throws — the caller decides).
 */
function accountIdFromIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return '';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const auth = payload['https://api.openai.com/auth'] || {};
    return auth.chatgpt_account_id || '';
  } catch (_) {
    return '';
  }
}

module.exports = {
  base64url,
  generateVerifier,
  challengeFromVerifier,
  generateState,
  createLogin,
  consumeLogin,
  pendingCount,
  buildAuthorizeUrl,
  normalizeTokenResponse,
  exchangeCodeForTokens,
  refreshTokens,
  isExpired,
  accountIdFromIdToken,
};
