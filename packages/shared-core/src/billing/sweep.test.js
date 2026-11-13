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
const { recordUsage } = require('./usage');
const sweep = require('./sweep');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test('a sweep reports the window, advances the watermark and moves no money', async () => {
  recordUsage({ projectId: 'p1', taskId: 't1', source: 'coder' },
    { usage: { inputTokens: 100000, outputTokens: 20000, totalTokens: 120000 }, costUsd: 0.10 },
    { provider: 'claude' });
  const now = new Date().toISOString();

  const result = await sweep.processBillingSweep({ now, nowMs: Date.parse(now) });

  assert.equal(result.watermark, now);
  assert.equal(store.getBillingState().lastAggregatedAt, now, 'the watermark must persist');
  assert.equal(result.aggregatedOrgs, 1);
  assert.equal(result.recordsProcessed, store.listUsageRecords({ orgId: 'org-core-sweep' }).length);
  assert.equal(store.listLedgerEntries().length, 0, 'the sweep posts nothing');
});

// Without a persisted watermark every tick re-reads the same usage records, which
// is what made the old aggregated debit charge an org once per tick per run.
test('a second sweep over the same usage records processes nothing', async () => {
  const later = new Date(Date.parse(store.getBillingState().lastAggregatedAt) + 1000).toISOString();

  const result = await sweep.processBillingSweep({ now: later, nowMs: Date.parse(later) });

  assert.equal(result.aggregatedOrgs, 0);
  assert.equal(result.recordsProcessed, 0, 'usage already swept is never swept twice');
  assert.equal(store.listLedgerEntries().length, 0);
});

test('aggregateByOrg sums paise and tokens per org', () => {
  const groups = sweep.aggregateByOrg([
    { orgId: 'a', costPaise: 100, usage: { totalTokens: 10 } },
    { orgId: 'a', costPaise: 50.5, usage: { totalTokens: 5 } },
    { orgId: 'b', costPaise: 0, usage: {} },
    { costPaise: 7 }, // no org → the shared stack, as before
  ]);
  assert.deepEqual(groups, [
    { orgId: 'a', costPaise: 150.5, tokens: 15, count: 2 },
    { orgId: 'b', costPaise: 0, tokens: 0, count: 1 },
    { orgId: '__shared__', costPaise: 7, tokens: 0, count: 1 },
  ]);
});

// The retention prune is still the sweep's job, and it is the reason `usageRecords`
// survived the deletion of the local ledger: a customer-key run has no other
// history of the value it consumed.
test('usage past the retention window is pruned', async () => {
  const orgId = 'org-core-sweep-old';
  const nowMs = Date.now();
  const retentionMs = CONFIG.BILLING.usageRetentionDays * 24 * 60 * 60 * 1000;
  const stale = new Date(nowMs - retentionMs - 60_000).toISOString();
  const rec = store.addUsageRecord({
    orgId, projectId: 'p-old', taskId: 't-old', source: 'coder',
    costPaise: 100, createdAt: stale, usage: { totalTokens: 1500 },
  });

  const result = await sweep.processBillingSweep({
    now: new Date(nowMs).toISOString(), nowMs,
  });

  assert.ok(result.pruned >= 1, 'the out-of-window row is dropped');
  assert.equal(store.listUsageRecords({ orgId }).find((r) => r.id === rec.id), undefined);
});

// The sweep used to loop every account calling maybeAutoRecharge, on a 5-minute
// scheduler tick and on every planner tick. A money path that fires on a cadence
// belongs in the scheduled auto-recharge job, which validates before charging.
test('the sweep holds no money path at all', () => {
  // A source gate, not a behaviour test: there is nothing left for the sweep to
  // do with money, so any re-introduction is the regression. `ledger.js`'s debit
  // primitives are gone too, which makes this the only check that can catch it.
  const source = fs.readFileSync(path.join(__dirname, 'sweep.js'), 'utf8');
  for (const banned of ['postEntry', 'refreshBalance', 'balanceFromLedger', 'maybeAutoRecharge', 'addLedgerEntry', 'topUpWallet']) {
    assert.doesNotMatch(source, new RegExp(banned), `sweep.js must not touch ${banned}`);
  }
  assert.doesNotMatch(source, /require\('\.\/ledger'\)/, 'sweep.js must not import the ledger');
});
