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
      { id: '__shared__', orgId: '__shared__', balancePaise: 10 },
      { id: 'org-tenant-a', orgId: 'org-tenant-a', balancePaise: 20 },
    ],
  });

  const written = ops.filter((o) => o.op === 'set' && o.path.includes('/billingAccounts/'));
  assert.deepEqual(written.map((o) => o.id), ['--shared--', 'org-tenant-a']);
  assert.equal(written[0].data.id, '__shared__', 'the body keeps the real org id (reads use it)');
});

test('removing an account deletes the rewritten key, not the raw one', () => {
  const ops = [];
  const store = backend(ops);
  const accounts = [{ id: '__shared__', orgId: '__shared__', balancePaise: 10 }];
  store.write({ billingState: {}, billingAccounts: accounts });
  ops.length = 0;
  store.write({ billingState: {}, billingAccounts: [] });

  const deleted = ops.find((o) => o.op === 'delete');
  assert.ok(deleted, 'the vanished account is deleted');
  assert.equal(deleted.id, '--shared--');
});
