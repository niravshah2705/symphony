'use strict';

const store = require('../store');
const { CONFIG } = require('../config');
const { resolveOrgId } = require('./org-context');
const ledger = require('./ledger');

/**
 * Organization-level fund status check.
 * Maintains fund status (funds_available / funds_unavailable) strictly at the org level.
 * When balance <= 0 (or low), sandbox creation and scheduled calls are marked as disabled.
 */
function getOrgFundStatus(orgId) {
  const resolvedOrgId = typeof orgId === 'string' ? orgId.trim() : resolveOrgId({ orgId });
  if (!resolvedOrgId) {
    return {
      orgId: null,
      fundStatus: 'available',
      fundsAvailable: true,
      balancePaise: null,
      sandboxCreationDisabled: false,
      scheduledCallsDisabled: false,
      reason: null,
    };
  }
  // When sweepEnabled is off (e.g. local dev / default test environment),
  // we still honor an explicit negative-balance account if one exists and gateEnabled !== false,
  // but if no account is found we fail-open.
  const account = store.getBillingAccount(resolvedOrgId);
  if (!CONFIG.BILLING.sweepEnabled && !account) {
    return {
      orgId: resolvedOrgId,
      fundStatus: 'available',
      fundsAvailable: true,
      balancePaise: null,
      sandboxCreationDisabled: false,
      scheduledCallsDisabled: false,
      reason: null,
    };
  }
  // Missing account remains unblocked until the billing sweep seeds one
  if (!account) {
    return {
      orgId: resolvedOrgId,
      fundStatus: 'available',
      fundsAvailable: true,
      balancePaise: null,
      sandboxCreationDisabled: false,
      scheduledCallsDisabled: false,
      reason: null,
    };
  }
  const balancePaise = Number.isFinite(Number(account.balancePaise))
    ? Number(account.balancePaise)
    : ledger.balanceFromLedger(resolvedOrgId);

  // If billing gate is explicitly disabled for the account, treat as available
  if (account.gateEnabled === false) {
    return {
      orgId: resolvedOrgId,
      fundStatus: 'available',
      fundsAvailable: true,
      balancePaise,
      sandboxCreationDisabled: false,
      scheduledCallsDisabled: false,
      reason: null,
    };
  }

  // Balance <= 0 indicates exhausted/low funds
  const fundsAvailable = balancePaise > 0;
  const fundStatus = fundsAvailable ? 'available' : 'unavailable';
  const reason = !fundsAvailable ? 'Organization balance is low or exhausted (<= 0).' : null;

  return {
    orgId: resolvedOrgId,
    fundStatus,
    fundsAvailable,
    balancePaise,
    sandboxCreationDisabled: !fundsAvailable,
    scheduledCallsDisabled: !fundsAvailable,
    reason,
  };
}

/**
 * Cheap, side-effect-free admission check used at the gateway and again by
 * execution stages. Missing accounts remain allowed until the billing sweep
 * seeds one; an opted-out account remains unblocked.
 */
function billingStatus(context = {}) {
  const orgId = resolveOrgId(context);
  if (!CONFIG.BILLING.sweepEnabled) {
    return { blocked: false, orgId, balancePaise: null, reason: null, fundStatus: 'available', fundsAvailable: true };
  }
  const account = store.getBillingAccount(orgId);
  if (!account) return { blocked: false, orgId, balancePaise: null, reason: null, fundStatus: 'available', fundsAvailable: true };
  if (account.gateEnabled === false) {
    return { blocked: false, orgId, balancePaise: Number(account.balancePaise) || 0, reason: null, fundStatus: 'available', fundsAvailable: true };
  }
  const fundInfo = getOrgFundStatus(orgId);
  const blocked = !fundInfo.fundsAvailable;
  return {
    blocked,
    orgId,
    balancePaise: fundInfo.balancePaise,
    fundStatus: fundInfo.fundStatus,
    fundsAvailable: fundInfo.fundsAvailable,
    sandboxCreationDisabled: fundInfo.sandboxCreationDisabled,
    scheduledCallsDisabled: fundInfo.scheduledCallsDisabled,
    reason: blocked ? 'Billing balance exhausted — add credits to resume runner activity.' : null,
  };
}

function isBillingBlocked(context = {}) {
  return billingStatus(context).blocked;
}

module.exports = { billingStatus, isBillingBlocked, getOrgFundStatus };
