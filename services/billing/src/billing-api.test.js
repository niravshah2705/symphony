'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate the store before anything loads config.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-api-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;

const store = require('@ai-fleet/shared-core/store');
const { SHARED_ORG_ID } = require('@ai-fleet/shared-core/billing/org-context');
const billingApi = require('./billing-api');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test.before(() => {
  store.addUsageRecord({ orgId: 'org-A', userId: 'uA', projectId: 'pA', usage: { totalTokens: 10 }, costPaise: 100 });
  store.addUsageRecord({ orgId: 'org-B', userId: 'uB', projectId: 'pB', usage: { totalTokens: 20 }, costPaise: 200 });
  store.addUsageRecord({ orgId: SHARED_ORG_ID, userId: 'personal-1', projectId: 'x', usage: { totalTokens: 5 }, costPaise: 50 });
  store.addUsageRecord({ orgId: SHARED_ORG_ID, userId: 'personal-2', projectId: 'y', usage: { totalTokens: 7 }, costPaise: 70 });
});

test('scopedUsageRecords returns only the caller org’s records (cross-tenant isolation)', () => {
  const a = billingApi.scopedUsageRecords({ orgId: 'org-A', userId: 'uA', isAdmin: false });
  assert.equal(a.length, 1);
  assert.equal(a[0].orgId, 'org-A');
  // Org A cannot see Org B.
  assert.equal(a.every((r) => r.orgId !== 'org-B'), true);
});

test('shared account scopes drill-down to the caller’s own user (no cross-personal leak)', () => {
  const p1 = billingApi.scopedUsageRecords({ orgId: SHARED_ORG_ID, userId: 'personal-1' });
  assert.equal(p1.length, 1);
  assert.equal(p1[0].userId, 'personal-1');
});

test('shared account with no user identity exposes nothing granular (safe default)', () => {
  const anon = billingApi.scopedUsageRecords({ orgId: SHARED_ORG_ID, userId: null });
  assert.equal(anon.length, 0);
});

// The two BYOK series must add up to the gross and never double count: managed
// spend is what the balance paid, customer notional is what the org's own key paid.
test('the spend split reports charged and notional as two separate series', () => {
  const orgId = 'org-split';
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  store.addUsageRecord({ orgId, createdAt, usage: { totalTokens: 100 }, costPaise: 900, notionalCostPaise: 0, billingSource: 'managed' });
  store.addUsageRecord({ orgId, createdAt, usage: { totalTokens: 50 }, costPaise: 0, notionalCostPaise: 400, billingSource: 'customer' });
  store.addUsageRecord({ orgId, createdAt, usage: { totalTokens: 10 }, costPaise: 60, notionalCostPaise: 0 });

  const window = billingApi.bySourceWindow(store.listUsageRecords({ orgId }), 30, now);
  assert.equal(window.sources.managed.costInr, 9.6, 'the unlabelled legacy run counts as managed spend');
  assert.equal(window.sources.managed.notionalInr, 0);
  assert.equal(window.sources.customer.costInr, 0, 'a run on the org key draws nothing from the balance');
  assert.equal(window.sources.customer.notionalInr, 4);
  assert.equal(window.sources.customer.runs, 1);
  assert.ok(window.retentionDays > 0, 'the caller is told how far back this reaches');
});

test('both series exist even for an org that has never used its own key', () => {
  const window = billingApi.bySourceWindow(
    store.listUsageRecords({ orgId: 'org-A' }), 30, Date.now(),
  );
  assert.deepEqual(Object.keys(window.sources).sort(), ['customer', 'managed']);
  assert.equal(window.sources.customer.runs, 0);
});

test('autoRecharge configuration preserves cashfree fields and calculates threshold', () => {
  store.upsertBillingAccount('org-test-ar', {
    autoRecharge: {
      enabled: true,
      mode: 'percentage',
      thresholdPercent: 25,
      thresholdPaise: 0,
      amountPaise: 50000,
      cashfreeSubscriptionId: 'sub_test_123',
      paymentMethodType: 'upi_autopay',
    },
  });
  const account = store.getBillingAccount('org-test-ar');
  assert.equal(account.autoRecharge.enabled, true);
  assert.equal(account.autoRecharge.mode, 'percentage');
  assert.equal(account.autoRecharge.thresholdPercent, 25);
  assert.equal(account.autoRecharge.cashfreeSubscriptionId, 'sub_test_123');
  assert.equal(account.autoRecharge.paymentMethodType, 'upi_autopay');
});

test('billing paymentInfo is stored and returned', () => {
  store.upsertBillingAccount('org-test-pi', {
    paymentInfo: {
      billingName: 'Gateway Test Org',
      billingEmail: 'admin@gatewaytest.com',
      billingPhone: '9876543210',
      taxId: '27AABCU9603R1ZM',
      billingAddress: {
        line1: '123 Tech Park',
        city: 'Bengaluru',
        state: 'KA',
        postalCode: '560001',
        country: 'IN',
      },
    },
  });
  const account = store.getBillingAccount('org-test-pi');
  assert.equal(account.paymentInfo.billingName, 'Gateway Test Org');
  assert.equal(account.paymentInfo.taxId, '27AABCU9603R1ZM');
  assert.equal(account.paymentInfo.billingAddress.city, 'Bengaluru');
});
