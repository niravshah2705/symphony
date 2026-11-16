'use strict';

/**
 * Auto-recharge TRIGGER arithmetic.
 *
 * This module used to also move the money: charge the Cashfree mandate, then post
 * an `auto_recharge` credit into the local ledger. The second half is gone with
 * the local balance, because a ledger credit is not spendable credit — only
 * FlexPrice's wallet is, and `services/billing/src/recharge-settle.js` is the one
 * place allowed to move money into it. What remains is the arithmetic the hourly
 * job needs to decide whether a recharge is due at all.
 *
 * The mandate-on-wallet settlement is not implemented. A Cashfree ON_DEMAND
 * mandate charges the amount recorded on the subscription, and the ₹500 → ₹590
 * rule means a mandate credit has to be quoted with GST on top before it is
 * charged — which cannot be measured against a mandate without production keys.
 * So `auto-recharge-job.js` reports a due recharge and charges nothing, and
 * `docs/BILLING_FLEXPRICE.md` carries that as a launch item.
 */

/**
 * Effective recharge trigger in paise, compared against the org's WALLET balance.
 * Percentage mode is a share of the org's opening credit, which is configuration
 * (`initialCreditPaise`) rather than a balance.
 *
 * @param {object} account
 * @param {object} cfg
 * @returns {number}
 */
function getEffectiveThresholdPaise(account, cfg) {
  const mode = cfg.mode || 'amount';
  if (mode === 'percentage') {
    const openingCredit = Number(account.initialCreditPaise) || 0;
    const percent = Number(cfg.thresholdPercent) || 20;
    return Math.round((openingCredit * percent) / 100);
  }
  return Number(cfg.thresholdPaise) || 0;
}

module.exports = {
  getEffectiveThresholdPaise,
};
