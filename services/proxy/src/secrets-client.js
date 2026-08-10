'use strict';

const { CONFIG } = require('@ai-fleet/shared/config');

/**
 * S2S client for the settings service's per-org secret resolver
 * (GET /api/v1/internal/s2s/orgs/{orgId}/secrets). Unlike the principal-scoped
 * settings-client, the proxy acts for an ORG and carries no end-user token, so
 * it authenticates with the shared X-Internal-Token (+ Cloud Run OIDC for IAM).
 *
 * Returns the raw resolve payload `{ org_id, secrets: { key: {source,value,error} } }`.
 * Throws on any transport/HTTP failure so the caller can FAIL CLOSED (a missing
 * customer credential must never degrade into an unauthenticated request).
 */

const INTERNAL_API_TOKEN = String(process.env.INTERNAL_API_TOKEN || '').trim();

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
  return headers.Authorization || headers.authorization || '';
}

async function s2sGet(path, { fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const base = CONFIG.SERVICES.settingsUrl;
  if (!base || !doFetch) return null;

  const origin = (() => {
    try {
      return new URL(base).origin;
    } catch (_) {
      return base;
    }
  })();
  const headers = { 'x-internal-token': INTERNAL_API_TOKEN };
  const auth = await s2sAuthHeader(origin);
  if (auth) headers.authorization = auth;

  const url = `${String(base).replace(/\/$/, '')}${path}`;
  const resp = await doFetch(url, { method: 'GET', headers });
  if (!resp || !resp.ok) {
    throw new Error(`settings s2s resolve → ${resp && resp.status ? resp.status : 'network-error'}`);
  }
  return resp.json();
}

/** Per-org resolve (managed + customer). */
async function fetchOrgSecrets(orgId, opts = {}) {
  if (!orgId) return null;
  return s2sGet(`/api/v1/internal/s2s/orgs/${encodeURIComponent(orgId)}/secrets`, opts);
}

/** No-org managed resolve (shared stack). */
async function fetchManagedSecrets(opts = {}) {
  return s2sGet('/api/v1/internal/s2s/managed-secrets', opts);
}

module.exports = { fetchOrgSecrets, fetchManagedSecrets };
