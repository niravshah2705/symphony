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
 * browser, and the service is IAM-gated). The selected context headers are only
 * a request; settings resolves them against the forwarded end-user token via
 * the authoritative org service.
 *
 * A selected organization fails closed when policy cannot be resolved. The
 * empty local/single-user context retains the legacy allow-all fallback.
 * Secrets are NEVER logged.
 */

const EMPTY = Object.freeze({ effectivePolicy: null, values: {}, geminiApiKey: '', prefs: {} });

class PolicyUnavailableError extends Error {
  constructor(message = 'Workspace policy is temporarily unavailable.', cause = null) {
    super(message);
    this.name = 'PolicyUnavailableError';
    this.code = 'policy_unavailable';
    this.status = 503;
    if (cause) this.cause = cause;
  }
}

function isPolicyUnavailableError(error) {
  return Boolean(error && error.code === 'policy_unavailable');
}

function policyUnavailable(cause = null) {
  return isPolicyUnavailableError(cause) ? cause : new PolicyUnavailableError(undefined, cause);
}

function validEffectivePolicy(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).length,
  );
}

/** Build the settings-service auth headers, mirroring the gateway proxy. */
function contextId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(id) ? id : '';
}

function authHeaders({ userToken, s2sToken, organizationId, projectId }) {
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
  const org = contextId(organizationId);
  const project = contextId(projectId);
  if (org) headers['x-ai-fleet-organization-id'] = org;
  if (project) headers['x-ai-fleet-project-id'] = project;
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
 * service. Returns `{ effectivePolicy, values, geminiApiKey }`. A nonempty
 * selected organization is fail-closed; empty local context remains allow-all.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl        settings service origin (no trailing slash)
 * @param {string} [opts.userToken]    end-user bearer (Firebase / local JWT)
 * @param {string} [opts.s2sToken]     Cloud Run S2S OIDC token (pubsub mode)
 * @param {string} [opts.organizationId] selected organization context
 * @param {string} [opts.projectId]    selected native project scope
 * @param {Function} [opts.fetchImpl]  fetch implementation (defaults to global)
 * @param {Function} [opts.logger]     optional logger with .warn/.error
 */
async function resolveEffectiveSettings(opts = {}) {
  const { baseUrl, userToken, s2sToken, organizationId, projectId } = opts;
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const selectedOrgId = contextId(organizationId);
  const failClosed = Boolean(selectedOrgId);
  if (!baseUrl || !fetchImpl) {
    if (failClosed) throw policyUnavailable();
    return { ...EMPTY };
  }

  const headers = authHeaders({ userToken, s2sToken, organizationId, projectId });
  const base = String(baseUrl).replace(/\/$/, '');
  const q = projectQuery(projectId);
  const result = { effectivePolicy: null, values: {}, geminiApiKey: '', prefs: {} };

  try {
    const effective = await getJson(fetchImpl, `${base}/api/v1/settings/effective${q}`, headers);
    if (effective && effective.domains) result.effectivePolicy = effective.domains;
    if (effective && effective.prefs) result.prefs = effective.prefs;
  } catch (err) {
    if (opts.logger && opts.logger.warn) opts.logger.warn(`settings policy resolve failed: ${err.message}`);
    if (failClosed) throw policyUnavailable(err);
  }
  if (failClosed && !validEffectivePolicy(result.effectivePolicy)) throw policyUnavailable();

  try {
    const config = await getJson(fetchImpl, `${base}/api/v1/internal/effective-config${q}`, headers);
    if (config && config.values && typeof config.values === 'object') {
      result.values = config.values;
      result.geminiApiKey = String(config.values.geminiApiKey || '');
    }
  } catch (err) {
    // Never log the secret; only the failure.
    if (opts.logger && opts.logger.warn) opts.logger.warn(`settings config resolve failed: ${err.message}`);
    if (failClosed) throw policyUnavailable(err);
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
 * A nonempty org is fail-closed: missing configuration, transport/HTTP errors,
 * or a response without effective domains throws PolicyUnavailableError. An
 * empty local org retains the legacy allow-all result.
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
  const selectedOrgId = contextId(orgId);
  if (!selectedOrgId) return { effectivePolicy: null, prefs: {} };
  if (!baseUrl || !internalToken || !fetchImpl) throw policyUnavailable();

  const base = String(baseUrl).replace(/\/$/, '');
  const headers = { 'x-internal-token': internalToken };
  if (authBearer) headers.authorization = authBearer;
  const url = `${base}/api/v1/internal/s2s/orgs/${encodeURIComponent(selectedOrgId)}/effective-policy${projectQuery(projectId)}`;
  try {
    const data = await getJson(fetchImpl, url, headers);
    const effectivePolicy = data && data.domains;
    if (!validEffectivePolicy(effectivePolicy)) {
      throw policyUnavailable();
    }
    return { effectivePolicy, prefs: (data && data.prefs) || {} };
  } catch (err) {
    if (opts.logger && opts.logger.warn) opts.logger.warn(`org policy resolve failed: ${err.message}`);
    throw policyUnavailable(err);
  }
}

module.exports = {
  resolveEffectiveSettings,
  resolveOrgEffectivePolicy,
  authHeaders,
  EMPTY,
  PolicyUnavailableError,
  isPolicyUnavailableError,
};
