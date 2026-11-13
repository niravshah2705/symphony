'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// The env is set BEFORE anything is required, because CONFIG is a snapshot taken
// at require time: this file proves the wiring that only exists when FlexPrice is
// on, and no other file in the suite can see it. A separate process per test file
// is what makes that possible — flipping CONFIG afterwards would prove nothing.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-outbox-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.STORE_BACKEND = 'file';
process.env.USD_TO_INR = '100';
process.env.FLEET_ORG_ID = 'org-wire';
process.env.FLEXPRICE_ENABLED = 'true';
process.env.FLEXPRICE_API_KEY_INGEST = 'fp_ingest_wiring';
process.env.FLEXPRICE_API_KEY_MONEY = 'fp_money_wiring';

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const store = require('../store');
const outbox = require('./billing-outbox');
const { recordUsage } = require('./usage');

function rows(runId) {
  return store.listBillingOutboxRows({}).filter((r) => r.runId === runId);
}

test('recordUsage is the moment a cost becomes a delivery obligation', () => {
  assert.equal(outbox.isEnabled(), true);
  const rec = recordUsage(
    { projectId: 'p1', userId: 'u1', runId: 'run-wire-1' },
    { usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }, costUsd: 0.03 },
    { provider: 'claude', model: 'c-1' },
  );
  assert.equal(rec.costPaise, 300);

  const [row] = rows('run-wire-1');
  assert.ok(row, 'the run that was metered must also be queued');
  assert.equal(row.orgId, 'org-wire');
  assert.equal(row.quantityPaise, rec.costPaise);
  assert.equal(row.meter, 'llm-cost');
  assert.equal(row.status, 'pending');
  assert.equal(row.idempotencyKey, 'ev:org-wire:run-wire-1:llm-cost');
});

test('the queued quantity is the number the record carries, not a re-derivation', () => {
  // Two computations of one cost would be two chances to disagree, and the
  // FlexPrice balance would then diverge from our own usage page for reasons no
  // reconciler can explain.
  const rec = recordUsage(
    { runId: 'run-wire-2' },
    { usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 }, costUsd: 0.0175 },
    { provider: 'claude', model: 'c-1' },
  );
  const [row] = rows('run-wire-2');
  assert.equal(row.quantityPaise, rec.costPaise);
  assert.ok(Number.isInteger(row.quantityPaise));
});

test('a run on the org’s own key consumed value but billed none, so it queues none', () => {
  const rec = recordUsage(
    { runId: 'run-wire-3', providerSource: 'customer' },
    { usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }, costUsd: 0.03 },
    { provider: 'claude', model: 'c-1' },
  );
  assert.equal(rec.costPaise, 0);
  assert.equal(rec.notionalCostPaise, 300);
  assert.equal(rows('run-wire-3').length, 0);
});

test('a run with no tokens is not recorded and not queued', () => {
  assert.equal(recordUsage({ runId: 'run-wire-4' }, { usage: {} }, { provider: 'claude' }), null);
  assert.equal(rows('run-wire-4').length, 0);
});

test('metering never awaits the network, so a FlexPrice outage cannot fail a run', () => {
  const original = store.addBillingOutboxRow;
  store.addBillingOutboxRow = () => { throw new Error('ingest is down'); };
  try {
    const rec = recordUsage(
      { runId: 'run-wire-5' },
      { usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, costUsd: 0.01 },
      { provider: 'claude', model: 'c-1' },
    );
    assert.ok(rec, 'the usage record still posts');
    assert.equal(rows('run-wire-5').length, 0);
  } finally {
    store.addBillingOutboxRow = original;
  }
});
