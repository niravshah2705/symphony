'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { create, encodeDocId } = require('./firestore-backend');

// A Firestore-shaped fake that records every batch op, so the write path can be
// asserted without the GCP SDK.
function fakeFirestore(ops) {
  const docRef = (path) => ({
    path,
    id: path.split('/').pop(),
    collection: (name) => collRef(`${path}/${name}`),
    get: async () => ({ exists: false, data: () => ({}) }),
    onSnapshot: () => () => {},
  });
  const collRef = (path) => ({
    path,
    doc: (id) => docRef(`${path}/${id}`),
    get: async () => ({ docs: [] }),
    onSnapshot: () => () => {},
  });
  return {
    collection: (name) => collRef(name),
    batch: () => ({
      set: (ref, data) => ops.push({ op: 'set', id: ref.id, path: ref.path, data }),
      delete: (ref) => ops.push({ op: 'delete', id: ref.id, path: ref.path }),
      commit: async () => [],
    }),
  };
}

function backend(ops) {
  return create({
    mainKeys: ['billingState'],
    collectionKeys: ['billingAccounts'],
    normalize: (raw) => ({ billingState: {}, billingAccounts: [], ...raw }),
    seed: () => ({ billingState: {}, billingAccounts: [] }),
    firestoreFactory: () => fakeFirestore(ops),
  });
}

test('encodeDocId rewrites only ids wrapped in double underscores', () => {
  assert.equal(encodeDocId('__shared__'), '--shared--');
  assert.equal(encodeDocId('org-tenant-a'), 'org-tenant-a');
  assert.equal(encodeDocId('org__inner'), 'org__inner', 'not wrapped on both ends');
});

test('a reserved org id is written under an acceptable document key', () => {
  // Firestore rejects `__shared__` outright ("Resource id ... is invalid because
  // it is reserved"), which made the shared stack's billing account undurable.
  const ops = [];
  const store = backend(ops);
  store.write({
    billingState: { lastAggregatedAt: 'now' },
    billingAccounts: [
      { id: '__shared__', orgId: '__shared__', balanceTokenCredits: 10 },
      { id: 'org-tenant-a', orgId: 'org-tenant-a', balanceTokenCredits: 20 },
    ],
  });

  const written = ops.filter((o) => o.op === 'set' && o.path.includes('/billingAccounts/'));
  assert.deepEqual(written.map((o) => o.id), ['--shared--', 'org-tenant-a']);
  assert.equal(written[0].data.id, '__shared__', 'the body keeps the real org id (reads use it)');
});

test('removing an account deletes the rewritten key, not the raw one', () => {
  const ops = [];
  const store = backend(ops);
  const accounts = [{ id: '__shared__', orgId: '__shared__', balanceTokenCredits: 10 }];
  store.write({ billingState: {}, billingAccounts: accounts });
  ops.length = 0;
  store.write({ billingState: {}, billingAccounts: [] });

  const deleted = ops.find((o) => o.op === 'delete');
  assert.ok(deleted, 'the vanished account is deleted');
  assert.equal(deleted.id, '--shared--');
});

/**
 * The catalog mirror (`scripts/seed-plugin-catalog.js --store`) is a process
 * that writes and exits, and this backend both persists in the background and
 * keeps snapshot listeners open. So `close()` is the only thing that can tell
 * such a caller its writes are durable and its handles are gone — without it
 * the CI job printed "9 record(s), 9 changed" and then sat on the listeners
 * until its timeout cancelled the run.
 */
test('close waits for the commits still in flight, then releases the client', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let committed = 0;
  let terminated = 0;
  let unsubscribed = 0;
  const drop = () => { unsubscribed += 1; };
  const docRef = (path) => ({
    path,
    id: path.split('/').pop(),
    collection: (name) => collRef(`${path}/${name}`),
    get: async () => ({ exists: true, data: () => ({}) }),
    onSnapshot: () => drop,
  });
  const collRef = (path) => ({
    path,
    doc: (id) => docRef(`${path}/${id}`),
    get: async () => ({ docs: [] }),
    onSnapshot: () => drop,
  });
  const client = {
    collection: (name) => collRef(name),
    batch: () => ({
      set: () => {},
      delete: () => {},
      commit: async () => { await gate; committed += 1; return []; },
    }),
    terminate: async () => { terminated += 1; },
  };
  const store = create({
    mainKeys: ['billingState'],
    collectionKeys: ['billingAccounts'],
    normalize: (raw) => ({ billingState: {}, billingAccounts: [], ...raw }),
    seed: () => ({ billingState: {}, billingAccounts: [] }),
    firestoreFactory: () => client,
  });

  await store.init();
  store.write({ billingState: { lastAggregatedAt: 'now' }, billingAccounts: [{ id: 'a' }] });

  const closing = store.close();
  assert.equal(terminated, 0, 'the client stays open while a commit is still in flight');
  release();
  await closing;

  assert.equal(committed, 1, 'the backgrounded write landed before anything was torn down');
  assert.equal(terminated, 1, 'the gRPC pool is closed, so an exiting process has no handle left');
  assert.ok(unsubscribed >= 2, `main and collection listeners are dropped (saw ${unsubscribed})`);
});
