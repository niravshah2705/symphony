'use strict';

const store = require('../store');
const log = require('../logger');
const ledger = require('./ledger');

/**
 * Auto-recharge (simulated). When an org's balance is below its configured
 * threshold and auto-recharge is enabled, append a `recharge` credit entry.
 *
 * This is a STUB for a real payment gateway: the single marked point below is
 * where a Razorpay (or similar) charge would go — post the credit only on a
 * successful capture. A cooldown makes it idempotent so a persistently-low
 * balance doesn't recharge on every sweep tick.
 */

const RECHARGE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between automatic recharges

/**
 * @param {string} orgId
 * @param {number} [now] epoch ms (injectable for tests)
 * @returns {object|null} the ledger entry when a recharge happened, else null
 */
function maybeAutoRecharge(orgId, now = Date.now()) {
  const account = store.getBillingAccount(orgId);
  if (!account) return null;
  const cfg = account.autoRecharge || {};
  if (!cfg.enabled) return null;

  const balancePaise = Number(account.balancePaise) || 0;
  const threshold = Number(cfg.thresholdPaise) || 0;
  if (balancePaise >= threshold) return null;

  const amount = Math.round(Number(cfg.amountPaise) || 0);
  if (amount <= 0) return null;

  // Idempotency: respect a cooldown between automatic recharges.
  if (cfg.lastRechargedAt) {
    const last = Date.parse(cfg.lastRechargedAt);
    if (Number.isFinite(last) && now - last < RECHARGE_COOLDOWN_MS) return null;
  }

  // TODO(payments): call a real payment gateway (e.g. Razorpay) here — charge the
  // saved method and only post the credit below on a successful capture. For now
  // this is a simulated top-up so the balance/pause flow is exercisable end-to-end.
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

module.exports = { maybeAutoRecharge, RECHARGE_COOLDOWN_MS };
