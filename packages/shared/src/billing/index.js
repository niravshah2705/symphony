'use strict';

/**
 * Billing / cost-metering module. First-party LLM usage metering + a per-org
 * credit ledger, a periodic sweep that turns usage into line items, threshold
 * notifications, (simulated) auto-recharge, and a negative-balance runner gate.
 * All money is INTEGER paise. See the individual files for the contracts.
 */

const pricing = require('./pricing');
const orgContext = require('./org-context');
const ledger = require('./ledger');
const usage = require('./usage');
const gate = require('./gate');
const recharge = require('./recharge');
const notify = require('./notify');
const sweep = require('./sweep');

module.exports = {
  ...pricing,
  ...orgContext,
  ledger,
  recordUsage: usage.recordUsage,
  pickUsage: usage.pickUsage,
  billingStatus: gate.billingStatus,
  isBillingBlocked: gate.isBillingBlocked,
  maybeAutoRecharge: recharge.maybeAutoRecharge,
  notify: notify.notify,
  checkThresholdsAndNotify: notify.checkThresholdsAndNotify,
  processBillingSweep: sweep.processBillingSweep,
  aggregateByOrg: sweep.aggregateByOrg,
};
