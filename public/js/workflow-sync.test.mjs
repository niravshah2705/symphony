import test from 'node:test';
import assert from 'node:assert/strict';

import * as model from './workflow-designer-model.mjs';
import { createWorkflowSync } from './workflow-sync.mjs';

const ORG = 'org-1';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function httpError(status, code, payload = null) {
  const error = new Error(code || `Request failed (${status})`);
  error.status = status;
  error.code = code;
  error.payload = payload;
  return error;
}

function networkError() {
  return new TypeError('Failed to fetch');
}

function graph(id, overrides = {}) {
  return {
    id,
    name: `Flow ${id}`,
    description: '',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{ id: `${id}-n1`, kind: 'agent', refId: 'planning', name: 'Plan', x: 0, y: 0 }],
    edges: [],
    ...overrides,
  };
}

function harness({ payload, client = {}, storage = memoryStorage(), organizationId = ORG, canWrite = true } = {}) {
  const calls = { get: 0, created: [], put: [], deleted: [], imported: [] };
  const api = {
    getWorkflows: async () => {
      calls.get += 1;
      if (client.get) return client.get(calls.get);
      return payload;
    },
    createWorkflow: async (graphBody) => {
      calls.created.push(graphBody);
      return client.created ? client.created(graphBody) : { ...graphBody, revision: 1 };
    },
    putWorkflow: async (id, graphBody, revision) => {
      calls.put.push({ id, graph: graphBody, revision });
      if (client.put) return client.put(id, graphBody, revision);
      return { ...graphBody, revision: (revision ?? 0) + 1 };
    },
    deleteWorkflow: async (id) => {
      calls.deleted.push(id);
      if (client.deleted) return client.deleted(id);
      return { ok: true };
    },
    importWorkflows: async (workflows) => {
      calls.imported.push(workflows);
      return client.imported ? client.imported(workflows) : { imported: workflows.length, workflows: workflows.map((w) => graph(w.id, { revision: 1 })) };
    },
  };
  const sync = createWorkflowSync({ client: api, model, storage, organizationId, canWrite });
  return { sync, calls, storage, api };
}

test('the client surface is required up front, not discovered mid-save', () => {
  assert.throws(() => createWorkflowSync({ client: null, model }), /workflows API client/);
  assert.throws(() => createWorkflowSync({ client: {}, model }), /workflows API client/);
  assert.throws(() => createWorkflowSync({ client: { getWorkflows: () => {} } }), /workflow model/);
});

test('load takes the tenant graphs, records revisions and caches a draft', async () => {
  const { sync, storage, calls } = harness({
    payload: {
      workflows: [graph('wf-a', { revision: 4 }), graph('wf-b', { revision: 2 })],
      persona: 'builder', grants: ['Planning'], gateTemplate: { cards: [] }, canAdminDefaults: false,
    },
  });
  const result = await sync.load();
  assert.equal(result.source, 'server');
  assert.deepEqual(result.state.workflows.map((w) => w.id), ['wf-a', 'wf-b']);
  assert.equal(sync.revisionOf('wf-a'), 4, 'the revision the server gave us must ride on the next PUT');
  assert.equal(sync.revisionOf('wf-b'), 2);
  assert.equal(result.context.persona, 'builder');
  assert.deepEqual(result.context.grants, ['Planning']);
  assert.equal(result.context.loaded, true);
  assert.ok(storage.data.size > 0, 'a successful load still writes the draft so an offline reload sees it');
  assert.equal(calls.imported.length, 0, 'a populated tenant must never trigger an import');
});

test('load carries a localStorage draft over exactly once, and only into an empty tenant', async () => {
  const seeded = memoryStorage();
  const draft = { schemaVersion: 1, activeWorkflowId: 'old-1', workflows: [graph('old-1')], customAgents: [], customContexts: [] };
  seeded.setItem(model.storageKeyForOrganization(ORG), model.serializeState(draft));

  const first = harness({ payload: { workflows: [] }, storage: seeded });
  const loaded = await first.sync.load();
  assert.equal(loaded.source, 'imported');
  assert.deepEqual(loaded.state.workflows.map((w) => w.id), ['old-1']);
  assert.equal(first.calls.imported.length, 1);
  assert.deepEqual(first.calls.imported[0].map((w) => w.id), ['old-1']);

  // The server owns the "only if empty" rule; if it declines we keep the server copy.
  const declined = harness({ payload: { workflows: [] }, client: { imported: () => ({ imported: 0, skipped: true, workflows: [] }) } });
  const declinedResult = await declined.sync.load();
  assert.equal(declinedResult.source, 'seed');
  assert.ok(declinedResult.state.workflows.length > 0, 'an empty tenant falls back to the built-in examples, not a blank canvas');
});

test('load survives an offline gateway with the local draft and flips back on success', async () => {
  const seeded = memoryStorage();
  const draft = { schemaVersion: 1, activeWorkflowId: 'old-1', workflows: [graph('old-1')], customAgents: [], customContexts: [] };
  seeded.setItem(model.storageKeyForOrganization(ORG), model.serializeState(draft));

  let online = false;
  const { sync } = harness({
    storage: seeded,
    client: { get: () => { if (!online) throw networkError(); return { workflows: [graph('new-1', { revision: 1 })] }; } },
  });

  const offline = await sync.load();
  assert.equal(offline.source, 'offline');
  assert.equal(sync.isOffline(), true);
  assert.deepEqual(offline.state.workflows.map((w) => w.id), ['old-1'], 'the draft is what the designer shows while offline');

  online = true;
  const back = await sync.load();
  assert.equal(back.source, 'server');
  assert.equal(sync.isOffline(), false);
});

test('an authorization failure propagates instead of being mistaken for being offline', async () => {
  const { sync } = harness({ client: { get: () => { throw httpError(403, 'persona_denied'); } } });
  await assert.rejects(() => sync.load(), /persona_denied/);
  assert.equal(sync.isOffline(), false);
});

test('an empty browser is not a draft: a fresh tenant falls back to the examples without importing', async () => {
  const { sync, calls } = harness({ payload: { workflows: [] } });
  const loaded = await sync.load();
  assert.equal(loaded.source, 'seed');
  assert.equal(calls.imported.length, 0, 'the built-in examples are not a localStorage draft to carry over');
  assert.ok(loaded.state.workflows.length > 0);
});

test('saving an example adopts the whole set in one import instead of creating each graph', async () => {
  const { sync, calls } = harness({ payload: { workflows: [] } });
  const loaded = await sync.load();
  const edited = { ...loaded.state, workflows: loaded.state.workflows.map((w, i) => (i ? w : { ...w, name: 'Adopted example' })) };

  const result = await sync.flush(edited);
  assert.equal(result.status, 'saved');
  assert.equal(calls.imported.length, 1, 'one transactional import, not N creates');
  assert.deepEqual(calls.created.map((g) => g.id), []);
  assert.equal(calls.imported[0].length, loaded.state.workflows.length);
  assert.ok(result.workflows.length > 0, 'the server copy is what the caller must reconcile against');
  assert.equal(sync.revisionOf(result.workflows[0].id), result.workflows[0].revision);

  // A second save is a normal revision-checked update, not another import.
  await sync.flush({ ...edited, workflows: edited.workflows.map((w, i) => (i ? w : { ...w, description: 'Adopted.' })) });
  assert.equal(calls.imported.length, 1);
  assert.deepEqual(calls.put.map((p) => p.id), [edited.workflows[0].id]);
  assert.equal(calls.put[0].revision, 1, 'the import gave us a revision, and the update must use it');
});

test('an import the server skips is surfaced as a conflict, not a silent save', async () => {
  const { sync } = harness({
    payload: { workflows: [] },
    client: { imported: () => ({ imported: 0, skipped: true, workflows: [graph('other-1', { revision: 3 })] }) },
  });
  const loaded = await sync.load();
  const result = await sync.flush(loaded.state);
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.serverWorkflows.map((w) => w.id), ['other-1'], 'the caller shows what the tenant actually has');
});

test('a read-only organization never writes, even from a stale local draft', async () => {
  const seeded = memoryStorage();
  const draft = { schemaVersion: 1, activeWorkflowId: 'old-1', workflows: [graph('old-1')], customAgents: [], customContexts: [] };
  seeded.setItem(model.storageKeyForOrganization(ORG), model.serializeState(draft));

  const { sync, calls } = harness({ payload: { workflows: [] }, storage: seeded, canWrite: false });
  await sync.load();
  assert.equal(calls.imported.length, 0, 'a member must not create tenant graphs by viewing them');

  const result = await sync.flush(draft);
  assert.equal(result.status, 'readonly');
  assert.deepEqual([calls.created.length, calls.put.length, calls.deleted.length], [0, 0, 0]);
});

test('a change that touches no graph content sends no request', async () => {
  const { sync, calls } = harness({
    payload: { workflows: [graph('wf-a', { revision: 4 }), graph('wf-b', { revision: 2 })] },
  });
  const loaded = await sync.load();

  // Switching the active workflow is a view change, not an edit of either graph.
  const switched = { ...loaded.state, activeWorkflowId: 'wf-b' };
  const result = await sync.flush(switched);
  assert.equal(result.status, 'saved');
  assert.deepEqual([calls.put.length, calls.created.length], [0, 0], 'a whole-collection write on every keystroke is not persistence');

  // The same flush with one edited graph sends exactly one revision-checked PUT.
  await sync.flush({ ...switched, workflows: switched.workflows.map((w) => (w.id === 'wf-b' ? { ...w, name: 'Renamed' } : w)) });
  assert.deepEqual(calls.put.map((p) => p.id), ['wf-b']);
  assert.equal(calls.put[0].revision, 2);
});

const debtKey = () => `${model.storageKeyForOrganization(ORG)}.pending`;

test('an edit interrupted before the push is re-sent on the next load, not rolled back', async () => {
  const storage = memoryStorage();
  const payload = { workflows: [graph('wf-a', { revision: 3 })] };

  let online = true;
  const first = harness({
    payload,
    storage,
    client: { put: () => { if (!online) throw networkError(); return { ...graph('wf-a'), revision: 4 }; } },
  });
  const loaded = await first.sync.load();
  online = false;
  const edited = { ...loaded.state, workflows: loaded.state.workflows.map((w) => ({ ...w, name: 'Renamed while offline' })) };
  assert.equal((await first.sync.flush(edited)).status, 'offline');
  assert.deepEqual(JSON.parse(storage.getItem(debtKey())).dirty, ['wf-a'], 'the debt is written before the request');

  // A new tab loads the tenant and finds the edit still owed.
  online = true;
  const second = harness({ payload, storage });
  const reloaded = await second.sync.load();
  assert.equal(reloaded.state.workflows.find((w) => w.id === 'wf-a').name, 'Renamed while offline');
  assert.deepEqual(second.calls.put.map((p) => p.id), ['wf-a']);
  assert.equal(second.calls.put[0].revision, 3, 'the re-send is still revision-checked');
  assert.equal(storage.getItem(debtKey()), null, 'an acknowledged debt is cleared');
});

test('a delete interrupted before the push survives the next load', async () => {
  const storage = memoryStorage();
  const payload = { workflows: [graph('wf-a', { revision: 1 }), graph('wf-b', { revision: 1 })] };

  const first = harness({ payload, storage, client: { deleted: () => { throw networkError(); } } });
  const loaded = await first.sync.load();
  const withoutB = { ...loaded.state, workflows: loaded.state.workflows.filter((w) => w.id !== 'wf-b') };
  first.sync.forget('wf-b');
  assert.equal((await first.sync.flush(withoutB)).status, 'offline');

  const second = harness({ payload, storage });
  const reloaded = await second.sync.load();
  assert.deepEqual(second.calls.deleted, ['wf-b']);
  assert.deepEqual(reloaded.state.workflows.map((w) => w.id), ['wf-a'], 'the deleted graph does not come back from the server copy');
  assert.equal(storage.getItem(debtKey()), null);
});

test('flush pushes edits with their revision and new graphs with a create', async () => {
  const { sync, calls } = harness({
    payload: { workflows: [graph('wf-a', { revision: 4 })] },
  });
  await sync.load();

  const state = { schemaVersion: 2, activeWorkflowId: 'wf-a', workflows: [graph('wf-a', { name: 'Renamed' }), graph('wf-new')], customAgents: [], customContexts: [] };
  const result = await sync.flush(state);

  assert.equal(result.status, 'saved');
  assert.deepEqual(calls.put.map((p) => p.id), ['wf-a']);
  assert.equal(calls.put[0].revision, 4, 'PUT must be revision-checked, not blind');
  assert.deepEqual(calls.created.map((g) => g.id), ['wf-new']);
  assert.equal(sync.revisionOf('wf-new'), 1, 'a created graph is tracked so the next flush updates it');
});

test('a conflicting revision stops the flush and hands back the server copy', async () => {
  const serverCopy = graph('wf-a', { name: 'Their edit', revision: 9 });
  const { sync, calls } = harness({
    payload: { workflows: [graph('wf-a', { revision: 4 })] },
    client: { put: () => { throw httpError(409, 'revision_conflict', { workflow: serverCopy }); } },
  });
  await sync.load();

  const state = { schemaVersion: 2, activeWorkflowId: 'wf-a', workflows: [graph('wf-a', { name: 'My edit' })], customAgents: [], customContexts: [] };
  const result = await sync.flush(state);

  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.serverWorkflow, serverCopy);
  assert.equal(calls.created.length, 0, 'we must not quietly re-create what we failed to update');
});

test('an offline flush keeps the draft and stops calling the gateway until reload', async () => {
  const state = { schemaVersion: 2, activeWorkflowId: 'wf-a', workflows: [graph('wf-a', { name: 'Offline edit' })], customAgents: [], customContexts: [] };
  const failing = harness({
    payload: { workflows: [graph('wf-a', { revision: 4 })] },
    client: { put: () => { throw networkError(); } },
  });
  await failing.sync.load();

  const outcome = await failing.sync.flush(state);
  assert.equal(outcome.status, 'offline');
  assert.equal(failing.sync.isOffline(), true);
  const persisted = failing.sync.readDraft();
  assert.equal(persisted.workflows[0].name, 'Offline edit', 'the edit must survive in the draft cache');

  // Once offline, later flushes must not retry the network on every keystroke.
  const before = failing.calls.put.length;
  const again = await failing.sync.flush(state);
  assert.equal(again.status, 'offline');
  assert.equal(failing.calls.put.length, before);
});

test('a delete is only sent while the graph is still absent, so undo cannot destroy it', async () => {
  const { sync, calls } = harness({ payload: { workflows: [graph('wf-a', { revision: 4 }), graph('wf-b', { revision: 1 })] } });
  await sync.load();

  sync.forget('wf-b');
  const kept = { schemaVersion: 2, activeWorkflowId: 'wf-a', workflows: [graph('wf-a'), graph('wf-b', { name: 'Undone' })], customAgents: [], customContexts: [] };
  const result = await sync.flush(kept);
  assert.equal(result.status, 'saved');
  assert.deepEqual(calls.deleted, [], 're-creating the same id must not delete the restored content');
  assert.deepEqual(calls.put.map((p) => p.id).sort(), ['wf-a', 'wf-b']);

  const removedState = { schemaVersion: 2, activeWorkflowId: 'wf-a', workflows: [graph('wf-a')], customAgents: [], customContexts: [] };
  sync.forget('wf-b');
  const deleted = await sync.flush(removedState);
  assert.equal(deleted.status, 'saved');
  assert.deepEqual(calls.deleted, ['wf-b']);
});

test('a persona rejection is reported as an error, not swallowed', async () => {
  const { sync } = harness({
    payload: { workflows: [graph('wf-a', { revision: 4 })] },
    client: { put: () => { throw httpError(403, 'persona_denied'); } },
  });
  await sync.load();
  const result = await sync.flush({
    schemaVersion: 2, activeWorkflowId: 'wf-a', workflows: [graph('wf-a', { name: 'Denied' })], customAgents: [], customContexts: [],
  });
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'persona_denied');
});
