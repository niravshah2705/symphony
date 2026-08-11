'use strict';

const { CONFIG } = require('../config');
const pkce = require('./pkce');

/**
 * Claude (Anthropic) OAuth 2.0 Authorization Code + PKCE (S256) helper —
 * "Sign in with Claude" via the public Claude Code client.
 *
 * oauth-oidc checklist:
 *   - PKCE S256 only (no `plain`).
 *   - `state` is cryptographically random, server-generated, single-use, short
 *     lived; the pending-login map is the server-side binding (an attacker
 *     cannot forge a state we never issued).
 *   - redirect_uri is trusted server-side config, reused exact-match in exchange.
 *   - authorization codes are single-use (provider-enforced; we also delete the
 *     pending login on first exchange).
 *   - refresh tokens rotate: a new refresh_token in the response replaces the old.
 * Provider endpoint URLs + client id come from CONFIG.CLAUDE, never user input.
 *
 * Flow shape: the redirect target is Anthropic's hosted "copy this code" page,
 * which returns the value as `code#state`. The operator pastes that back; we
 * split it, validate the state, and exchange.
 */

const { CLAUDE } = CONFIG;

/* --------------------- pending login (state) registry ------------------- */
// state -> { codeVerifier, expiresAt }. Single-use, short-lived.
const pendingLogins = new Map();

function prunePending(now = Date.now()) {
  for (const [state, entry] of pendingLogins) {
    if (entry.expiresAt <= now) pendingLogins.delete(state);
  }
}

/** Build the provider authorization URL (S256 PKCE + state). */
function buildAuthorizeUrl({ state, codeChallenge }) {
  const url = new URL(CLAUDE.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLAUDE.clientId);
  url.searchParams.set('redirect_uri', CLAUDE.redirectUri);
  url.searchParams.set('scope', CLAUDE.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Begin a login: generate state + PKCE, register them server-side, and return
 * the authorize URL to send the browser to.
 */
function createLogin() {
  prunePending();
  const state = pkce.generateState();
  const codeVerifier = pkce.generateVerifier();
  const codeChallenge = pkce.challengeFromVerifier(codeVerifier);
  pendingLogins.set(state, { codeVerifier, expiresAt: Date.now() + CLAUDE.loginTtlMs });
  return { state, authorizeUrl: buildAuthorizeUrl({ state, codeChallenge }) };
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

/**
 * Parse the operator-pasted value. Anthropic's callback returns `code#state`;
 * we also tolerate a bare code or a full callback URL with query params.
 */
function parseCodeInput(raw) {
  const input = String(raw || '').trim();
  if (!input) return { code: '', state: '' };
  // Full URL pasted: pull code/state from the query string.
  if (/^https?:\/\//i.test(input)) {
    try {
      const u = new URL(input);
      return { code: u.searchParams.get('code') || '', state: u.searchParams.get('state') || '' };
    } catch (_) {
      /* fall through to hash parsing */
    }
  }
  const [code, state = ''] = input.split('#');
  return { code: code.trim(), state: state.trim() };
}

/** Normalize a raw token endpoint response into our stored shape. */
function normalizeTokenResponse(json, previous = null) {
  const expiresIn = Number(json.expires_in);
  const now = Date.now();
  return {
    accessToken: json.access_token || '',
    // Rotation: keep the old refresh token only if the provider didn't issue one.
    refreshToken: json.refresh_token || (previous && previous.refreshToken) || '',
    tokenType: json.token_type || 'Bearer',
    scope: json.scope || (previous && previous.scope) || CLAUDE.scope,
    expiresAt: Number.isFinite(expiresIn) ? now + expiresIn * 1000 : now + 3600 * 1000,
    obtainedAt: now,
  };
}

async function postToken(payload) {
  const resp = await fetch(CLAUDE.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
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

/** Exchange an authorization code (bound to the issued verifier + state). */
async function exchangeCodeForTokens({ code, state, codeVerifier }) {
  const json = await postToken({
    grant_type: 'authorization_code',
    code,
    state,
    client_id: CLAUDE.clientId,
    redirect_uri: CLAUDE.redirectUri,
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
    client_id: CLAUDE.clientId,
  });
  return normalizeTokenResponse(json, previous);
}

/** True when a token set is missing or within the refresh-skew of expiry. */
function isExpired(tokens, now = Date.now()) {
  if (!tokens || !tokens.accessToken) return true;
  return tokens.expiresAt - CLAUDE.refreshSkewMs <= now;
}

module.exports = {
  buildAuthorizeUrl,
  createLogin,
  consumeLogin,
  pendingCount,
  parseCodeInput,
  normalizeTokenResponse,
  exchangeCodeForTokens,
  refreshTokens,
  isExpired,
};
