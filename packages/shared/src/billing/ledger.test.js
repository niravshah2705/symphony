'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate the JSON store + set deterministic billing config BEFORE config/store load.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-ledger-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.INITIAL_CREDIT_INR = '500';

const store = require('../store');
const ledger = require('./ledger');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test('ensureAccount records config and moves no money', () => {
  const a = ledger.ensureAccount('org-1');
  // The opening credit is a number the percentage-mode trigger multiplies, not a
  // balance: the spendable one lives in the FlexPrice wallet (billing/gate.js).
  assert.equal(a.initialCreditPaise, 50000);
  assert.equal(a.balancePaise, undefined, 'an account must not carry a balance');
  assert.equal(a.currency, 'INR');
  assert.deepEqual(a.alertThresholdsPaise, [10000, 0]);
  assert.equal(a.lastAlertedThresholdPaise, null);
  assert.deepEqual(a.autoRecharge, {
    enabled: false, mode: 'amount', thresholdPaise: 0, thresholdPercent: 20,
    amountPaise: 50000, cashfreeSubscriptionId: null, paymentMethodType: null,
  });
  assert.deepEqual(a.notifyChannels, { browser: true, email: false, slack: false });
  assert.deepEqual(a.paymentInfo, {
    billingName: '', billingEmail: '', billingPhone: '', taxId: '', address: null, updatedAt: null,
  });
  assert.equal(store.listLedgerEntries({ orgId: 'org-1' }).length, 0, 'creating an account credits nothing');
});

test('ensureAccount is idempotent and does not rewrite an existing account', () => {
  ledger.ensureAccount('org-2');
  store.upsertBillingAccount('org-2', { initialCreditPaise: 100 });
  const again = ledger.ensureAccount('org-2');
  assert.equal(again.initialCreditPaise, 100, 'a configured value is not reset by a page load');
  assert.equal(store.listLedgerEntries({ orgId: 'org-2' }).length, 0);
});

// The money semantics this module used to own are gone, and a function creeping
// back would quietly create a second balance again — which is the bug, not a
// refactor. See docs/BILLING_FLEXPRICE.md §10.
test('the local balance arithmetic is gone', () => {
  for (const name of ['postEntry', 'refreshBalance', 'balanceFromLedger', 'currentBalancePaise']) {
    assert.equal(ledger[name], undefined, `ledger.${name} must not come back`);
  }
});

test('a new account gets the alert policy defaults, not a copy of the constants', () => {
  ledger.ensureAccount('org-3');
  const a = store.getBillingAccount('org-3');
  assert.deepEqual(a.alertThresholdsPaise, [...ledger.DEFAULT_ALERT_THRESHOLDS_PAISE]);
  assert.deepEqual(a.autoRecharge, { ...ledger.DEFAULT_AUTO_RECHARGE });
  assert.deepEqual(a.paymentInfo, { ...ledger.DEFAULT_PAYMENT_INFO });
  a.alertThresholdsPaise.push(1);
  a.autoRecharge.enabled = true;
  assert.deepEqual(ledger.DEFAULT_AUTO_RECHARGE, {
    enabled: false, mode: 'amount', thresholdPaise: 0, thresholdPercent: 20,
    amountPaise: 50000, cashfreeSubscriptionId: null, paymentMethodType: null,
  }, 'one org editing its config must not edit every org’s defaults');
});
