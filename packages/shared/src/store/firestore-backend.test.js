'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const firestoreBackend = require('./firestore-backend');

/**
 * Minimal in-memory Firestore fake: a root doc + named sub-collections, with
 * batch set/delete and onSnapshot listeners. Enough to exercise the backend's
 * read/write/init/subscribe contract without the real SDK.
 */
function makeFakeFirestore() {
  const collections = new Map(); // key -> Map(id -> data)
  const listeners = { main: [], collections: new Map() };
  let mainData = null;
  let mainExists = false;

  function colMap(key) {
    if (!collections.has(key)) collections.set(key, new Map());
    return collections.get(key);
  }
  function notifyMain() {
    for (const cb of listeners.main) cb({ exists: mainExists, data: () => mainData });
  }
  function notifyCol(key) {
    const arr = [...colMap(key).values()];
    const cbs = listeners.collections.get(key) || [];
    for (const cb of cbs) {
      cb({ docs: arr.map((data) => ({ data: () => data })), docChanges: () => arr.map((data) => ({ type: 'added', doc: { data: () => data } })) });
    }
  }

  function collectionRef(key) {
    return {
      doc(id) {
        return {
          set(data) { colMap(key).set(id, data); },
          delete() { colMap(key).delete(id); },
        };
      },
      async get() {
        return { docs: [...colMap(key).values()].map((data) => ({ data: () => data })) };
      },
      onSnapshot(onNext) {
        if (!listeners.collections.has(key)) listeners.collections.set(key, []);
        listeners.collections.get(key).push(onNext);
        notifyCol(key);
        return () => {};
      },
    };
  }

  const rootDoc = {
    set(data) { mainData = data; mainExists = true; },
    async get() { return { exists: mainExists, data: () => mainData }; },
    onSnapshot(onNext) { listeners.main.push(onNext); notifyMain(); return () => {}; },
    collection: collectionRef,
  };

  const db = {
    collection() { return { doc() { return rootDoc; } }; },
    batch() {
      const ops = [];
      return {
        set(ref, data) { ops.push(() => ref.set(data)); return this; },
        delete(ref) { ops.push(() => ref.delete()); return this; },
        async commit() { for (const op of ops) op(); notifyMain(); for (const k of collections.keys()) notifyCol(k); },
      };
    },
  };
  return { db, _collections: collections };
}

function makeBackend(fake) {
  return firestoreBackend.create({
    mainKeys: ['settings', 'assumedRole'],
    collectionKeys: ['jobs'],
    normalize: (raw) => ({
      settings: raw.settings || {},
      assumedRole: raw.assumedRole || null,
      jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
    }),
    seed: () => ({ settings: { linearApiKey: '' }, assumedRole: null, jobs: [] }),
    firestoreFactory: () => fake.db,
  });
}

test('init seeds an empty store and read returns the normalized mirror', async () => {
  const fake = makeFakeFirestore();
  const backend = makeBackend(fake);
  await backend.init();
  assert.deepEqual(backend.read(), { settings: { linearApiKey: '' }, assumedRole: null, jobs: [] });
});

test('write persists main keys and collection records, and updates the mirror synchronously', async () => {
  const fake = makeFakeFirestore();
  const backend = makeBackend(fake);
  await backend.init();

  const next = { settings: { linearApiKey: 'k' }, assumedRole: { id: 'r1' }, jobs: [{ id: 'j1', status: 'pending' }] };
  const returned = backend.write(next);
  assert.equal(returned, next); // returns the written store
  assert.deepEqual(backend.read(), next); // mirror updated immediately (before async commit)

  // Allow the background batch.commit() to flush.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...fake._collections.get('jobs').keys()], ['j1']);
});

test('write deletes collection records that were removed', async () => {
  const fake = makeFakeFirestore();
  const backend = makeBackend(fake);
  await backend.init();
  backend.write({ settings: {}, assumedRole: null, jobs: [{ id: 'a' }, { id: 'b' }] });
  await new Promise((resolve) => setImmediate(resolve));
  backend.write({ settings: {}, assumedRole: null, jobs: [{ id: 'b' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...fake._collections.get('jobs').keys()], ['b']);
});

test('init hydrates an existing store from the main doc + collections', async () => {
  const fake = makeFakeFirestore();
  // Pre-populate as if a prior instance had written.
  const first = makeBackend(fake);
  await first.init();
  first.write({ settings: { linearApiKey: 'existing' }, assumedRole: null, jobs: [{ id: 'j9' }] });
  await new Promise((resolve) => setImmediate(resolve));

  const second = makeBackend(fake);
  await second.init();
  assert.equal(second.read().settings.linearApiKey, 'existing');
  assert.deepEqual(second.read().jobs, [{ id: 'j9' }]);
});
