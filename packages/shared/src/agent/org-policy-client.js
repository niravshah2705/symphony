'use strict';

const { CONFIG } = require('../config');
const {
  resolveOrgEffectivePolicy,
  PolicyUnavailableError,
  isPolicyUnavailableError,
} = require('./settings-client');

/**
 * Autonomous-runtime helper: resolve THIS org's effective policy from the
 * settings service so the scheduler/coder can ENFORCE it. The autonomous loop
 * acts for an org and carries no end-user token, so it uses the same token-gated
 * S2S surface the egress proxy uses for secrets (X-Internal-Token + Cloud Run
 * OIDC for IAM). Shared services receive an org id that the gateway/org service
 * already validated. Dedicated services are pinned by FLEET_ORG_ID (or the
 * legacy PROXY_ORG_ID) and reject a conflicting selected org.
 *
 * A selected/pinned organization is fail-closed: policy service configuration,
 * transport, and response failures surface as a typed 503. Empty local context
 * remains allow-all for backward compatibility.
 */

const INTERNAL_API_TOKEN = String(process.env.INTERNAL_API_TOKEN || '').trim();

class OrganizationContextMismatchError extends Error {
  constructor() {
    super('Selected organization does not match this deployment.');
    this.name = 'OrganizationContextMismatchError';
    this.code = 'organization_context_mismatch';
    this.status = 403;
  }
}

function cleanContextId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(id) ? id : '';
}

/** Resolve a trusted selected org against an optional tenant deployment pin. */
function resolvePolicyOrganization(selectedOrgId, pinnedOrgId = CONFIG.BILLING && CONFIG.BILLING.orgId) {
  const selected = cleanContextId(selectedOrgId);
  const pinned = cleanContextId(pinnedOrgId);
  if (pinned && selected && pinned !== selected) throw new OrganizationContextMismatchError();
  return pinned || selected;
}

function isOrganizationContextMismatch(error) {
  return Boolean(error && error.code === 'organization_context_mismatch');
}

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
 * @param {string} [organizationId] trusted selected org (shared deployment)
 * @param {string} [projectId] optional native-project overlay (org-only when omitted)
 * @param {object} [opts] { fetchImpl, logger }
 * @returns {Promise<{effectivePolicy: object|null, prefs: object}>} the effective
 *   policy domains map (null = allow-all) and the resolved operational prefs.
 */
async function fetchOrgEffectivePolicy(organizationId, projectId, opts = {}) {
  // The optional overrides keep this boundary unit-testable; all production
  // callers use CONFIG/env values. Resolve the pin before checking transport
  // config so a mismatch can never be downgraded to an allow-all outage.
  const pinnedOrgId = Object.prototype.hasOwnProperty.call(opts, 'pinnedOrgId')
    ? opts.pinnedOrgId
    : CONFIG.BILLING && CONFIG.BILLING.orgId;
  const orgId = resolvePolicyOrganization(organizationId, pinnedOrgId);
  const baseUrl = opts.baseUrl !== undefined
    ? opts.baseUrl
    : CONFIG.SERVICES && CONFIG.SERVICES.settingsUrl;
  const internalToken = opts.internalToken !== undefined ? opts.internalToken : INTERNAL_API_TOKEN;
  if (!orgId) return { effectivePolicy: null, prefs: {} };
  if (!baseUrl || !internalToken) throw new PolicyUnavailableError();

  let origin = baseUrl;
  try { origin = new URL(baseUrl).origin; } catch (_) { /* keep baseUrl */ }

  const resolveImpl = opts.resolveImpl || resolveOrgEffectivePolicy;
  try {
    const res = await resolveImpl({
      baseUrl,
      orgId,
      projectId: cleanContextId(projectId) || undefined,
      internalToken,
      authBearer: opts.authBearer !== undefined ? opts.authBearer : await oidcBearer(origin),
      fetchImpl: opts.fetchImpl,
      logger: opts.logger,
    });
    const effectivePolicy = res && res.effectivePolicy;
    if (
      !effectivePolicy
      || typeof effectivePolicy !== 'object'
      || Array.isArray(effectivePolicy)
      || !Object.keys(effectivePolicy).length
    ) {
      throw new PolicyUnavailableError();
    }
    return { effectivePolicy, prefs: (res && res.prefs) || {} };
  } catch (error) {
    if (opts.logger && opts.logger.warn) opts.logger.warn(`org policy resolve failed: ${error.message}`);
    if (isPolicyUnavailableError(error)) throw error;
    throw new PolicyUnavailableError(undefined, error);
  }
}

module.exports = {
  fetchOrgEffectivePolicy,
  resolvePolicyOrganization,
  isOrganizationContextMismatch,
  isPolicyUnavailableError,
  OrganizationContextMismatchError,
  PolicyUnavailableError,
};
