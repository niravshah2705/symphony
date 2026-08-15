'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');

/**
 * S2S client for the settings service's per-org secret resolver
 * (GET /api/v1/internal/s2s/orgs/{orgId}/secrets). Unlike the principal-scoped
 * settings-client, the proxy acts for an ORG and carries no end-user token, so
 * org vault calls authenticate with an organization-bound X-Org-Internal-Token
 * (+ Cloud Run OIDC for IAM). Shared managed-only calls retain
 * X-Internal-Token. A tenant proxy never receives the derivation key.
 *
 * Returns the raw resolve payload `{ org_id, secrets: { key: {source,value,error} } }`.
 * Throws on any transport/HTTP failure so the caller can FAIL CLOSED (a missing
 * customer credential must never degrade into an unauthenticated request).
 */

const INTERNAL_API_TOKEN = String(process.env.INTERNAL_API_TOKEN || '').trim();
const ORG_INTERNAL_API_TOKEN = String(process.env.ORG_INTERNAL_API_TOKEN || '').trim();

let googleAuth = null;
async function s2sAuthHeader(audience) {
  // OIDC identity token only makes sense against IAM-gated Cloud Run (pubsub mode).
  if (CONFIG.MESSAGING_MODE !== 'pubsub') return '';
  if (!googleAuth) {
    const { GoogleAuth } = require('google-auth-library');
    googleAuth = new GoogleAuth();
  }
  const client = await googleAuth.getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  // google-auth-library v10+ returns a WHATWG Headers object here; v9 returned a
  // plain object. Read via .get() when available so the S2S OIDC token survives.
  if (typeof headers.get === 'function') return headers.get('authorization') || '';
  return headers.Authorization || headers.authorization || '';
}

async function s2sRequest(path, {
  fetchImpl,
  method = 'GET',
  body,
  orgScoped = false,
  orgInternalToken,
  internalToken,
  env,
} = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const base = CONFIG.SERVICES.settingsUrl;
  if (!base) throw new Error('settings service URL is not configured');
  if (!doFetch) throw new Error('settings service transport is unavailable');

  const origin = (() => {
    try {
      return new URL(base).origin;
    } catch (_) {
      return base;
    }
  })();
  const scopedToken = String(
    orgInternalToken !== undefined
      ? orgInternalToken
      : (env && env.ORG_INTERNAL_API_TOKEN) || ORG_INTERNAL_API_TOKEN
  ).trim();
  if (orgScoped && !scopedToken) {
    throw new Error('organization-scoped settings request requires ORG_INTERNAL_API_TOKEN');
  }
  const sharedToken = String(
    internalToken !== undefined
      ? internalToken
      : (env && env.INTERNAL_API_TOKEN) || INTERNAL_API_TOKEN
  ).trim();
  if (!orgScoped && !sharedToken) {
    throw new Error('managed settings request requires INTERNAL_API_TOKEN');
  }
  const headers = orgScoped
    ? { 'x-org-internal-token': scopedToken }
    : { 'x-internal-token': sharedToken };
  const auth = await s2sAuthHeader(origin);
  if (auth) headers.authorization = auth;

  const url = `${String(base).replace(/\/$/, '')}${path}`;
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const resp = await doFetch(url, init);
  if (!resp || !resp.ok) {
    throw new Error(`settings s2s resolve → ${resp && resp.status ? resp.status : 'network-error'}`);
  }
  return resp.json();
}

async function s2sGet(path, opts = {}) {
  return s2sRequest(path, { ...opts, method: 'GET' });
}

/** Per-org resolve (managed + customer). */
async function fetchOrgSecrets(orgId, opts = {}) {
  if (!orgId) return null;
  const projectId = opts.projectId === undefined || opts.projectId === ''
    ? ''
    : validateProjectId(opts.projectId);
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return s2sGet(`/api/v1/internal/s2s/orgs/${encodeURIComponent(orgId)}/secrets${query}`, {
    ...opts,
    orgScoped: true,
  });
}

function validateProjectId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new Error('X-AI-Fleet-Project-ID must be a UUID');
  }
  return id;
}

/** Non-secret organization connector target configuration. */
async function fetchOrgEgressConfig(orgId, opts = {}) {
  if (!orgId) return null;
  return s2sGet(`/api/v1/internal/s2s/orgs/${encodeURIComponent(orgId)}/egress-config`, {
    ...opts,
    orgScoped: true,
  });
}

/** No-org managed resolve (shared stack). */
async function fetchManagedSecrets(opts = {}) {
  return s2sGet('/api/v1/internal/s2s/managed-secrets', opts);
}

async function rotateOrgCodexTokens(orgId, expectedObtainedAt, tokens, opts = {}) {
  if (!orgId) throw new Error('org id is required for Codex token rotation');
  return s2sRequest(`/api/v1/internal/s2s/orgs/${encodeURIComponent(orgId)}/codex-tokens`, {
    ...opts,
    method: 'PUT',
    orgScoped: true,
    body: { expectedObtainedAt, tokens },
  });
}

module.exports = {
  fetchOrgSecrets,
  fetchManagedSecrets,
  fetchOrgEgressConfig,
  rotateOrgCodexTokens,
  validateProjectId,
};
