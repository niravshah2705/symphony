'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CONFIG } = require('@ai-fleet/shared-core/config');

function emptyState() {
  return { sessions: {}, results: {}, claims: {} };
}

function createInMemoryRepository(seed = emptyState()) {
  let state = JSON.parse(JSON.stringify(seed));
  let queue = Promise.resolve();
  const transact = (fn) => {
    const run = queue.then(async () => {
      const next = JSON.parse(JSON.stringify(state));
      const out = await fn(next);
      state = next;
      return out;
    });
    queue = run.catch(() => {});
    return run;
  };
  return {
    async read() { return JSON.parse(JSON.stringify(state)); },
    async getSession(id) { return JSON.parse(JSON.stringify(state.sessions[id] || null)); },
    async getResult(id) { return JSON.parse(JSON.stringify(state.results[id] || null)); },
    async transact(fn) { return transact(fn); },
  };
}

function createFileRepository(file) {
  const resolved = path.resolve(file);
  const dir = path.dirname(resolved);
  const memory = createInMemoryRepository(load());

  function load() {
    try {
      return JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (_) {
      return emptyState();
    }
  }

  function persist(state) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(state, null, 2), 'utf8');
  }

  return {
    read: () => memory.read(),
    getSession: (id) => memory.getSession(id),
    getResult: (id) => memory.getResult(id),
    transact: (fn) => memory.transact(async (state) => {
      const out = await fn(state);
      persist(state);
      return out;
    }),
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function documentId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

class FirestoreIdentityRepository {
  constructor({
    rootCollection = 'identity_verification',
    projectId = CONFIG.GCP.projectId,
    databaseId,
    firestoreFactory,
  } = {}) {
    this.rootCollection = rootCollection;
    this.projectId = projectId;
    this.databaseId = databaseId;
    this.firestoreFactory = firestoreFactory;
    this.db = null;
  }

  getDb() {
    if (this.db) return this.db;
    if (typeof this.firestoreFactory === 'function') {
      this.db = this.firestoreFactory();
    } else {
      const { Firestore } = require('@google-cloud/firestore');
      this.db = new Firestore({
        projectId: this.projectId || undefined,
        databaseId: this.databaseId || undefined,
      });
    }
    return this.db;
  }

  collection(name) {
    return this.getDb().collection(`${this.rootCollection}__${name}`);
  }

  sessionRef(id) { return this.collection('sessions').doc(documentId(id)); }
  resultRef(id) { return this.collection('results').doc(documentId(id)); }
  claimRef(id) { return this.collection('claims').doc(documentId(id)); }

  async listCollection(name) {
    const snapshot = await this.collection(name).get();
    const out = {};
    for (const doc of snapshot.docs || []) {
      const data = clone(doc.data());
      const key = data.sessionId || data.resultId || (data.claimType && data.claimHash ? `${data.claimType}:${data.claimHash}` : doc.id);
      out[key] = data;
    }
    return out;
  }

  async read() {
    const [sessions, results, claims] = await Promise.all([
      this.listCollection('sessions'),
      this.listCollection('results'),
      this.listCollection('claims'),
    ]);
    return { sessions, results, claims };
  }

  async getSession(id) {
    const snapshot = await this.sessionRef(id).get();
    return snapshot.exists ? clone(snapshot.data()) : null;
  }

  async getResult(id) {
    const snapshot = await this.resultRef(id).get();
    return snapshot.exists ? clone(snapshot.data()) : null;
  }

  async transact(fn) {
    const db = this.getDb();
    return db.runTransaction(async (tx) => {
      const [sessionSnapshots, resultSnapshots, claimSnapshots] = await Promise.all([
        tx.get(this.collection('sessions')),
        tx.get(this.collection('results')),
        tx.get(this.collection('claims')),
      ]);
      const state = { sessions: {}, results: {}, claims: {} };
      for (const doc of sessionSnapshots.docs || []) {
        const data = clone(doc.data());
        if (data.sessionId) state.sessions[data.sessionId] = data;
      }
      for (const doc of resultSnapshots.docs || []) {
        const data = clone(doc.data());
        if (data.resultId) state.results[data.resultId] = data;
      }
      for (const doc of claimSnapshots.docs || []) {
        const data = clone(doc.data());
        if (data.claimType && data.claimHash) state.claims[`${data.claimType}:${data.claimHash}`] = data;
      }
      const out = await fn(state);

      for (const [id, value] of Object.entries(state.sessions)) {
        tx.set(this.sessionRef(id), clone(value));
      }
      for (const [id, value] of Object.entries(state.results)) {
        tx.set(this.resultRef(id), clone(value));
      }
      for (const [id, value] of Object.entries(state.claims)) {
        tx.set(this.claimRef(id), clone(value));
      }
      return clone(out);
    });
  }
}

function createFirestoreRepository(options) {
  return new FirestoreIdentityRepository(options);
}

function createRepositoryFromEnv(env = process.env) {
  const backend = String(env.IDENTITY_STORE_BACKEND || env.STORE_BACKEND || 'file').trim().toLowerCase();
  if (backend === 'firestore') {
    return createFirestoreRepository({
      rootCollection: env.IDENTITY_COLLECTION || 'identity_verification',
      projectId: env.GCP_PROJECT_ID || CONFIG.GCP.projectId,
      databaseId: env.FIRESTORE_DATABASE_ID,
    });
  }
  if (backend === 'memory') return createInMemoryRepository();
  return createFileRepository(env.IDENTITY_STORE_FILE || `${CONFIG.DATA_DIR}/identity-verification.json`);
}

module.exports = {
  emptyState,
  createInMemoryRepository,
  createFileRepository,
  createFirestoreRepository,
  createRepositoryFromEnv,
  FirestoreIdentityRepository,
  documentId,
};
