'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');
const oauth = require('@ai-fleet/shared-core/agent/oauth');
const {
  ensureFreshClaudeTokens,
  ensureFreshCodexTokens,
} = require('@ai-fleet/shared-core/agent/oauth-tokens');

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
  const tokens = await ensureFreshCodexTokens();
  return {
    accessToken: tokens.accessToken,
    accountId: oauth.accountIdFromIdToken(tokens.idToken),
  };
}

module.exports = { getClaudeAuth, getCodexAuth };
