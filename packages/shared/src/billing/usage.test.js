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
const { recordUsage } = require('./usage');

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
