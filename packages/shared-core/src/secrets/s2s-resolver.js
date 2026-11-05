'use strict';

/**
 * Single managed-secret source shared by every agent execution pattern.
 *
 * Resolves per-organization provider secrets from the settings service over
 * service-to-service RPC (KMS-decrypted vault values), so raw credentials live
 * only server-side and are never embedded in an agent sandbox. Lifted from the
 * inline block in `services/planner/src/routes/agent.js` so the OpenShell and
 * Agent Substrate patterns resolve secrets identically.
 *
 * - Per-tenant path:  GET {settings}/api/v1/internal/s2s/orgs/{org}/secrets   (x-org-internal-token)
 * - Shared/managed:   GET {settings}/api/v1/internal/s2s/managed-secrets       (x-internal-token)
 *
 * Best-effort: any failure resolves to an empty map so callers fall back to
 * their local store / env values.
 */

const CONFIG = require('../config');

function buildRequest({ organizationId, projectId, orgInternalToken, internalToken }) {
  if (organizationId && orgInternalToken) {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    return {
      path: `/api/v1/internal/s2s/orgs/${encodeURIComponent(organizationId)}/secrets${qs}`,
      headers: { 'x-org-internal-token': orgInternalToken },
    };
  }
  if (internalToken) {
    return {
      path: '/api/v1/internal/s2s/managed-secrets',
      headers: { 'x-internal-token': internalToken },
    };
  }
  return null;
}

/**
 * @returns {Promise<Record<string, string>>} resolved secret values keyed by
 *   secret name (e.g. `githubToken`, `openrouterApiKey`); absent keys are omitted.
 */
async function fetchS2sSecrets({ organizationId, projectId, settingsBase } = {}) {
  const base = settingsBase || (CONFIG.SERVICES && CONFIG.SERVICES.settingsUrl);
  if (!base) return {};
  const orgId = String(organizationId || process.env.PROXY_ORG_ID || process.env.FLEET_ORG_ID || '').trim();
  const projId = String(projectId || '').trim();
  const orgInternalToken = String(process.env.ORG_INTERNAL_API_TOKEN || '').trim();
  const internalToken = String(process.env.INTERNAL_API_TOKEN || '').trim();
  const request = buildRequest({ organizationId: orgId, projectId: projId, orgInternalToken, internalToken });
  if (!request) return {};
  try {
    const resp = await fetch(`${String(base).replace(/\/$/, '')}${request.path}`, {
      headers: request.headers,
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return {};
    const data = await resp.json();
    const secrets = (data && data.secrets) || {};
    const out = {};
    for (const [key, entry] of Object.entries(secrets)) {
      const value = entry && typeof entry === 'object' ? entry.value : entry;
      if (value) out[key] = String(value).trim();
    }
    return out;
  } catch (_) {
    // Best-effort S2S secret lookup; callers fall back to local store settings.
    return {};
  }
}

/**
 * Fill only the missing fields from the S2S resolver, preserving caller-provided
 * values. Returns a fresh object so callers can drop inline mutation logic.
 */
async function resolveMissingSecrets(existing = {}, { organizationId, projectId, settingsBase } = {}) {
  const merged = { ...existing };
  const needKeys = Object.entries(merged).filter(([, v]) => !v).map(([k]) => k);
  if (needKeys.length === 0) return merged;
  const secrets = await fetchS2sSecrets({ organizationId, projectId, settingsBase });
  for (const key of needKeys) {
    if (secrets[key]) merged[key] = secrets[key];
  }
  return merged;
}

module.exports = {
  buildRequest,
  fetchS2sSecrets,
  resolveMissingSecrets,
};
