'use strict';

const store = require('../store');
const log = require('../logger');
const ledger = require('./ledger');
const cashfreeClient = require('./cashfree-client');

const RECHARGE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between automatic recharges

// /subscriptions/pay answers with `payment_status`; these mean the money moved.
const SUCCESS_PAYMENT_STATUSES = new Set(['SUCCESS', 'PAID', 'COMPLETED']);

// Money-in ledger kinds a monthly limit has to account for: the automatic top-up
// plus every human/Cashfree-settled one. The `credit` initial grant is NOT a
// recharge and must not eat into an org's monthly room.
const TOPUP_LEDGER_TYPES = new Set(['recharge', 'auto_recharge']);
const MIN_CHARGE_PAISE = 100; // Cashfree rejects an order below ₹1

/**
 * Timestamp gating a repeat charge: the later of the last successful recharge
 * and the last *attempted* one. Without the attempt half, a charge that fails
 * at Cashfree is retried on every tick forever.
 */
function lastChargeGateMs(cfg) {
  const stamps = [cfg.lastRechargedAt, cfg.lastAttemptedAt]
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : null;
}

/** 'YYYY-MM' in UTC from epoch ms or an ISO string; null when unparseable. */
function monthKey(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 7) : null;
}

/**
 * Money already credited to the org in the UTC calendar month of `now`.
 * Derived from the append-only ledger — a stored counter would need a reset at
 * the month boundary and could be cleared by a config save.
 */
function rechargedThisMonthPaise(orgId, now = Date.now()) {
  const key = monthKey(now);
  return store
    .listLedgerEntries({ orgId })
    .filter((e) => TOPUP_LEDGER_TYPES.has(e.type) && (Number(e.amountPaise) || 0) > 0)
    // Normalize each createdAt rather than slicing it: the store accepts a
    // caller-supplied value, which may carry a non-Z offset.
    .filter((e) => monthKey(e.createdAt) === key)
    .reduce((sum, e) => sum + (Number(e.amountPaise) || 0), 0);
}

/**
 * What the next auto-recharge may actually charge: the configured amount, shrunk
 * to the room left under the monthly limit. 0 means "do not charge".
 * A limit of 0 / unset is uncapped, so orgs configured before this existed keep
 * their behaviour byte-for-byte.
 */
function chargeableAmountPaise(orgId, cfg, now = Date.now()) {
  const requested = Math.round(Number(cfg && cfg.amountPaise) || 0);
  if (requested <= 0) return 0;
  const limit = Math.round(Number(cfg && cfg.monthlyLimitPaise) || 0);
  if (limit <= 0) return requested;
  const headroom = limit - rechargedThisMonthPaise(orgId, now);
  if (headroom < MIN_CHARGE_PAISE) return 0;
  return Math.min(requested, headroom);
}

/**
 * Calculates effective threshold in paise based on autoRecharge configuration.
 * @param {object} account
 * @param {object} cfg
 * @returns {number}
 */
function getEffectiveThresholdPaise(account, cfg) {
  const mode = cfg.mode || 'amount';
  if (mode === 'percentage') {
    const initialCredit = Number(account.initialCreditPaise) || 0;
    const percent = Number(cfg.thresholdPercent) || 20;
    return Math.round((initialCredit * percent) / 100);
  }
  return Number(cfg.thresholdPaise) || 0;
}

/**
 * One automatic top-up, gated on: auto-recharge enabled, the balance strictly
 * below the effective threshold, a positive amount, the cooldown elapsed and
 * room left under the monthly limit. The charged amount is the configured
 * amount clamped to that remaining room, so a monthly limit is never exceeded
 * but a tick is not wasted while any room is left.
 *
 * @param {string} orgId
 * @param {number} [now] epoch ms (injectable for tests)
 * @returns {Promise<object|null>} the ledger entry when a recharge happened, else null
 */
async function maybeAutoRecharge(orgId, now = Date.now()) {
  const account = store.getBillingAccount(orgId);
  if (!account) return null;
  const cfg = account.autoRecharge || {};
  if (!cfg.enabled) return null;

  const balancePaise = Number(account.balancePaise) || 0;
  const thresholdPaise = getEffectiveThresholdPaise(account, cfg);
  if (balancePaise >= thresholdPaise) return null;

  const requestedPaise = Math.round(Number(cfg.amountPaise) || 0);
  if (requestedPaise <= 0) return null;

  // Idempotency: respect a cooldown between automatic recharges.
  const gateMs = lastChargeGateMs(cfg);
  if (gateMs !== null && now - gateMs < RECHARGE_COOLDOWN_MS) return null;

  // Monthly ceiling: charge the configured amount, or only the room left in the
  // UTC calendar month when that would overshoot. Checked after the cooldown so
  // a gated tick does not pay for the ledger read.
  const amount = chargeableAmountPaise(orgId, cfg, now);
  if (amount <= 0) {
    const used = rechargedThisMonthPaise(orgId, now);
    log.warn(`auto-recharge ${orgId}: monthly limit ${cfg.monthlyLimitPaise} paise reached (${used} used, ${requestedPaise} requested) — skipped`);
    return null;
  }

  // Real Cashfree Payment Charge
  let chargePaymentId = null;
  let chargeRef = null;
  if (cashfreeClient.isConfigured() && cfg.cashfreeSubscriptionId) {
    // Stable within one cooldown window so a retried run cannot mint a second
    // charge for the same top-up — `now` would be unique per invocation. The
    // amount is part of the id because a clamped top-up must never present
    // Cashfree with one id carrying two different amounts.
    chargePaymentId = `pay_${orgId}_${Math.floor(now / RECHARGE_COOLDOWN_MS)}_${amount}`;
    const amountInr = amount / 100;
    try {
      const chargeRes = await cashfreeClient.chargeSubscription({
        subscriptionId: cfg.cashfreeSubscriptionId,
        paymentId: chargePaymentId,
        amountInr,
      });

      const paymentStatus = String(
        (chargeRes && (chargeRes.payment_status ?? chargeRes.status)) || '',
      ).toUpperCase();
      if (!SUCCESS_PAYMENT_STATUSES.has(paymentStatus)) {
        log.error(`Auto-recharge charge did not settle (payment_status: ${paymentStatus || 'UNKNOWN'})`);
        store.upsertBillingAccount(orgId, {
          autoRecharge: { ...cfg, lastAttemptedAt: new Date(now).toISOString() },
        });
        return null;
      }
      chargeRef = { cfPaymentId: (chargeRes && chargeRes.cf_payment_id) || null, paymentStatus };
    } catch (err) {
      log.error(`Cashfree recurring charge exception: ${err && err.message ? err.message : err}`);
      store.upsertBillingAccount(orgId, {
        autoRecharge: { ...cfg, lastAttemptedAt: new Date(now).toISOString() },
      });
      return null;
    }
  }

  const capApplied = amount < requestedPaise;
  const updatedCfg = {
    ...cfg,
    lastRechargedAt: new Date(now).toISOString(),
    lastRechargeAmountPaise: amount,
  };
  store.upsertBillingAccount(orgId, { autoRecharge: updatedCfg });

  log.info(`auto-recharged org ${orgId}: +${amount} paise (balance was ${balancePaise})${capApplied ? ` — clamped to the monthly limit` : ''}`);
  return ledger.postEntry(orgId, {
    type: 'auto_recharge',
    amountPaise: amount,
    description: `Auto-reload: balance fell below threshold (${cfg.mode === 'percentage' ? `${cfg.thresholdPercent}%` : `₹${(cfg.thresholdPaise || 0) / 100}`})${capApplied ? ' (clamped to the monthly limit)' : ''}`,
    meta: {
      auto: true,
      mode: cfg.mode || 'amount',
      thresholdPercent: cfg.thresholdPercent,
      thresholdPaise,
      balanceBeforePaise: balancePaise,
      cashfreeSubscriptionId: cfg.cashfreeSubscriptionId || null,
      cashfreePaymentId: chargePaymentId,
      cfPaymentId: chargeRef ? chargeRef.cfPaymentId : null,
      paymentStatus: chargeRef ? chargeRef.paymentStatus : null,
      // The ledger row records what was charged, so keep what was asked for and
      // the ceiling that shrank it: auditing a partial top-up needs both.
      requestedPaise,
      monthlyLimitPaise: Math.round(Number(cfg.monthlyLimitPaise) || 0),
      capApplied,
      // No Cashfree call happened (keys unset or no mandate on file): the wallet
      // was topped up locally, and reporting must not read that as money in.
      simulated: chargePaymentId === null,
    },
  });
}

module.exports = {
  maybeAutoRecharge,
  getEffectiveThresholdPaise,
  lastChargeGateMs,
  monthKey,
  rechargedThisMonthPaise,
  chargeableAmountPaise,
  RECHARGE_COOLDOWN_MS,
  MIN_CHARGE_PAISE,
  TOPUP_LEDGER_TYPES,
};
