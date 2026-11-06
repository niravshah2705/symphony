'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'core-billing-sweep-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.BILLING_SWEEP_ENABLED = 'true';
process.env.INITIAL_CREDIT_INR = '500';
process.env.USD_TO_INR = '100';
process.env.FLEET_ORG_ID = 'org-core-sweep';

const store = require('../store');
const { CONFIG } = require('../config');
const ledger = require('./ledger');
const { recordUsage } = require('./usage');
const { processBillingSweep } = require('./sweep');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

function usageDebits() {
  return store.listLedgerEntries({ orgId: 'org-core-sweep' }).filter((e) => e.type === 'usage');
}

test('a sweep advances the watermark it reports', async () => {
  recordUsage({ projectId: 'p1', taskId: 't1', source: 'coder' },
    { usage: { inputTokens: 100000, outputTokens: 20000, totalTokens: 120000 }, costUsd: 0.10 },
    { provider: 'claude' });
  const now = new Date().toISOString();

  const result = await processBillingSweep({ now, nowMs: Date.parse(now) });

  assert.equal(result.watermark, now);
  assert.equal(store.getBillingState().lastAggregatedAt, now, 'the watermark must persist');
  assert.equal(usageDebits().length, 1);
  const spentPaise = store.listUsageRecords({ orgId: 'org-core-sweep' })
    .reduce((sum, r) => sum + (Number(r.costPaise) || 0), 0);
  assert.equal(usageDebits()[0].amountPaise, -spentPaise, 'one debit covering every run in the window');
});

// Without a persisted watermark every tick re-reads the same usage records and
// posts the debit again, so the org is charged once per minute per run.
test('a second sweep over the same usage records posts no further debit', async () => {
  const later = new Date(Date.parse(store.getBillingState().lastAggregatedAt) + 1000).toISOString();

  const result = await processBillingSweep({ now: later, nowMs: Date.parse(later) });

  assert.equal(result.aggregatedOrgs, 0);
  assert.equal(usageDebits().length, 1, 'usage already swept is never swept twice');
});

test('a zero-cost (local) run refreshes the snapshot without posting a debit', async () => {
  const orgId = 'org-core-sweep-local';
  const rec = recordUsage({ orgId, projectId: 'p-local', taskId: 't-local', source: 'coder' },
    { usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }, costUsd: 0 },
    { provider: 'ollama' });
  assert.ok(rec, 'a free run is still metered');
  // Window the sweep so this record alone is in it: start just after the newest
  // previously-swept record rather than moving the watermark backwards.
  const prior = store.listUsageRecords().filter((r) => r.createdAt !== rec.createdAt)
    .map((r) => r.createdAt).sort().pop() || '';
  store.setBillingState({ lastAggregatedAt: prior });
  const now = new Date(Date.parse(rec.createdAt) + 1000).toISOString();

  const result = await processBillingSweep({ now, nowMs: Date.parse(now) });

  assert.ok(result.aggregatedOrgs >= 1, 'the free run is grouped');
  const entries = store.listLedgerEntries({ orgId });
  assert.equal(entries.filter((e) => e.type === 'usage').length, 0, 'a free run adds no ledger line');
  // ensureAccount seeded the initial credit and refreshBalance recomputed it, so
  // the snapshot heals from the ledger instead of sticking at whatever was cached.
  assert.equal(store.getBillingAccount(orgId).balancePaise, CONFIG.BILLING.initialCreditPaise);
});

// The sweep used to loop every account calling maybeAutoRecharge, on a 5-minute
// scheduler tick and on every planner tick. A money path that fires on a cadence
// belongs in the scheduled auto-recharge job, which validates before charging.
test('the sweep never auto-recharges, however low the balance is', async () => {
  const orgId = 'org-core-sweep-recharge';
  ledger.ensureAccount(orgId);
  ledger.postEntry(orgId, { type: 'usage', amountPaise: -50000, description: 'big spend' });
  store.upsertBillingAccount(orgId, {
    autoRecharge: { enabled: true, mode: 'amount', thresholdPaise: 40000, amountPaise: 50000, lastRechargedAt: null },
  });
  const now = new Date(Date.parse(store.getBillingState().lastAggregatedAt) + 3000).toISOString();

  await processBillingSweep({ now, nowMs: Date.parse(now) });

  const entries = store.listLedgerEntries({ orgId });
  assert.equal(entries.filter((e) => e.type === 'auto_recharge').length, 0, 'no charge from the tick');
  assert.equal(store.getBillingAccount(orgId).autoRecharge.lastRechargedAt, null);
});

// The whole bring-your-own-key promise, in one assertion: real tokens, a real
// price, and nothing debited. The sweep adds to `costPaise` only, so a customer
// run contributing 0 is what keeps the org's balance away from money the platform
// never spent — and the notional figure it does carry stays out of the ledger.
test('a customer-key run posts no debit and leaves the balance untouched', async () => {
  const orgId = 'org-core-sweep-byok';
  ledger.ensureAccount(orgId);
  const before = store.getBillingAccount(orgId).balancePaise;
  const rec = recordUsage({ orgId, source: 'coder', providerSource: 'customer' },
    { usage: { inputTokens: 100000, outputTokens: 20000, totalTokens: 120000 }, costUsd: 0.10 },
    { provider: 'claude' });
  assert.equal(rec.costPaise, 0);
  assert.equal(rec.notionalCostPaise, 1000, '0.10 USD × 100 INR/USD × 100 paise');

  // Widen the window to everything: this org owns exactly the one record above, so
  // any debit line for it would have to come from that run.
  store.setBillingState({ lastAggregatedAt: '' });
  const now = new Date(Date.parse(rec.createdAt) + 1000).toISOString();
  await processBillingSweep({ now, nowMs: Date.parse(now) });

  const entries = store.listLedgerEntries({ orgId });
  assert.equal(entries.filter((e) => e.type === 'usage').length, 0, 'a run on the org key posts no debit');
  assert.equal(store.getBillingAccount(orgId).balancePaise, before);
});
