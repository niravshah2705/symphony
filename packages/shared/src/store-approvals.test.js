'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate the JSON store to a temp dir BEFORE requiring config/store — DATA_DIR is
// resolved from this env var at module load. Never touch the real data/store.json
// (it holds live secrets).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'store-approvals-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;

const store = require('./store');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test('DEFAULT_AGENT_CONFIG carries a 2-hour evaluation approval wait default', () => {
  assert.equal(store.DEFAULT_AGENT_CONFIG.evaluationApprovalWaitMinutes, 120);
});

test('addApprovalGate stamps a gate_ id + timestamps and persists the record', () => {
  const rec = store.addApprovalGate({ requirement: 'ship a booking tool', status: 'awaiting-approval', signal: 'amber' });
  assert.match(rec.id, /^gate_[0-9a-f-]{36}$/);
  assert.ok(rec.createdAt && rec.updatedAt);
  assert.equal(store.getApprovalGate(rec.id).requirement, 'ship a booking tool');
});

test('updateApprovalGate patches immutably and never overwrites id/createdAt', () => {
  const rec = store.addApprovalGate({ requirement: 'y', status: 'awaiting-approval' });
  const before = store.getApprovalGate(rec.id);
  const updated = store.updateApprovalGate(rec.id, { status: 'proceeded', id: 'HACK', createdAt: 'HACK' });
  assert.equal(updated.id, rec.id);
  assert.equal(updated.createdAt, rec.createdAt);
  assert.equal(updated.status, 'proceeded');
  assert.equal(before.status, 'awaiting-approval'); // prior snapshot unchanged
  assert.equal(store.updateApprovalGate('gate_missing', { status: 'x' }), null);
});

test('listApprovalGates filters by status and businessId', () => {
  store.addApprovalGate({ requirement: 'a', status: 'awaiting-approval', businessId: 'biz_z' });
  store.addApprovalGate({ requirement: 'b', status: 'proceeded', businessId: 'biz_z' });
  const awaiting = store.listApprovalGates({ status: 'awaiting-approval' });
  assert.ok(awaiting.length >= 1);
  assert.ok(awaiting.every((g) => g.status === 'awaiting-approval'));
  const byBiz = store.listApprovalGates({ businessId: 'biz_z' });
  assert.ok(byBiz.length >= 2);
  assert.ok(byBiz.every((g) => g.businessId === 'biz_z'));
});

test('addApprovalGate caps the collection at MAX_APPROVAL_GATES (oldest dropped)', () => {
  for (let i = 0; i < store.MAX_APPROVAL_GATES + 25; i += 1) {
    store.addApprovalGate({ requirement: `cap-${i}`, status: 'awaiting-approval' });
  }
  assert.equal(store.listApprovalGates().length, store.MAX_APPROVAL_GATES);
});
