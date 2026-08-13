'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { CONFIG, namespaceCollection } = require('@ai-fleet/shared-core/config');

const DEFAULT_EXECUTION_LEASE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_COLLECTION = 'aifleet_pipeline_worker_results';
const EXECUTION_STATES = new Set(['executing', 'completed']);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function documentId(key) {
  return createHash('sha256').update(String(key)).digest('hex');
}

function commandHash(command) {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

class StageExecutionStoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StageExecutionStoreError';
    this.code = code;
    this.status = 503;
    this.retryable = true;
  }
}

function storeError(message, code) {
  throw new StageExecutionStoreError(message, code);
}

function assertRecord(record, command) {
  if (!record || !EXECUTION_STATES.has(record.status)) {
    storeError('The durable stage execution record is invalid.', 'stage_execution_record_invalid');
  }
  if (record.idempotencyKey !== command.idempotencyKey || record.commandHash !== commandHash(command)) {
    storeError('The stage idempotency key is bound to a different command.', 'stage_execution_command_conflict');
  }
  if (record.status === 'completed' && (!record.result || typeof record.result !== 'object')) {
    storeError('The durable stage completion is missing its result.', 'stage_execution_record_invalid');
  }
  return record;
}

function newExecutionRecord(command, claimId, startedAt, nowMs, leaseMs) {
  return {
    schemaVersion: 1,
    idempotencyKey: command.idempotencyKey,
    commandHash: commandHash(command),
    runId: command.runId,
    stage: command.stage,
    attempt: command.attempt,
    status: 'executing',
    claimId,
    startedAt,
    leaseExpiresAtMs: nowMs + leaseMs,
    result: null,
    recoveredFromExpiredLease: false,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function completedRecord(record, result, nowMs, recoveredFromExpiredLease = false) {
  return {
    ...record,
    status: 'completed',
    leaseExpiresAtMs: 0,
    result: clone(result),
    recoveredFromExpiredLease,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function claimRecord(current, command, {
  leaseMs,
  nowMs,
  startedAt,
  recoverExpired,
}) {
  if (!current) {
    const claimId = randomUUID();
    return {
      record: newExecutionRecord(command, claimId, startedAt, nowMs, leaseMs),
      response: { acquired: true, claimId },
    };
  }
  const record = assertRecord(current, command);
  if (record.status === 'completed') {
    return {
      record,
      response: { acquired: false, state: 'completed', result: clone(record.result) },
    };
  }
  if (Number(record.leaseExpiresAtMs) > nowMs) {
    return { record, response: { acquired: false, state: 'in_progress' } };
  }
  if (typeof recoverExpired !== 'function') {
    storeError('An expired stage execution lease requires fail-safe recovery.', 'stage_execution_recovery_required');
  }
  // Never reacquire an expired execution: the previous process may have caused
  // external side effects before it died. Persist a terminal unknown-outcome
  // result instead, so a restart replays evidence rather than duplicating work.
  const result = recoverExpired({
    startedAt: record.startedAt || null,
    leaseExpiredAt: new Date(Number(record.leaseExpiresAtMs) || nowMs).toISOString(),
  });
  const recovered = completedRecord(record, result, nowMs, true);
  return {
    record: recovered,
    response: { acquired: false, state: 'recovered', result: clone(result) },
  };
}

class SerializedStageExecutionStore {
  constructor({ leaseMs = DEFAULT_EXECUTION_LEASE_MS, now = () => Date.now() } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('leaseMs must be a positive integer.');
    this.leaseMs = leaseMs;
    this.now = now;
    this.tail = Promise.resolve();
  }

  async loadRecords() { return {}; }

  async persistRecords() {}

  transaction(callback) {
    const execute = async () => {
      const records = await this.loadRecords();
      const result = await callback(records);
      if (result.write) await this.persistRecords(records);
      return clone(result.value);
    };
    const pending = this.tail.then(execute, execute);
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  claim(command, { startedAt, recoverExpired } = {}) {
    return this.transaction(async (records) => {
      const id = documentId(command.idempotencyKey);
      const existed = Boolean(records[id]);
      const outcome = claimRecord(records[id] || null, command, {
        leaseMs: this.leaseMs,
        nowMs: this.now(),
        startedAt,
        recoverExpired,
      });
      records[id] = clone(outcome.record);
      return {
        write: !existed || outcome.response.acquired || outcome.response.state === 'recovered',
        value: outcome.response,
      };
    });
  }

  complete(command, claimId, result) {
    return this.transaction(async (records) => {
      const id = documentId(command.idempotencyKey);
      const current = assertRecord(records[id], command);
      if (current.status !== 'executing' || current.claimId !== claimId) {
        storeError('The stage execution claim was lost.', 'stage_execution_claim_lost');
      }
      records[id] = completedRecord(current, result, this.now());
      return { write: true, value: clone(result) };
    });
  }
}

class MemoryStageExecutionStore extends SerializedStageExecutionStore {
  constructor(options = {}) {
    super(options);
    this.records = {};
  }

  async loadRecords() { return clone(this.records); }

  async persistRecords(records) { this.records = clone(records); }
}

/** Crash-safe local persistence for the normal single-process-per-stage dev
 * topology. Corrupt state fails closed; it is never silently reset. */
class JsonFileStageExecutionStore extends SerializedStageExecutionStore {
  constructor({ file, ...options } = {}) {
    super(options);
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('file must be an absolute path.');
    this.file = file;
  }

  async loadRecords() {
    if (!fs.existsSync(this.file)) return {};
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!state || state.schemaVersion !== 1 || !state.records || typeof state.records !== 'object') {
        storeError('The local stage execution store is invalid.', 'stage_execution_store_invalid');
      }
      return clone(state.records);
    } catch (error) {
      if (error instanceof StageExecutionStoreError) throw error;
      throw new StageExecutionStoreError('The local stage execution store could not be read.', 'stage_execution_store_read_failed');
    }
  }

  async persistRecords(records) {
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, records }, null, 2), 'utf8');
      fs.renameSync(temporary, this.file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (_) { /* best effort */ }
      throw new StageExecutionStoreError('The local stage execution store could not be written.', 'stage_execution_store_write_failed');
    }
  }
}

class FirestoreStageExecutionStore {
  constructor({
    collectionName = namespaceCollection(DEFAULT_COLLECTION),
    projectId,
    databaseId,
    firestoreFactory,
    leaseMs = DEFAULT_EXECUTION_LEASE_MS,
    now = () => Date.now(),
  } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('leaseMs must be a positive integer.');
    this.collectionName = collectionName;
    this.projectId = projectId;
    this.databaseId = databaseId;
    this.firestoreFactory = firestoreFactory;
    this.leaseMs = leaseMs;
    this.now = now;
    this.db = null;
  }

  getDb() {
    if (this.db) return this.db;
    if (typeof this.firestoreFactory === 'function') this.db = this.firestoreFactory();
    else {
      const { Firestore } = require('@google-cloud/firestore');
      this.db = new Firestore({
        projectId: this.projectId || undefined,
        databaseId: this.databaseId || undefined,
      });
    }
    return this.db;
  }

  ref(command) {
    return this.getDb().collection(this.collectionName).doc(documentId(command.idempotencyKey));
  }

  async claim(command, { startedAt, recoverExpired } = {}) {
    const db = this.getDb();
    const ref = this.ref(command);
    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const outcome = claimRecord(snapshot.exists ? snapshot.data() : null, command, {
        leaseMs: this.leaseMs,
        nowMs: this.now(),
        startedAt,
        recoverExpired,
      });
      if (!snapshot.exists || outcome.response.acquired || outcome.response.state === 'recovered') {
        transaction.set(ref, clone(outcome.record));
      }
      return clone(outcome.response);
    });
  }

  async complete(command, claimId, result) {
    const db = this.getDb();
    const ref = this.ref(command);
    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = assertRecord(snapshot.exists ? snapshot.data() : null, command);
      if (current.status !== 'executing' || current.claimId !== claimId) {
        storeError('The stage execution claim was lost.', 'stage_execution_claim_lost');
      }
      transaction.set(ref, completedRecord(current, result, this.now()));
      return clone(result);
    });
  }
}

function configuredLeaseMs(env) {
  const value = Number(env.PIPELINE_STAGE_EXECUTION_LEASE_MS || DEFAULT_EXECUTION_LEASE_MS);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('PIPELINE_STAGE_EXECUTION_LEASE_MS must be a positive integer.');
  }
  return value;
}

function createStageExecutionStore({ stage, env = process.env, now, firestoreFactory } = {}) {
  if (!['plan', 'code', 'test', 'deploy'].includes(stage)) throw new TypeError('A canonical pipeline stage is required.');
  const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const underNodeTest = Boolean(env.NODE_TEST_CONTEXT);
  const backend = String(
    env.PIPELINE_STAGE_STORE_BACKEND || (underNodeTest ? 'memory' : production ? 'firestore' : 'file'),
  ).trim().toLowerCase();
  if (production && backend !== 'firestore') {
    throw new Error('Production pipeline workers require PIPELINE_STAGE_STORE_BACKEND=firestore.');
  }
  const leaseMs = configuredLeaseMs(env);
  if (backend === 'memory') return new MemoryStageExecutionStore({ leaseMs, now });
  if (backend === 'file') {
    const root = path.resolve(String(env.PIPELINE_STAGE_STORE_DIR || CONFIG.DATA_DIR));
    return new JsonFileStageExecutionStore({
      file: path.join(root, 'pipeline-stage-executions', `${stage}.json`),
      leaseMs,
      now,
    });
  }
  if (backend === 'firestore') {
    return new FirestoreStageExecutionStore({
      projectId: env.GCP_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || CONFIG.GCP.projectId,
      databaseId: env.FIRESTORE_DATABASE || undefined,
      leaseMs,
      now,
      firestoreFactory,
    });
  }
  throw new Error('PIPELINE_STAGE_STORE_BACKEND must be memory, file, or firestore.');
}

module.exports = {
  DEFAULT_EXECUTION_LEASE_MS,
  DEFAULT_COLLECTION,
  StageExecutionStoreError,
  MemoryStageExecutionStore,
  JsonFileStageExecutionStore,
  FirestoreStageExecutionStore,
  createStageExecutionStore,
  commandHash,
  documentId,
};
