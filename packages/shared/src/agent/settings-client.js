'use strict';

/**
 * Client for the settings-policy service (services/settings), used server-side
 * by the gateway/planner to resolve the caller's EFFECTIVE settings before an
 * agent is built:
 *   - the include/exclude policy (harness/tools/skills/plugins) for ENFORCEMENT
 *   - the effective provider config values (e.g. geminiApiKey) for the harness
 *
 * Two settings-service surfaces are consulted:
 *   GET /api/v1/settings/effective          — masked; carries the policy domains
 *   GET /api/v1/internal/effective-config    — UNMASKED config values (S2S only)
 *
 * The internal endpoint returns provider SECRETS in plaintext, so it is only
 * ever reachable server-side (the gateway refuses to proxy `/internal/` to the
 * browser, and the service is IAM-gated). Scope is derived by the service from
 * the forwarded end-user token — never from a caller-supplied org id.
 *
 * Fail-open: any error resolves to an empty result (no policy, no key) so the
 * caller defaults to allow-all + the GEMINI_API_KEY env/store fallback. Secrets
 * are NEVER logged.
 */

const EMPTY = Object.freeze({ effectivePolicy: null, values: {}, geminiApiKey: '' });

/** Build the settings-service auth headers, mirroring the gateway proxy. */
function authHeaders({ userToken, s2sToken }) {
  const headers = {};
  const user = userToken ? `Bearer ${String(userToken).replace(/^Bearer\s+/i, '')}` : '';
  const s2s = s2sToken ? `Bearer ${String(s2sToken).replace(/^Bearer\s+/i, '')}` : '';
  if (s2s && user) {
    // Cloud: gateway S2S OIDC token satisfies IAM; the end-user token rides in
    // X-Forwarded-Authorization (the service reads it to resolve the principal).
    headers.authorization = s2s;
    headers['x-forwarded-authorization'] = user;
  } else if (user) {
    headers.authorization = user;
  } else if (s2s) {
    headers.authorization = s2s;
  }
  return headers;
}

function projectQuery(projectId) {
  const id = projectId ? String(projectId).trim() : '';
  return id ? `?project_id=${encodeURIComponent(id)}` : '';
}

async function getJson(fetchImpl, url, headers) {
  const resp = await fetchImpl(url, { method: 'GET', headers });
  if (!resp || !resp.ok) {
    const status = resp && resp.status ? resp.status : 'network-error';
    throw new Error(`settings-service ${url} → ${status}`);
  }
  return resp.json();
}

/**
 * Resolve the caller's effective policy + config values from the settings
 * service. Returns `{ effectivePolicy, values, geminiApiKey }`; on any failure
 * returns the empty (allow-all / no-key) result rather than throwing.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl        settings service origin (no trailing slash)
 * @param {string} [opts.userToken]    end-user bearer (Firebase / local JWT)
 * @param {string} [opts.s2sToken]     Cloud Run S2S OIDC token (pubsub mode)
 * @param {string} [opts.projectId]    optional project scope
 * @param {Function} [opts.fetchImpl]  fetch implementation (defaults to global)
 * @param {Function} [opts.logger]     optional logger with .warn/.error
 */
async function resolveEffectiveSettings(opts = {}) {
  const { baseUrl, userToken, s2sToken, projectId } = opts;
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!baseUrl || !fetchImpl) return { ...EMPTY };

  const headers = authHeaders({ userToken, s2sToken });
  const base = String(baseUrl).replace(/\/$/, '');
  const q = projectQuery(projectId);
  const result = { effectivePolicy: null, values: {}, geminiApiKey: '' };

  try {
    const effective = await getJson(fetchImpl, `${base}/api/v1/settings/effective${q}`, headers);
    if (effective && effective.domains) result.effectivePolicy = effective.domains;
  } catch (err) {
    if (opts.logger && opts.logger.warn) opts.logger.warn(`settings policy resolve failed: ${err.message}`);
  }

  try {
    const config = await getJson(fetchImpl, `${base}/api/v1/internal/effective-config${q}`, headers);
    if (config && config.values && typeof config.values === 'object') {
      result.values = config.values;
      result.geminiApiKey = String(config.values.geminiApiKey || '');
    }
  } catch (err) {
    // Never log the secret; only the failure.
    if (opts.logger && opts.logger.warn) opts.logger.warn(`settings config resolve failed: ${err.message}`);
  }

  return result;
}

/**
 * Resolve an ORG's effective policy (org → project cascade, NO user scope) from
 * the settings service's token-gated S2S endpoint, for the autonomous
 * planner/coder which act for an org and carry no end-user token. Pure/testable:
 * the caller supplies the base URL, org id, internal token, and (in Cloud) a
 * pre-minted OIDC bearer.
 *
 * Fail-open: any missing input or transport/HTTP error resolves to
 * `{ effectivePolicy: null }` (allow-all — no regression), never throws.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl        settings service origin (no trailing slash)
 * @param {string} opts.orgId          the org whose policy to resolve (route scope)
 * @param {string} opts.internalToken  shared X-Internal-Token (fail closed if unset)
 * @param {string} [opts.authBearer]   Cloud Run OIDC bearer ("Bearer …") for IAM
 * @param {string} [opts.projectId]    optional project overlay
 * @param {Function} [opts.fetchImpl]  fetch implementation (defaults to global)
 * @param {Function} [opts.logger]     optional logger with .warn
 * @returns {Promise<{effectivePolicy: object|null}>}
 */
async function resolveOrgEffectivePolicy(opts = {}) {
  const { baseUrl, orgId, projectId, internalToken, authBearer } = opts;
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!baseUrl || !orgId || !internalToken || !fetchImpl) return { effectivePolicy: null };

  const base = String(baseUrl).replace(/\/$/, '');
  const headers = { 'x-internal-token': internalToken };
  if (authBearer) headers.authorization = authBearer;
  const url = `${base}/api/v1/internal/s2s/orgs/${encodeURIComponent(orgId)}/effective-policy${projectQuery(projectId)}`;
  try {
    const data = await getJson(fetchImpl, url, headers);
    return { effectivePolicy: (data && data.domains) || null };
  } catch (err) {
    if (opts.logger && opts.logger.warn) opts.logger.warn(`org policy resolve failed: ${err.message}`);
    return { effectivePolicy: null };
  }
}

module.exports = { resolveEffectiveSettings, resolveOrgEffectivePolicy, authHeaders, EMPTY };
