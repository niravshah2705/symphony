'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'core-billing-recharge-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.INITIAL_CREDIT_INR = '0';

const store = require('../store');
const ledger = require('./ledger');
const cashfreeClient = require('./cashfree-client');
const { maybeAutoRecharge, lastChargeGateMs } = require('./recharge');

const COOLDOWN_MS = 60 * 60 * 1000;

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

function belowThreshold(orgId, debitPaise) {
  ledger.ensureAccount(orgId);
  ledger.postEntry(orgId, { type: 'usage', amountPaise: -debitPaise, description: 'synthetic debit' });
  store.upsertBillingAccount(orgId, {
    autoRecharge: { enabled: true, mode: 'amount', thresholdPaise: 0, amountPaise: debitPaise, lastRechargedAt: null },
  });
}

// The stamp and the credit are one sequence: the Cashfree charge has already
// been captured by the time they run, so a recharge that credits the wallet but
// does not persist lastRechargedAt re-charges the customer on the next tick.
test('an auto-recharge credits the wallet and persists the cooldown stamp', async () => {
  belowThreshold('org-rc-1', 500);
  const t0 = Date.now();

  const result = await maybeAutoRecharge('org-rc-1', t0);

  assert.ok(result, 'a recharge is returned');
  assert.equal(result.entry.type, 'auto_recharge');
  const account = store.getBillingAccount('org-rc-1');
  assert.equal(account.balancePaise, 0, '-500 debit + 500 credit');
  assert.equal(account.autoRecharge.lastRechargedAt, new Date(t0).toISOString());
});

test('a persistently low balance is not recharged again inside the cooldown', async () => {
  belowThreshold('org-rc-2', 500);
  const t0 = Date.now();
  assert.ok(await maybeAutoRecharge('org-rc-2', t0));

  ledger.postEntry('org-rc-2', { type: 'usage', amountPaise: -1000, description: 'more usage' });
  assert.equal(await maybeAutoRecharge('org-rc-2', t0 + COOLDOWN_MS - 1), null);
  assert.ok(await maybeAutoRecharge('org-rc-2', t0 + COOLDOWN_MS + 1));
});

// --- the Cashfree charge branch ------------------------------------------------
// The bug: this branch read `chargeRes.status`, but /subscriptions/pay answers
// with `payment_status`. Every successful charge therefore looked like a
// failure, so `lastRechargedAt` never stamped, the cooldown never engaged and
// the customer was re-charged on every tick — while the wallet was never
// credited. These tests pin the whole sequence.

function mandanted(orgId, debitPaise) {
  belowThreshold(orgId, debitPaise);
  const cfg = store.getBillingAccount(orgId).autoRecharge;
  store.upsertBillingAccount(orgId, {
    autoRecharge: { ...cfg, thresholdPaise: 40000, amountPaise: debitPaise, cashfreeSubscriptionId: 'sub_test_1' },
  });
}

async function withChargeStub(orgId, impl, run) {
  const prevAppId = process.env.CASHFREE_APP_ID;
  const prevSecret = process.env.CASHFREE_SECRET_KEY;
  const realCharge = cashfreeClient.chargeSubscription;
  const calls = [];
  process.env.CASHFREE_APP_ID = 'TEST_stub';
  process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_stub';
  cashfreeClient.chargeSubscription = async (input) => {
    calls.push(input);
    return impl(input);
  };
  try {
    return await run(calls);
  } finally {
    cashfreeClient.chargeSubscription = realCharge;
    if (prevAppId !== undefined) process.env.CASHFREE_APP_ID = prevAppId; else delete process.env.CASHFREE_APP_ID;
    if (prevSecret !== undefined) process.env.CASHFREE_SECRET_KEY = prevSecret; else delete process.env.CASHFREE_SECRET_KEY;
  }
}

test('a SUCCESS payment_status credits the wallet and stamps the cooldown', async () => {
  mandanted('org-rc-paid', 50000);
  const t0 = Date.now();

  const result = await withChargeStub('org-rc-paid', () => ({ payment_status: 'SUCCESS', payment_id: 'x' }), () => maybeAutoRecharge('org-rc-paid', t0));

  assert.ok(result, 'the recharge is returned');
  assert.equal(result.entry.amountPaise, 50000);
  const account = store.getBillingAccount('org-rc-paid');
  assert.equal(account.autoRecharge.lastRechargedAt, new Date(t0).toISOString());
  assert.equal(account.autoRecharge.lastAttemptedAt, undefined, 'a settled charge needs no attempt stamp');
  assert.equal(lastChargeGateMs(account.autoRecharge), t0);
});

test('a PAID status and a bare `status` field are both accepted', async () => {
  for (const [orgId, response] of [['org-rc-paid-alias', { status: 'SUCCESS' }], ['org-rc-paid-upi', { payment_status: 'PAID' }]]) {
    mandanted(orgId, 50000);
    const result = await withChargeStub(orgId, () => response, () => maybeAutoRecharge(orgId, Date.now()));
    assert.ok(result, `${JSON.stringify(response)} settles`);
  }
});

test('an unsettled charge credits nothing and blocks a retry for the cooldown', async () => {
  mandanted('org-rc-failed', 50000);
  const t0 = Date.now();

  const result = await withChargeStub('org-rc-failed', () => ({ payment_status: 'FAILED' }), () => maybeAutoRecharge('org-rc-failed', t0));
  assert.equal(result, null);
  const account = store.getBillingAccount('org-rc-failed');
  assert.equal(account.balancePaise, -50000, 'no credit posted for a failed charge');
  assert.equal(account.autoRecharge.lastRechargedAt, null);
  assert.equal(account.autoRecharge.lastAttemptedAt, new Date(t0).toISOString());

  let chargedAgain = false;
  await withChargeStub('org-rc-failed', () => { chargedAgain = true; return { payment_status: 'SUCCESS' }; }, async () => {
    assert.equal(await maybeAutoRecharge('org-rc-failed', t0 + 1000), null, 'the attempt stamp gates the retry');
  });
  assert.equal(chargedAgain, false);

  // After the window the balance is still low, so it does try again.
  const later = await withChargeStub('org-rc-failed', () => ({ payment_status: 'SUCCESS' }), () => maybeAutoRecharge('org-rc-failed', t0 + COOLDOWN_MS + 1));
  assert.ok(later, 'the cooldown lapse re-enables the recharge');
});

test('a missing status is treated as unsettled, not as a silent success', async () => {
  mandanted('org-rc-empty', 50000);
  const result = await withChargeStub('org-rc-empty', () => ({}), () => maybeAutoRecharge('org-rc-empty', Date.now()));
  assert.equal(result, null, 'an unrecognised response must not credit the wallet');
  assert.ok(store.getBillingAccount('org-rc-empty').autoRecharge.lastAttemptedAt, 'the attempt is stamped');
});

test('a thrown charge stamps the attempt too', async () => {
  mandanted('org-rc-threw', 50000);
  const t0 = Date.now();
  const result = await withChargeStub('org-rc-threw', () => { throw new Error('Cashfree error (500): upstream'); }, () => maybeAutoRecharge('org-rc-threw', t0));
  assert.equal(result, null);
  assert.equal(store.getBillingAccount('org-rc-threw').autoRecharge.lastAttemptedAt, new Date(t0).toISOString());
});

test('the payment id is stable inside one cooldown window', async () => {
  mandanted('org-rc-payid', 50000);
  const windowStart = Math.floor(Date.now() / COOLDOWN_MS) * COOLDOWN_MS;
  const calls = await withChargeStub('org-rc-payid', () => ({ payment_status: 'FAILED' }), async (acc) => {
    await maybeAutoRecharge('org-rc-payid', windowStart + 1000);
    // Clear the attempt stamp so a second call in the same window can charge.
    const cfg = store.getBillingAccount('org-rc-payid').autoRecharge;
    store.upsertBillingAccount('org-rc-payid', { autoRecharge: { ...cfg, lastAttemptedAt: null, lastRechargedAt: null } });
    await maybeAutoRecharge('org-rc-payid', windowStart + 60000);
    return acc;
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].paymentId, calls[1].paymentId, 'same window, same id');
  assert.equal(calls[0].paymentId, `pay_org-rc-payid_${Math.floor(windowStart / COOLDOWN_MS)}`);
});
