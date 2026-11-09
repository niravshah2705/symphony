'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-usage-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.USD_TO_INR = '100';
process.env.FLEET_ORG_ID = 'org-usage';

const store = require('../store');
const { recordUsage, resolveBillingSource } = require('./usage');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test('recordUsage persists one record tagged with the deployment org + attribution', () => {
  const rec = recordUsage(
    { projectId: 'p1', projectName: 'Proj', userId: 'u1', taskId: 't1', taskIdentifier: 'ENG-1', source: 'coder' },
    { usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }, costUsd: 0.03 },
    { provider: 'claude', model: 'c-1' },
  );
  assert.ok(rec);
  assert.equal(rec.orgId, 'org-usage');
  assert.equal(rec.projectName, 'Proj');
  assert.equal(rec.taskIdentifier, 'ENG-1');
  assert.equal(rec.provider, 'claude');
  assert.equal(rec.costPaise, 300); // 0.03 × 100 × 100
  assert.equal(store.listUsageRecords({ orgId: 'org-usage' }).length, 1);
});

test('recordUsage skips empty runs (no tokens) to avoid ledger noise', () => {
  const before = store.listUsageRecords().length;
  const rec = recordUsage({ source: 'planner' }, { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, costUsd: 0 }, { provider: 'ollama' });
  assert.equal(rec, null);
  assert.equal(store.listUsageRecords().length, before);
});

test('recordUsage is fail-open: a bad result never throws', () => {
  assert.doesNotThrow(() => recordUsage({ source: 'coder' }, null, null));
  assert.doesNotThrow(() => recordUsage(undefined, undefined, undefined));
});

// Bring-your-own-key: the run is metered in full but the platform never paid for
// it, so the chargeable field is zero and the same money is kept as notional. The
// visible zero is the product — if it were folded into costPaise the org could not
// tell a free run from one it had already paid Anthropic for.
test('a customer-key run is recorded at zero charge with its value kept as notional', () => {
  const rec = recordUsage(
    { projectId: 'p-byok', source: 'coder', providerSource: 'customer' },
    { usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }, costUsd: 0.03 },
    { provider: 'claude', model: 'c-1' },
  );
  assert.equal(rec.billingSource, 'customer');
  assert.equal(rec.costPaise, 0, 'nothing to debit: the org paid the provider directly');
  assert.equal(rec.notionalCostPaise, 300);
  assert.equal(rec.costUsd, 0.03, 'the measurement survives; only the charge is zero');
});

test('a platform-key run charges in full and carries no notional figure', () => {
  const rec = recordUsage(
    { projectId: 'p-managed', source: 'coder', providerSource: 'managed' },
    { usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }, costUsd: 0.03 },
    { provider: 'claude', model: 'c-1' },
  );
  assert.equal(rec.billingSource, 'managed');
  assert.equal(rec.costPaise, 300);
  assert.equal(rec.notionalCostPaise, 0);
});

// A run that never carried the decision could only have used a platform key on the
// shared stack, and defaulting the other way would hand every run a free pass.
test('an unlabelled run meters as managed, never as free', () => {
  assert.equal(resolveBillingSource({}), 'managed');
  assert.equal(resolveBillingSource({ providerSource: null }), 'managed');
  assert.equal(resolveBillingSource({ providerSource: ' CuStOmEr ' }), 'customer');
  assert.equal(resolveBillingSource({ providerSource: 'whatever-else' }), 'managed');
  const rec = recordUsage(
    { projectId: 'p-legacy', source: 'coder' },
    { usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 }, costUsd: 0.02 },
    { provider: 'claude' },
  );
  assert.equal(rec.billingSource, 'managed');
  assert.equal(rec.costPaise, 200);
});

test('usage records filter by billing source, and legacy rows read as managed', () => {
  const orgId = 'org-source-filter';
  recordUsage({ orgId, providerSource: 'customer' },
    { usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, costUsd: 0.01 }, { provider: 'claude' });
  recordUsage({ orgId },
    { usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, costUsd: 0.01 }, { provider: 'claude' });
  const unlabeled = store.addUsageRecord({
    orgId, provider: 'claude', usage: { totalTokens: 10 }, costPaise: 100, createdAt: new Date().toISOString(),
  });
  assert.equal(unlabeled.billingSource, undefined, 'a pre-BYOK row really has no label');

  const customer = store.listUsageRecords({ orgId, billingSource: 'customer' });
  const managed = store.listUsageRecords({ orgId, billingSource: 'managed' });
  assert.equal(customer.length, 1);
  assert.equal(managed.length, 2, 'the labelled run and the unlabelled legacy row are both managed spend');
  assert.equal(customer.length + managed.length, 3);
});
