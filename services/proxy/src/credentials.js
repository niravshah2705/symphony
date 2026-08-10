'use strict';

const { fetchOrgSecrets, fetchManagedSecrets } = require('./secrets-client');

/**
 * Resolve the credential to inject for a given egress route.
 *
 * Two credential families:
 *   - Static keys (Linear/GitHub/Gemini/HF/LangSmith) — resolved through the
 *     settings service via ONE path (managed and customer alike). PROXY_ORG_ID
 *     set => the per-org resolve (managed + customer merged); unset (shared stack)
 *     => the no-org managed resolve. The settings service supplies the value for
 *     BOTH sources, so a customer key ("customer" selection) and a platform key
 *     ("managed") are resolved the same way. Customer selected but missing =>
 *     FAIL CLOSED. A mounted platform env is used only as a last-resort fallback
 *     when the settings resolve is unavailable (resilience), never as the primary.
 *   - OAuth (Claude/Codex) — resolved by the oauth-manager (store token sets +
 *     refresh), independent of the vault.
 */

// Platform-managed keys mounted on the sidecar (mirror store.js SECRET_ENV names).
const MANAGED_ENV = Object.freeze({
  linearApiKey: 'LINEAR_API_KEY',
  githubToken: 'GITHUB_TOKEN',
  geminiApiKey: 'GEMINI_API_KEY',
  huggingfaceApiKey: 'HUGGINGFACE_API_KEY',
  langsmithApiKey: 'LANGSMITH_API_KEY',
});

const ORG_ID = String(process.env.PROXY_ORG_ID || '').trim();
const CACHE_TTL_MS = Number(process.env.PROXY_SECRETS_TTL_MS) || 60000;

class FailClosed extends Error {
  constructor(message) {
    super(message);
    this.name = 'FailClosed';
    this.status = 502;
  }
}

let cache = { at: 0, data: null };

/**
 * Fetch (and briefly cache) the resolved secrets from the settings S2S. Uses the
 * per-org resolve when PROXY_ORG_ID is set (per-tenant stack), else the no-org
 * managed resolve (shared stack). Returns null on transport failure so the
 * caller can apply the platform-env fallback.
 */
async function resolveSecrets({ fetchImpl, now = Date.now() } = {}) {
  if (cache.data && now - cache.at < CACHE_TTL_MS) return cache.data;
  const data = ORG_ID
    ? await fetchOrgSecrets(ORG_ID, { fetchImpl })
    : await fetchManagedSecrets({ fetchImpl });
  cache = { at: now, data };
  return data;
}

function clearCache() {
  cache = { at: 0, data: null };
}

function managedValue(secretKey, env = process.env) {
  const name = MANAGED_ENV[secretKey];
  return name ? String(env[name] || '') : '';
}

/**
 * Resolve a static key's plaintext from the settings-resolve payload. Both
 * managed and customer entries carry a value, so ONE code path serves them.
 * FAIL CLOSED when "customer" is selected but has no value. When the settings
 * resolve is unavailable (no payload), fall back to the platform env (resilience).
 */
function resolveStaticKey(secretKey, resolved, env = process.env) {
  const entry = resolved && resolved.secrets && resolved.secrets[secretKey];
  if (entry) {
    if (entry.source === 'customer' && !entry.value) {
      throw new FailClosed(`customer key "${secretKey}" is selected but not set`);
    }
    if (entry.value) return entry.value;
    // managed with no value at the settings side → try the local env fallback.
    return managedValue(secretKey, env);
  }
  // No settings payload at all (resolve failed) → last-resort platform env.
  return managedValue(secretKey, env);
}

/**
 * Build the header patch to inject for a route. Never mutates the request; the
 * caller applies these over the forwarded headers (after stripping inbound auth).
 */
async function buildInjection(route, opts = {}) {
  const { fetchImpl, oauthManager } = opts;
  const headers = {};

  switch (route.auth) {
    case 'claude': {
      const { accessToken, betaHeader } = await oauthManager.getClaudeAuth();
      headers.authorization = `Bearer ${accessToken}`;
      if (betaHeader) headers['anthropic-beta'] = betaHeader;
      return headers;
    }
    case 'codex-chatgpt': {
      const { accessToken, accountId } = await oauthManager.getCodexAuth();
      headers.authorization = `Bearer ${accessToken}`;
      if (accountId) headers['chatgpt-account-id'] = accountId;
      return headers;
    }
    case 'codex-api': {
      const { accessToken } = await oauthManager.getCodexAuth();
      headers.authorization = `Bearer ${accessToken}`;
      return headers;
    }
    case 'git': {
      const resolved =
        opts.resolved !== undefined ? opts.resolved : await resolveSecrets({ fetchImpl });
      const pat = resolveStaticKey(route.secretKey, resolved);
      if (pat) {
        const basic = Buffer.from(`x-access-token:${pat}`).toString('base64');
        headers.authorization = `Basic ${basic}`;
      }
      return headers;
    }
    case 'apiKey':
    default: {
      const resolved =
        opts.resolved !== undefined ? opts.resolved : await resolveSecrets({ fetchImpl });
      const key = resolveStaticKey(route.secretKey, resolved);
      if (!key) return headers; // forward unauthenticated → upstream rejects
      if (route.scheme === 'raw') headers.authorization = key;
      else if (route.scheme === 'x-api-key') headers['x-api-key'] = key;
      else if (route.scheme === 'x-goog-api-key') headers['x-goog-api-key'] = key;
      else headers.authorization = `Bearer ${key}`;
      return headers;
    }
  }
}

module.exports = {
  MANAGED_ENV,
  FailClosed,
  resolveSecrets,
  clearCache,
  managedValue,
  resolveStaticKey,
  buildInjection,
};
