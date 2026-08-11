'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('./approval-gate');

// In-memory store double mirroring the real store's approval-gate contract:
// generated id, stamped createdAt/updatedAt, immutable patch preserving id/createdAt.
function makeStore(businesses = []) {
  const gates = [];
  let counter = 0;
  return {
    _gates: gates,
    addApprovalGate(record) {
      counter += 1;
      const now = new Date().toISOString();
      const rec = { ...record, id: `gate_test-${counter}`, createdAt: now, updatedAt: now };
      gates.unshift(rec);
      return rec;
    },
    getApprovalGate(id) { return gates.find((g) => g.id === id) || null; },
    updateApprovalGate(id, patch) {
      const idx = gates.findIndex((g) => g.id === id);
      if (idx === -1) return null;
      gates[idx] = { ...gates[idx], ...patch, id: gates[idx].id, createdAt: gates[idx].createdAt, updatedAt: new Date().toISOString() };
      return gates[idx];
    },
    listApprovalGates(filter = {}) {
      return gates.filter((g) => (!filter.status || g.status === filter.status) && (!filter.businessId || g.businessId === filter.businessId));
    },
    readStore() { return { businesses }; },
  };
}

// Common deps: a fake store plus spy-able prepare/memory/settings seams.
function makeDeps(store, overrides = {}) {
  const calls = { prepare: [], memory: [] };
  return {
    calls,
    deps: {
      store,
      prepareBusiness: async (args) => { calls.prepare.push(args); return { scheduler: { jobId: 'job-x' } }; },
      saveMemory: (record) => { calls.memory.push(record); return { ...record, id: `mem-${calls.memory.length}` }; },
      getSettings: () => ({}),
      getAssumedRole: () => null,
      resolveBusiness: () => null,
      ...overrides,
    },
  };
}

test('createGate sets deadline = createdAt + waitMinutes exactly and starts awaiting', () => {
  const store = makeStore();
  const g = gate.createGate({ requirement: 'x', businessId: 'biz_z', signal: 'amber', waitMinutes: 120 }, { store });
  assert.equal(g.status, 'awaiting-approval');
  assert.equal(Date.parse(g.deadline) - Date.parse(g.createdAt), 120 * 60 * 1000);
  assert.equal(g.attempts, 0);
});

test('sweepExpiredGates auto-approves a past-deadline gate once and documents the decision', async () => {
  const store = makeStore();
  const { calls, deps } = makeDeps(store);
  const g = gate.createGate({ requirement: 'ship it', businessId: 'biz_z', signal: 'amber', waitMinutes: 1 }, { store });
  store.updateApprovalGate(g.id, { deadline: new Date(Date.now() - 1000).toISOString() }); // force past

  await gate.sweepExpiredGates(Date.now(), deps);

  const after = store.getApprovalGate(g.id);
  assert.equal(after.status, 'proceeded');
  assert.equal(after.decision.by, 'timeout');
  assert.equal(after.jobId, 'job-x');
  assert.equal(calls.prepare.length, 1);
  assert.equal(calls.memory.length, 1);
  assert.equal(calls.memory[0].source, 'approval-gate');
  assert.equal(calls.memory[0].scope, 'business');
});

test('sweepExpiredGates leaves a gate whose deadline is still in the future', async () => {
  const store = makeStore();
  const { calls, deps } = makeDeps(store);
  const g = gate.createGate({ requirement: 'later', signal: 'amber', waitMinutes: 120 }, { store });
  await gate.sweepExpiredGates(Date.now(), deps);
  assert.equal(store.getApprovalGate(g.id).status, 'awaiting-approval');
  assert.equal(calls.prepare.length, 0);
});

test('proceedGate is idempotent — prepareBusiness runs once across repeated calls', async () => {
  const store = makeStore();
  const { calls, deps } = makeDeps(store);
  const g = gate.createGate({ requirement: 'once', signal: 'amber', waitMinutes: 1 }, { store });
  const first = await gate.proceedGate(g, { by: 'human', note: 'ok' }, deps);
  const second = await gate.proceedGate(g, { by: 'human', note: 'ok' }, deps);
  assert.equal(calls.prepare.length, 1);
  assert.equal(first.alreadyProceeded, undefined);
  assert.equal(second.alreadyProceeded, true);
  assert.equal(store.getApprovalGate(g.id).status, 'proceeded');
});

test('approveGate proceeds a human decision; a non-awaiting or missing gate throws GateError', async () => {
  const store = makeStore();
  const { deps } = makeDeps(store);
  const g = gate.createGate({ requirement: 'a', signal: 'red', waitMinutes: 1 }, { store });
  const res = await gate.approveGate(g.id, deps);
  assert.equal(res.gate.status, 'proceeded');
  assert.equal(res.gate.decision.by, 'human');
  await assert.rejects(() => gate.approveGate(g.id, deps), (e) => e.name === 'GateError' && e.status === 409);
  await assert.rejects(() => gate.approveGate('gate_missing', deps), (e) => e.status === 404);
});

test('sweepExpiredGates recovers gates decided but not yet proceeded (crash between)', async () => {
  const store = makeStore();
  const { calls, deps } = makeDeps(store);
  const g = gate.createGate({ requirement: 'crash', signal: 'amber', waitMinutes: 120 }, { store }); // future deadline
  store.updateApprovalGate(g.id, { status: 'auto-approved', decidedAt: new Date().toISOString(), decision: { by: 'timeout', note: 'x' }, proceededAt: null });

  await gate.sweepExpiredGates(Date.now(), deps);

  const after = store.getApprovalGate(g.id);
  assert.equal(after.status, 'proceeded'); // re-driven despite future deadline
  assert.equal(calls.prepare.length, 1);
});

test('reevaluateGate supersedes the old gate; green returns no gate, amber creates a fresh one with attempts+1', async () => {
  const store = makeStore();
  const g1 = gate.createGate({ requirement: 'vague', businessId: 'biz_z', signal: 'red', waitMinutes: 60 }, { store });
  const green = await gate.reevaluateGate(g1.id, 'a very clear requirement', {
    store,
    evaluateRequirement: async () => ({ blocked: false, goal: 'clear', signal: 'green', evaluation: { signal: 'green' } }),
    getSettings: () => ({}),
  });
  assert.equal(green.signal, 'green');
  assert.equal(green.gate, null);
  assert.equal(store.getApprovalGate(g1.id).status, 'superseded');

  const g2 = gate.createGate({ requirement: 'still vague', businessId: 'biz_z', signal: 'red', waitMinutes: 60 }, { store });
  const amber = await gate.reevaluateGate(g2.id, 'somewhat clearer', {
    store,
    evaluateRequirement: async () => ({ blocked: false, goal: 'clearer', signal: 'amber', evaluation: { signal: 'amber' } }),
    getSettings: () => ({}),
  });
  assert.equal(amber.signal, 'amber');
  assert.ok(amber.gate);
  assert.equal(amber.gate.attempts, 1);
  assert.equal(amber.gate.waitMinutes, 60); // inherits the wait from the superseded gate
  assert.equal(store.getApprovalGate(g2.id).status, 'superseded');
});

test('gate lifecycle preserves native context and publishes only to that workspace', async () => {
  const store = makeStore();
  const published = [];
  const { calls, deps } = makeDeps(store, {
    publishGate: (...args) => published.push(args),
  });
  const created = gate.createGate({
    requirement: 'scoped', signal: 'amber', waitMinutes: 60,
    orgId: 'org-a', nativeProjectId: 'project-a',
  }, { store });
  assert.equal(created.orgId, 'org-a');
  assert.equal(created.nativeProjectId, 'project-a');

  await gate.approveGate(created.id, deps);
  assert.equal(calls.prepare[0].orgId, 'org-a');
  assert.equal(calls.prepare[0].nativeProjectId, 'project-a');
  assert.equal(calls.memory[0].orgId, 'org-a');
  assert.equal(calls.memory[0].nativeProjectId, 'project-a');
  assert.deepEqual(published.at(-1), [created.id, 'proceeded', {
    organizationId: 'org-a', projectId: 'project-a',
  }]);
});

test('default business resolution selects only the gate workspace when ids collide', async () => {
  const store = makeStore([
    { id: 'duplicate', name: 'Org A', orgId: 'org-a', nativeProjectId: 'project-a' },
    { id: 'duplicate', name: 'Org B', orgId: 'org-b', nativeProjectId: 'project-b' },
  ]);
  let selected = null;
  const created = gate.createGate({
    requirement: 'scoped business', businessId: 'duplicate', signal: 'amber',
    orgId: 'org-b', nativeProjectId: 'project-b',
  }, { store });

  await gate.proceedGate(created, { by: 'human' }, {
    store,
    prepareBusiness: async ({ business }) => { selected = business; return {}; },
    saveMemory: () => null,
    getSettings: () => ({}),
    getAssumedRole: () => null,
    publishGate: () => {},
  });

  assert.equal(selected.name, 'Org B');
});
