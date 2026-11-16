'use strict';

const store = require('../store');
const { CONFIG } = require('../config');

/**
 * Billing account preferences, plus the developer journal.
 *
 * There is no balance here any more. `ledgerEntries` used to be summed into
 * `billingAccounts.balancePaise`, and that number was the one the runner gate,
 * the auto-recharge job and the UI all acted on — a third figure beside FlexPrice's
 * stored balance and its `real_time_credit_balance`, agreeing with neither. The
 * gate reads the wallet (`billing/gate.js`) and so does everything that used to
 * read this; `store.addLedgerEntry` is left as a write-only journal for a developer
 * who wants a local trace, and NO money decision may read it. The two directions a
 * sum could be wrong — a debit that never reached FlexPrice, or a FlexPrice draw
 * with no local entry — are the same directions a customer could be over- or
 * under-charged by.
 */

// 100 INR (low), then 0 INR (exhausted). The LEVELS at which to alert — an
// alerting policy, not a balance. Compared against the wallet number by
// `notify.checkThresholdsAndNotify`, and exported as the input to the alerting
// Terraform (`scripts/gen-observability-inputs.js` reads this declaration).
const DEFAULT_ALERT_THRESHOLDS_PAISE = Object.freeze([10000, 0]);
const DEFAULT_AUTO_RECHARGE = Object.freeze({
  enabled: false,
  mode: 'amount', // 'amount' | 'percentage'
  thresholdPaise: 0, // recharge when the wallet balance drops below this (in paise)
  thresholdPercent: 20, // recharge when it drops below this % of the opening credit
  amountPaise: 50000, // top up 500 INR (50000 paise)
  cashfreeSubscriptionId: null,
  paymentMethodType: null,
});

const DEFAULT_PAYMENT_INFO = Object.freeze({
  billingName: '',
  billingEmail: '',
  billingPhone: '',
  taxId: '',
  address: null,
  updatedAt: null,
});

/**
 * Ensure an org has a billing account and fill in the defaults it is missing.
 * Carries no money: the opening credit is a FlexPrice `FREE_CREDIT_GRANT`
 * (`scripts/flexprice-provision.js`), so creating an account here credits nothing.
 * Idempotent — an account that exists is returned without a rewrite, so a page
 * load does not stamp `updatedAt` across the tenant's billing config.
 */
function ensureAccount(orgId) {
  const existing = store.getBillingAccount(orgId);
  if (existing) return existing;
  return store.upsertBillingAccount(orgId, {
    currency: 'INR',
    // The rupee value of the free-tier opening grant — the BASIS percentage-mode
    // auto-recharge multiplies, and the number the provisioner minted as credits.
    // It is configuration, not a balance.
    initialCreditPaise: CONFIG.BILLING.initialCreditPaise,
    alertThresholdsPaise: [...DEFAULT_ALERT_THRESHOLDS_PAISE],
    lastAlertedThresholdPaise: null,
    notifyChannels: { browser: true, email: false, slack: false },
    notifyEmails: [],
    autoRecharge: { ...DEFAULT_AUTO_RECHARGE },
    paymentInfo: { ...DEFAULT_PAYMENT_INFO },
    gateEnabled: true,
  });
}

module.exports = {
  DEFAULT_ALERT_THRESHOLDS_PAISE,
  DEFAULT_AUTO_RECHARGE,
  DEFAULT_PAYMENT_INFO,
  ensureAccount,
};
