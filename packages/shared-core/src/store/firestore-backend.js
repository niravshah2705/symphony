'use strict';

const log = require('../logger');

/**
 * Firestore store backend for Cloud Run (`STORE_BACKEND=firestore`).
 *
 * Cloud Run instances are ephemeral and may run in parallel, so the single
 * local `data/store.json` cannot be the source of truth. This backend keeps the
 * SAME synchronous `read()`/`write()` contract as the file backend by holding a
 * live in-memory MIRROR of the store: it is hydrated once at boot (`init()`),
 * kept fresh across instances via `onSnapshot`, and every `write()` updates the
 * mirror synchronously while persisting to Firestore in the background.
 *
 * The store is split to stay under Firestore's 1 MB document limit:
 *   - small, singleton keys (`mainKeys`) live together in one document;
 *   - growing arrays of records (`collectionKeys`) each become a sub-collection,
 *     one document per record keyed by `idField`.
 *
 * Schema knowledge (defaults, migrations) stays in store.js and is injected via
 * `normalize(rawParsed)` and `seed()`.
 *
 * @param {object} opts
 * @param {string} [opts.rootCollection]  top-level collection (default 'aifleet')
 * @param {string} [opts.mainDocId]       main document id (default 'store')
 * @param {string[]} opts.mainKeys        keys stored in the main document
 * @param {string[]} opts.collectionKeys  array keys stored as sub-collections
 * @param {string} [opts.idField]         record id field for collections (default 'id')
 * @param {(rawParsed: object) => object} opts.normalize
 * @param {() => object} opts.seed
 * @param {() => object} [opts.firestoreFactory]  returns a Firestore instance (injectable for tests)
 */
function create({
  rootCollection = 'aifleet',
  mainDocId = 'store',
  mainKeys,
  collectionKeys,
  idField = 'id',
  normalize,
  seed,
  firestoreFactory,
}) {
  let db = null;
  let rootDoc = null;
  // Raw (pre-normalize) parts kept live so any snapshot can re-assemble the store.
  const rawParts = { main: {}, collections: {} };
  for (const key of collectionKeys) rawParts.collections[key] = [];
  let mirror = seed();
  let ready = false;

  function getDb() {
    if (db) return db;
    if (typeof firestoreFactory === 'function') {
      db = firestoreFactory();
    } else {
      // Lazy require so local (file) backend never needs the GCP SDK installed.
      const { Firestore } = require('@google-cloud/firestore');
      db = new Firestore();
    }
    rootDoc = db.collection(rootCollection).doc(mainDocId);
    return db;
  }

  function assemble() {
    const raw = { ...rawParts.main };
    for (const key of collectionKeys) raw[key] = rawParts.collections[key];
    return normalize(raw);
  }

  function rebuildMirror() {
    mirror = assemble();
  }

  function pickMain(store) {
    const out = {};
    for (const key of mainKeys) out[key] = store[key];
    return out;
  }

  function background(promise) {
    Promise.resolve(promise).catch((err) => {
      log.error(`firestore store write failed: ${err && err.message ? err.message : err}`);
    });
  }

  /** Persist one collection by diffing the previous mirror against the new store. */
  function persistCollection(batch, key, prevItems, nextItems) {
    const col = rootDoc.collection(key);
    const prevById = new Map(prevItems.map((item) => [String(item[idField]), item]));
    const nextById = new Map(nextItems.map((item) => [String(item[idField]), item]));
    for (const [id, item] of nextById) {
      const prev = prevById.get(id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(item)) {
        batch.set(col.doc(id), item);
      }
    }
    for (const id of prevById.keys()) {
      if (!nextById.has(id)) batch.delete(col.doc(id));
    }
  }

  function read() {
    return mirror;
  }

  function write(store) {
    const prev = mirror;
    // Update the raw parts + mirror synchronously so this instance is immediately
    // consistent; Firestore persistence happens in the background.
    rawParts.main = pickMain(store);
    for (const key of collectionKeys) rawParts.collections[key] = Array.isArray(store[key]) ? store[key] : [];
    mirror = store;

    getDb();
    const batch = db.batch();
    batch.set(rootDoc, pickMain(store));
    for (const key of collectionKeys) {
      persistCollection(batch, key, Array.isArray(prev[key]) ? prev[key] : [], rawParts.collections[key]);
    }
    background(batch.commit());
    return store;
  }

  async function loadCollection(key) {
    const snap = await rootDoc.collection(key).get();
    return snap.docs.map((doc) => doc.data());
  }

  function subscribe() {
    rootDoc.onSnapshot(
      (snap) => {
        if (snap.exists) {
          rawParts.main = snap.data() || {};
          rebuildMirror();
        }
      },
      (err) => log.error(`firestore main onSnapshot error: ${err && err.message ? err.message : err}`)
    );
    for (const key of collectionKeys) {
      rootDoc.collection(key).onSnapshot(
        (snap) => {
          rawParts.collections[key] = snap.docs.map((doc) => doc.data());
          rebuildMirror();
        },
        (err) => log.error(`firestore ${key} onSnapshot error: ${err && err.message ? err.message : err}`)
      );
    }
  }

  async function init() {
    if (ready) return;
    getDb();
    const snap = await rootDoc.get();
    if (!snap.exists) {
      // Seed a fresh store on first boot.
      const fresh = seed();
      rawParts.main = pickMain(fresh);
      for (const key of collectionKeys) rawParts.collections[key] = Array.isArray(fresh[key]) ? fresh[key] : [];
      const batch = db.batch();
      batch.set(rootDoc, rawParts.main);
      for (const key of collectionKeys) persistCollection(batch, key, [], rawParts.collections[key]);
      await batch.commit();
    } else {
      rawParts.main = snap.data() || {};
      for (const key of collectionKeys) rawParts.collections[key] = await loadCollection(key);
    }
    rebuildMirror();
    subscribe();
    ready = true;
  }

  return { read, write, init };
}

module.exports = { create };
