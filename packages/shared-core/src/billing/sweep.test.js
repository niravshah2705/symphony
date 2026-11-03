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
