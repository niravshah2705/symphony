'use strict';

const store = require('../store');
const log = require('../logger');
const ledger = require('./ledger');
const cashfreeClient = require('./cashfree-client');

const RECHARGE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between automatic recharges

// /subscriptions/pay answers with `payment_status`; these mean the money moved.
const SUCCESS_PAYMENT_STATUSES = new Set(['SUCCESS', 'PAID', 'COMPLETED']);

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

  const amount = Math.round(Number(cfg.amountPaise) || 0);
  if (amount <= 0) return null;

  // Idempotency: respect a cooldown between automatic recharges.
  const gateMs = lastChargeGateMs(cfg);
  if (gateMs !== null && now - gateMs < RECHARGE_COOLDOWN_MS) return null;

  // Real Cashfree Payment Charge
  let chargePaymentId = null;
  let chargeRef = null;
  if (cashfreeClient.isConfigured() && cfg.cashfreeSubscriptionId) {
    // Stable within one cooldown window so a retried run cannot mint a second
    // charge for the same top-up — `now` would be unique per invocation.
    chargePaymentId = `pay_${orgId}_${Math.floor(now / RECHARGE_COOLDOWN_MS)}`;
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

  const updatedCfg = {
    ...cfg,
    lastRechargedAt: new Date(now).toISOString(),
    lastRechargeAmountPaise: amount,
  };
  store.upsertBillingAccount(orgId, { autoRecharge: updatedCfg });

  log.info(`auto-recharged org ${orgId}: +${amount} paise (balance was ${balancePaise})`);
  return ledger.postEntry(orgId, {
    type: 'auto_recharge',
    amountPaise: amount,
    description: `Auto-reload: balance fell below threshold (${cfg.mode === 'percentage' ? `${cfg.thresholdPercent}%` : `₹${(cfg.thresholdPaise || 0) / 100}`})`,
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
  RECHARGE_COOLDOWN_MS,
};
