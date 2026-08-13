'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stageStorageKey(runId, idempotencyKey) {
  return `${runId}\0${idempotencyKey}`;
}

function documentId(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

class SerializedStateStore {
  constructor(initial = {}) {
    this.state = {
      schemaVersion: 1,
      runs: clone(initial.runs || {}),
      stages: clone(initial.stages || {}),
    };
    this.tail = Promise.resolve();
  }

  async loadState() {
    return clone(this.state);
  }

  async persistState(state) {
    this.state = clone(state);
  }

  transaction(callback) {
    const execute = async () => {
      const state = await this.loadState();
      const transaction = {
        getRun: async (runId) => clone(state.runs[runId] || null),
        setRun: async (runId, run) => { state.runs[runId] = clone(run); },
        getStage: async (runId, idempotencyKey) => clone(state.stages[stageStorageKey(runId, idempotencyKey)] || null),
        setStage: async (runId, idempotencyKey, stageRun) => {
          state.stages[stageStorageKey(runId, idempotencyKey)] = clone(stageRun);
        },
      };
      const result = await callback(transaction);
      await this.persistState(state);
      return clone(result);
    };
    const pending = this.tail.then(execute, execute);
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async getRun(runId) {
    const state = await this.loadState();
    return clone(state.runs[runId] || null);
  }

  async getStage(runId, idempotencyKey) {
    const state = await this.loadState();
    return clone(state.stages[stageStorageKey(runId, idempotencyKey)] || null);
  }

  async listStages(runId) {
    const state = await this.loadState();
    return Object.entries(state.stages)
      .filter(([key]) => key.startsWith(`${runId}\0`))
      .map(([, value]) => clone(value));
  }
}

class MemoryPipelineStore extends SerializedStateStore {}

/** Local single-process durable store, mirroring shared-core's JSON backend. */
class JsonFilePipelineStore extends SerializedStateStore {
  constructor({ file }) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('file must be an absolute path.');
    super();
    this.file = file;
  }

  async loadState() {
    if (!fs.existsSync(this.file)) return { schemaVersion: 1, runs: {}, stages: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        schemaVersion: 1,
        runs: parsed && typeof parsed.runs === 'object' ? clone(parsed.runs) : {},
        stages: parsed && typeof parsed.stages === 'object' ? clone(parsed.stages) : {},
      };
    } catch (error) {
      error.code = error.code || 'pipeline_store_read_failed';
      throw error;
    }
  }

  async persistState(state) {
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(temporary, this.file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (_) { /* best effort */ }
      error.code = error.code || 'pipeline_store_write_failed';
      throw error;
    }
  }
}

/**
 * Firestore adapter. Runs are top-level documents and StageRuns are a
 * subcollection, so growing stage history never approaches the 1 MB document
 * limit. Both ids are stable hashes to tolerate slashes and avoid exposing
 * caller identifiers in Firestore paths.
 */
class FirestorePipelineStore {
  constructor({
    rootCollection = 'aifleet_pipeline_runs',
    projectId,
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

  runRef(runId) {
    return this.getDb().collection(this.rootCollection).doc(documentId(runId));
  }

  stageRef(runId, idempotencyKey) {
    return this.runRef(runId).collection('stages').doc(documentId(idempotencyKey));
  }

  async transaction(callback) {
    const db = this.getDb();
    return db.runTransaction(async (firestoreTransaction) => callback({
      getRun: async (runId) => {
        const snapshot = await firestoreTransaction.get(this.runRef(runId));
        return snapshot.exists ? clone(snapshot.data()) : null;
      },
      setRun: async (runId, run) => firestoreTransaction.set(this.runRef(runId), clone(run)),
      getStage: async (runId, idempotencyKey) => {
        const snapshot = await firestoreTransaction.get(this.stageRef(runId, idempotencyKey));
        return snapshot.exists ? clone(snapshot.data()) : null;
      },
      setStage: async (runId, idempotencyKey, stageRun) => (
        firestoreTransaction.set(this.stageRef(runId, idempotencyKey), clone(stageRun))
      ),
    }));
  }

  async getRun(runId) {
    const snapshot = await this.runRef(runId).get();
    return snapshot.exists ? clone(snapshot.data()) : null;
  }

  async getStage(runId, idempotencyKey) {
    const snapshot = await this.stageRef(runId, idempotencyKey).get();
    return snapshot.exists ? clone(snapshot.data()) : null;
  }

  async listStages(runId) {
    const snapshot = await this.runRef(runId).collection('stages').get();
    return snapshot.docs.map((doc) => clone(doc.data()));
  }
}

module.exports = {
  MemoryPipelineStore,
  JsonFilePipelineStore,
  FirestorePipelineStore,
  documentId,
};
