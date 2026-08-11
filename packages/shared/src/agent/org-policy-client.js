'use strict';

const { CONFIG } = require('../config');
const { resolveOrgEffectivePolicy } = require('./settings-client');

/**
 * Autonomous-runtime helper: resolve THIS org's effective policy from the
 * settings service so the scheduler/coder can ENFORCE it. The autonomous loop
 * acts for an org and carries no end-user token, so it uses the same token-gated
 * S2S surface the egress proxy uses for secrets (X-Internal-Token + Cloud Run
 * OIDC for IAM). Org id comes from the runtime's own env (per-tenant provisioner
 * sets AIFLEET_ORG_ID / PROXY_ORG_ID), never from caller input.
 *
 * FAIL-OPEN (unlike the proxy's secrets path, which fails closed): any missing
 * config, absent token, or transport error resolves to `null` so planning
 * defaults to allow-all — a settings outage must never brick autonomous runs.
 */

const INTERNAL_API_TOKEN = String(process.env.INTERNAL_API_TOKEN || '').trim();
const ORG_ID = String(process.env.AIFLEET_ORG_ID || process.env.PROXY_ORG_ID || '').trim();

let googleAuth = null;
async function oidcBearer(audience) {
  // OIDC identity token only makes sense against IAM-gated Cloud Run (pubsub mode).
  if (CONFIG.MESSAGING_MODE !== 'pubsub') return '';
  try {
    if (!googleAuth) {
      const { GoogleAuth } = require('google-auth-library');
      googleAuth = new GoogleAuth();
    }
    const client = await googleAuth.getIdTokenClient(audience);
    const headers = await client.getRequestHeaders();
    return headers.Authorization || headers.authorization || '';
  } catch (_) {
    return '';
  }
}

/**
 * @param {string} [projectId] optional project overlay (org-only when omitted)
 * @param {object} [opts] { fetchImpl, logger }
 * @returns {Promise<object|null>} the effective-policy domains map, or null (allow-all)
 */
async function fetchOrgEffectivePolicy(projectId, opts = {}) {
  const baseUrl = CONFIG.SERVICES && CONFIG.SERVICES.settingsUrl;
  if (!baseUrl || !INTERNAL_API_TOKEN || !ORG_ID) return null;

  let origin = baseUrl;
  try { origin = new URL(baseUrl).origin; } catch (_) { /* keep baseUrl */ }

  const res = await resolveOrgEffectivePolicy({
    baseUrl,
    orgId: ORG_ID,
    projectId,
    internalToken: INTERNAL_API_TOKEN,
    authBearer: await oidcBearer(origin),
    fetchImpl: opts.fetchImpl,
    logger: opts.logger,
  });
  return (res && res.effectivePolicy) || null;
}

module.exports = { fetchOrgEffectivePolicy };
