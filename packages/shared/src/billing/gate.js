'use strict';

const store = require('../store');
const { CONFIG } = require('../config');
const { resolveOrgId } = require('./org-context');
const ledger = require('./ledger');

/**
 * The negative-balance runner gate — deliberately SIMPLE (one read, no side
 * effects). Runner entry points call this and, when blocked, use the existing
 * pause machinery. Inert unless billing is enabled AND the org account opts in
 * (`gateEnabled`), so the pause can be dark-launched.
 *
 * @returns {{ blocked: boolean, orgId: string, balancePaise: number|null, reason: string|null }}
 */
function billingStatus(context = {}) {
  const orgId = resolveOrgId(context);
  if (!CONFIG.BILLING.sweepEnabled) return { blocked: false, orgId, balancePaise: null, reason: null };
  const account = store.getBillingAccount(orgId);
  // No account yet ⇒ not blocked (the first sweep seeds the initial credit).
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

/** Convenience boolean form of billingStatus. */
function isBillingBlocked(context = {}) {
  return billingStatus(context).blocked;
}

module.exports = { billingStatus, isBillingBlocked };
