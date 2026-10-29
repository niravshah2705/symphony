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

      if (!chargeRes || chargeRes.status !== 'SUCCESS') {
        log.error(`Auto-recharge charge failed with status: ${chargeRes ? chargeRes.status : 'UNKNOWN'}`);
        return null;
      }
    } catch (err) {
      log.error(`Cashfree recurring charge exception: ${err && err.message ? err.message : err}`);
      return null;
    }
  }

  const updatedCfg = {
    ...cfg,
    lastRechargedAt: new Date(now).toISOString(),
    lastRechargeAmountPaise: amount,
  };
  store.setBillingAutoRecharge(orgId, updatedCfg);

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
    },
  });
}

module.exports = {
  maybeAutoRecharge,
  getEffectiveThresholdPaise,
};
