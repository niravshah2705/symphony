'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');
const oauth = require('@ai-fleet/shared-core/agent/oauth');
const {
  ensureFreshClaudeTokens,
  ensureFreshCodexTokens,
} = require('@ai-fleet/shared-core/agent/oauth-tokens');
const { fetchOrgSecrets, rotateOrgCodexTokens } = require('./secrets-client');
const { configuredProxyOrgId, FailClosed } = require('./credentials');

/**
 * OAuth credential resolution for the egress proxy. The proxy OWNS the refresh
 * loop for Claude/Codex: it reads the (per-namespace) store token sets, refreshes
 * on near-expiry, and persists rotation — reusing the shared oauth-tokens helpers
 * so the refresh-race coalescing is identical to the legacy in-agent path. The
 * agent container never holds these tokens; only the sidecar does.
 */

async function getClaudeAuth() {
  const tokens = await ensureFreshClaudeTokens();
  return { accessToken: tokens.accessToken, betaHeader: CONFIG.CLAUDE.betaHeader };
}

async function getCodexAuth() {
  const tokens = await ensureFreshOrgCodexTokens();
  return {
    accessToken: tokens.accessToken,
    accountId: oauth.accountIdFromIdToken(tokens.idToken),
  };
}

const inflight = new Map();

function parseBundle(entry) {
  if (!entry || !entry.value) return null;
  try {
    const bundle = JSON.parse(entry.value);
    if (!bundle || typeof bundle !== 'object') return null;
    return bundle;
  } catch (_) {
    return null;
  }
}

async function ensureFreshOrgCodexTokens(options = {}) {
  const orgId = String(
    options.orgId || configuredProxyOrgId(options.env || process.env) || ''
  ).trim();
  if (!orgId) return ensureFreshCodexTokens();
  const resolved = await fetchOrgSecrets(orgId, options);
  const entry = resolved && resolved.secrets && resolved.secrets.codexTokenBundle;
  const tokens = parseBundle(entry);
  // Preserve the migration path only while the organization still selects the
  // managed/legacy source. An explicitly selected customer credential that is
  // missing or malformed must fail closed: falling back here would silently
  // resurrect a deleted or stale account from the namespaced store.
  if (!tokens) {
    if (!entry || (entry.source === 'managed' && !entry.value)) {
      return ensureFreshCodexTokens();
    }
    throw new FailClosed('organization Codex token bundle is missing or invalid');
  }
  if (!oauth.isExpired(tokens)) return tokens;

  if (inflight.has(orgId)) return inflight.get(orgId);
  const promise = (async () => {
    const refreshed = await oauth.refreshTokens(tokens);
    const result = await rotateOrgCodexTokens(
      orgId,
      tokens.obtainedAt,
      refreshed,
      options
    );
    return result.tokens;
  })().finally(() => inflight.delete(orgId));
  inflight.set(orgId, promise);
  return promise;
}

module.exports = {
  getClaudeAuth,
  getCodexAuth,
  ensureFreshOrgCodexTokens,
  _test: { parseBundle, inflight },
};
