'use strict';

const store = require('../store');
const { CONFIG } = require('../config');
const { resolveOrgId } = require('./org-context');
const ledger = require('./ledger');

/**
 * Cheap, side-effect-free admission check used at the gateway and again by
 * execution stages. Missing accounts remain allowed until the billing sweep
 * seeds one; an opted-out account remains unblocked.
 */
function billingStatus(context = {}) {
  const orgId = resolveOrgId(context);
  if (!CONFIG.BILLING.sweepEnabled) {
    return { blocked: false, orgId, balancePaise: null, reason: null };
  }
  const account = store.getBillingAccount(orgId);
  if (!account) return { blocked: false, orgId, balancePaise: null, reason: null };
  if (account.gateEnabled === false) {
    return { blocked: false, orgId, balancePaise: Number(account.balancePaise) || 0, reason: null };
  }
  const balancePaise = Number.isFinite(Number(account.balancePaise))
    ? Number(account.balancePaise)
    : ledger.balanceFromLedger(orgId);
  const blocked = balancePaise < 0;
  return {
    blocked,
    orgId,
    balancePaise,
    reason: blocked ? 'Billing balance exhausted — add credits to resume runner activity.' : null,
  };
}

function isBillingBlocked(context = {}) {
  return billingStatus(context).blocked;
}

module.exports = { billingStatus, isBillingBlocked };
