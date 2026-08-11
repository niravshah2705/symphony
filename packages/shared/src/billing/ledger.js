'use strict';

const store = require('../store');
const { CONFIG } = require('../config');

/**
 * The ledger is the append-only money source of truth (all amounts in INTEGER
 * paise). A per-org account caches a DERIVED balance snapshot for the frequent
 * runner gate; every write path recomputes the snapshot from the ledger, so the
 * snapshot is always authoritative and self-heals any drift. This avoids a
 * non-atomic read-modify-write on a mutable balance (business-logic checklist:
 * no double-spend / race on money).
 */

// 100 INR (low), then 0 INR (exhausted). Balances (paise) at which to alert.
const DEFAULT_ALERT_THRESHOLDS_PAISE = Object.freeze([10000, 0]);
const DEFAULT_AUTO_RECHARGE = Object.freeze({
  enabled: false,
  thresholdPaise: 0, // recharge when balance drops below this
  amountPaise: 50000, // top up 500 INR
  lastRechargedAt: null,
});

/** Signed sum (paise) of all ledger entries for an org — the true balance. */
function balanceFromLedger(orgId) {
  return store
    .listLedgerEntries({ orgId })
    .reduce((sum, entry) => sum + (Number(entry.amountPaise) || 0), 0);
}

/**
 * Ensure an org has a billing account, seeding the one-time initial credit as the
 * first ledger entry. Idempotent: seeds only when no account exists yet — a
 * returning org with a spent-down balance is NEVER re-credited. Returns the account.
 */
function ensureAccount(orgId) {
  const existing = store.getBillingAccount(orgId);
  if (existing) return existing;
  const initial = CONFIG.BILLING.initialCreditPaise;
  if (initial > 0) {
    store.addLedgerEntry({
      orgId,
      type: 'credit',
      amountPaise: initial,
      description: 'Initial credit',
      meta: {},
    });
  }
  return store.upsertBillingAccount(orgId, {
    currency: 'INR',
    balancePaise: initial,
    initialCreditPaise: initial,
    alertThresholdsPaise: [...DEFAULT_ALERT_THRESHOLDS_PAISE],
    lastAlertedThresholdPaise: null,
    notifyChannels: { browser: true, email: false, slack: false },
    notifyEmails: [],
    autoRecharge: { ...DEFAULT_AUTO_RECHARGE },
    gateEnabled: true,
  });
}

/** Recompute the account balance snapshot from the ledger and persist it. */
function refreshBalance(orgId) {
  return store.upsertBillingAccount(orgId, { balancePaise: balanceFromLedger(orgId) });
}

/**
 * Append a SIGNED ledger entry (negative = debit) and refresh the org's balance
 * snapshot. Ensures the account exists first. Returns { entry, account }.
 */
function postEntry(orgId, { type, amountPaise, description, meta } = {}) {
  ensureAccount(orgId);
  const entry = store.addLedgerEntry({
    orgId,
    type: type || 'adjustment',
    amountPaise: Math.round(Number(amountPaise) || 0),
    description: description || '',
    meta: meta || {},
  });
  const account = refreshBalance(orgId);
  return { entry, account };
}

/** Current balance snapshot (paise) for an org, or the ledger sum if no account. */
function currentBalancePaise(orgId) {
  const account = store.getBillingAccount(orgId);
  if (account && Number.isFinite(Number(account.balancePaise))) return Number(account.balancePaise);
  return balanceFromLedger(orgId);
}

module.exports = {
  DEFAULT_ALERT_THRESHOLDS_PAISE,
  DEFAULT_AUTO_RECHARGE,
  balanceFromLedger,
  ensureAccount,
  refreshBalance,
  postEntry,
  currentBalancePaise,
};
