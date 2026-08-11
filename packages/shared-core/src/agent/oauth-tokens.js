'use strict';

const store = require('../store');
const oauth = require('./oauth');
const claudeOauth = require('./claude-oauth');

/**
 * Fresh-token orchestration for the OAuth providers (Codex / Claude), extracted
 * from llm.js so BOTH the legacy in-agent path AND the egress proxy sidecar use
 * the same refresh logic (DRY). Reads/writes the (per-namespace) store token
 * sets and refreshes via the provider OAuth helpers.
 *
 * Refresh-race safety: concurrent callers that all observe an expired token must
 * NOT each fire a refresh (which would rotate the refresh token N times and
 * invalidate all but one). A single in-flight refresh promise per provider
 * coalesces them; late callers re-check the (possibly just-refreshed) store.
 */

const inflight = new Map();

function coalesce(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = (async () => fn())().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/**
 * Return a valid Codex token set, refreshing (and persisting rotation) when the
 * access token is missing or near expiry. Throws (401) when no usable token
 * exists so the caller can prompt the operator to sign in again.
 */
async function ensureFreshCodexTokens() {
  const tokens = store.getCodexTokens();
  if (!tokens || (!tokens.accessToken && !tokens.refreshToken)) {
    const err = new Error('Sign in with Codex (OpenAI) in Settings → LLM.');
    err.status = 401;
    throw err;
  }
  if (!oauth.isExpired(tokens)) return tokens;
  return coalesce('codex', async () => {
    const current = store.getCodexTokens() || tokens;
    if (!oauth.isExpired(current)) return current; // another caller just refreshed
    const refreshed = await oauth.refreshTokens(current);
    store.setCodexTokens(refreshed);
    return refreshed;
  });
}

/**
 * Return a valid Claude token set, refreshing (and persisting rotation) when the
 * access token is missing or near expiry. Throws (401) when no usable token
 * exists so the caller can prompt the operator to sign in again.
 */
async function ensureFreshClaudeTokens() {
  const tokens = store.getClaudeTokens();
  if (!tokens || (!tokens.accessToken && !tokens.refreshToken)) {
    const err = new Error('Sign in with Claude in Settings → LLM.');
    err.status = 401;
    throw err;
  }
  if (!claudeOauth.isExpired(tokens)) return tokens;
  return coalesce('claude', async () => {
    const current = store.getClaudeTokens() || tokens;
    if (!claudeOauth.isExpired(current)) return current;
    const refreshed = await claudeOauth.refreshTokens(current);
    store.setClaudeTokens(refreshed);
    return refreshed;
  });
}

module.exports = { ensureFreshCodexTokens, ensureFreshClaudeTokens };
