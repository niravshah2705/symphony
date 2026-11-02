'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');
const log = require('@ai-fleet/shared-core/logger');
const { SHARED_ORG_ID } = require('@ai-fleet/shared-core/billing/org-context');
const { bearerToken } = require('./auth');
const { callJson } = require('./service-client');
const { requestContext } = require('./request-context');

/**
 * Billing access resolution for the /api/billing proxy.
 *
 * The billing service owns the Cashfree credentials and the wallet ledger, but
 * it has no browser authentication of its own. So two decisions are made HERE,
 * from the caller's verified bearer, and handed to the service as trusted
 * headers: WHICH organization's billing data a request addresses, and WHETHER
 * the caller administers it (the service re-checks before it lets anything
 * mutate). The org service (`GET /api/v1/me`) is the authority for both — a
 * client header can request a selection, it can never assert one.
 *
 * Anti-spoofing: `createProxy` builds its upstream headers from an empty object,
 * so nothing a browser sends can arrive alongside these, and Cloud Run IAM binds
 * the billing service to this gateway's service account alone.
 *
 * Resolution fails CLOSED: an unresolvable caller becomes a non-admin on the
 * shared account, so a 403 here means a permission gap rather than a leak.
 */

const BILLING_HEADERS = Object.freeze({
  org: 'x-ai-fleet-billing-org-id',
  role: 'x-ai-fleet-billing-org-role',
  user: 'x-ai-fleet-billing-user-id',
});

const ORG_ADMIN_ROLE = 'ORG_ADMIN';

/**
 * Resolve the caller's billing org + admin flag server-side. Local dev (auth
 * disabled) → the deployment org, admin. Otherwise the org service is
 * authoritative; an org-less (personal) user maps to the shared free-tier
 * account with no admin rights.
 */
async function resolveCallerOrg(req) {
  if (req.auth && req.auth.mode === 'disabled') {
    return { orgId: CONFIG.BILLING.orgId || SHARED_ORG_ID, userId: null, isAdmin: true };
  }
  let bearer = '';
  try {
    bearer = bearerToken(req);
  } catch (_) {
    bearer = '';
  }
  // On a dedicated stack the deployment IS one org; that identity is authoritative
  // for which billing data exists in this (namespaced) store.
  const deploymentOrg = CONFIG.BILLING.orgId || '';
  if (CONFIG.SERVICES.orgUrl && bearer) {
    let outcome = 'no response';
    try {
      const { status, data } = await callJson(CONFIG.SERVICES.orgUrl, '/api/v1/me', {
        userAuth: bearer,
        context: requestContext(req),
      });
      outcome = `status ${status}`;
      if (status === 200 && data) {
        const isAdmin = String(data.org_role || '').toUpperCase() === ORG_ADMIN_ROLE;
        if (data.org_id) return { orgId: deploymentOrg || String(data.org_id), userId: data.user_id || null, isAdmin };
        // Signed in but org-less → shared free-tier account, read-only.
        return { orgId: deploymentOrg || SHARED_ORG_ID, userId: data.user_id || null, isAdmin: false };
      }
    } catch (err) {
      outcome = `error ${err && err.message ? err.message : err}`;
    }
    // Fail-closed non-admin can be a real permission gap or a failed lookup; say
    // which, so a 403 downstream is diagnosable from the gateway logs alone.
    log.warn(`billing: org lookup did not resolve an admin (${outcome}) for org ${deploymentOrg || SHARED_ORG_ID}`);
  }
  return { orgId: deploymentOrg || SHARED_ORG_ID, userId: null, isAdmin: false };
}

/** Middleware: attach `req.billingCaller`. Never rejects — the service enforces. */
async function requireBillingCaller(req, res, next) {
  try {
    req.billingCaller = await resolveCallerOrg(req);
  } catch (err) {
    log.error(`billing: caller resolution failed: ${err && err.message ? err.message : err}`);
    req.billingCaller = { orgId: CONFIG.BILLING.orgId || SHARED_ORG_ID, userId: null, isAdmin: false };
  }
  next();
}

/** `createProxy` injectHeaders: the resolved caller as trusted billing headers. */
function billingTrustedHeaders(req) {
  const caller = req.billingCaller;
  if (!caller) return {};
  return {
    [BILLING_HEADERS.org]: caller.orgId,
    [BILLING_HEADERS.role]: caller.isAdmin ? ORG_ADMIN_ROLE : 'ORG_MEMBER',
    [BILLING_HEADERS.user]: caller.userId || '',
  };
}

module.exports = { resolveCallerOrg, requireBillingCaller, billingTrustedHeaders, BILLING_HEADERS };
