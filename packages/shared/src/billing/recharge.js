'use strict';

const store = require('../store');
const log = require('../logger');
const ledger = require('./ledger');
const cashfreeClient = require('./cashfree-client');

const RECHARGE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between automatic recharges

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
  if (cfg.lastRechargedAt) {
    const last = Date.parse(cfg.lastRechargedAt);
    if (Number.isFinite(last) && now - last < RECHARGE_COOLDOWN_MS) return null;
  }

  // Real Cashfree Payment Charge
  if (cashfreeClient.isConfigured() && cfg.cashfreeSubscriptionId) {
    try {
      const paymentId = `pay_${orgId}_${now}`;
      const amountInr = amount / 100;

      const chargeRes = await cashfreeClient.chargeSubscription({
        subscriptionId: cfg.cashfreeSubscriptionId,
        paymentId,
        amountInr,
      });

      const { entry } = ledger.postEntry(orgId, {
        type: 'recharge',
        amountPaise: amount,
        description: `Auto-recharge via Cashfree (${cfg.cashfreeSubscriptionId})`,
        meta: {
          cashfreeSubscriptionId: cfg.cashfreeSubscriptionId,
          paymentId,
          cfPaymentId: chargeRes.cf_payment_id || null,
          status: chargeRes.payment_status || 'PENDING',
        },
      });

      store.upsertBillingAccount(orgId, {
        autoRecharge: { ...cfg, lastRechargedAt: new Date(now).toISOString() },
      });

      log.info(`billing: auto-recharged org ${orgId} by ${amount} paise via Cashfree subscription ${cfg.cashfreeSubscriptionId}`);
      return entry;
    } catch (err) {
      log.error(`billing: auto-recharge failed for org ${orgId} via Cashfree: ${err.message}`, { error: err });
      return null;
    }
  }

  // Fallback: simulated top-up (local dev / unconfigured Cashfree keys)
  const { entry } = ledger.postEntry(orgId, {
    type: 'recharge',
    amountPaise: amount,
    description: 'Auto-recharge',
    meta: { simulated: true },
  });
  store.upsertBillingAccount(orgId, {
    autoRecharge: { ...cfg, lastRechargedAt: new Date(now).toISOString() },
  });
  log.info(`billing: auto-recharged org ${orgId} by ${amount} paise (simulated)`);
  return entry;
}

module.exports = {
  maybeAutoRecharge,
  getEffectiveThresholdPaise,
  RECHARGE_COOLDOWN_MS,
};
