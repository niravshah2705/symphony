'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { BaseCheckpointSaver, copyCheckpoint } = require('@langchain/langgraph');
const { CONFIG, namespaceCollection } = require('@ai-fleet/shared-core/config');

const SPECIAL_WRITE_INDEX = Object.freeze({
  __error__: -1,
  __scheduled__: -2,
  __interrupt__: -3,
  __resume__: -4,
});

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requiredString(value, field, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value)) throw new TypeError(`${field} is required.`);
  return value;
}

function checkpointIdFromConfig(config) {
  return config && config.configurable
    ? config.configurable.checkpoint_id || config.configurable.thread_ts || ''
    : '';
}

function configParts(config, { requireCheckpoint = false } = {}) {
  const configurable = config && config.configurable ? config.configurable : {};
  const threadId = requiredString(configurable.thread_id, 'configurable.thread_id');
  const checkpointNs = configurable.checkpoint_ns === undefined
    ? ''
    : requiredString(configurable.checkpoint_ns, 'configurable.checkpoint_ns', { empty: true });
  const checkpointId = checkpointIdFromConfig(config);
  if (requireCheckpoint) requiredString(checkpointId, 'configurable.checkpoint_id');
  return { threadId, checkpointNs, checkpointId };
}

function checkpointKey(threadId, checkpointNs, checkpointId) {
  return digest(`${threadId}\0${checkpointNs}\0${checkpointId}`);
}

function writeKey(threadId, checkpointNs, checkpointId, taskId, index) {
  return digest(`${threadId}\0${checkpointNs}\0${checkpointId}\0${taskId}\0${index}`);
}

function emptyState() {
  return { schemaVersion: 1, checkpoints: {}, writes: {} };
}

class JsonCheckpointBackend {
  constructor({ file }) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('checkpoint file must be absolute.');
    this.file = file;
    this.tail = Promise.resolve();
  }

  load() {
    if (!fs.existsSync(this.file)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return {
      schemaVersion: 1,
      checkpoints: parsed && typeof parsed.checkpoints === 'object' ? parsed.checkpoints : {},
      writes: parsed && typeof parsed.writes === 'object' ? parsed.writes : {},
    };
  }

  persist(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(temporary, this.file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (_) { /* best effort */ }
      throw error;
    }
  }

  mutate(callback) {
    const execute = async () => {
      const state = this.load();
      const result = await callback(state);
      this.persist(state);
      return clone(result);
    };
    const pending = this.tail.then(execute, execute);
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async getCheckpoint(threadId, checkpointNs, checkpointId) {
    const state = this.load();
    if (checkpointId) return clone(state.checkpoints[checkpointKey(threadId, checkpointNs, checkpointId)] || null);
    return Object.values(state.checkpoints)
      .filter((record) => record.threadId === threadId && record.checkpointNs === checkpointNs)
      .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId))[0] || null;
  }

  async listCheckpoints(threadId, checkpointNs) {
    const state = this.load();
    return Object.values(state.checkpoints)
      .filter((record) => (!threadId || record.threadId === threadId)
        && (checkpointNs === undefined || record.checkpointNs === checkpointNs))
      .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId))
      .map(clone);
  }

  async putCheckpoint(record) {
    return this.mutate(async (state) => {
      state.checkpoints[checkpointKey(record.threadId, record.checkpointNs, record.checkpointId)] = clone(record);
    });
  }

  async getWrites(threadId, checkpointNs, checkpointId) {
    const state = this.load();
    return Object.values(state.writes)
      .filter((record) => record.threadId === threadId
        && record.checkpointNs === checkpointNs
        && record.checkpointId === checkpointId)
      .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.index - right.index)
      .map(clone);
  }

  async putWrites(records) {
    return this.mutate(async (state) => {
      for (const record of records) {
        const key = writeKey(
          record.threadId,
          record.checkpointNs,
          record.checkpointId,
          record.taskId,
          record.index,
        );
        if (record.index >= 0 && state.writes[key]) continue;
        state.writes[key] = clone(record);
      }
    });
  }

  async deleteThread(threadId) {
    return this.mutate(async (state) => {
      for (const [key, record] of Object.entries(state.checkpoints)) {
        if (record.threadId === threadId) delete state.checkpoints[key];
      }
      for (const [key, record] of Object.entries(state.writes)) {
        if (record.threadId === threadId) delete state.writes[key];
      }
    });
  }
}

class FirestoreCheckpointBackend {
  constructor({ rootCollection, projectId, databaseId, firestoreFactory } = {}) {
    this.rootCollection = rootCollection || 'aifleet_pipeline_checkpoints';
    this.projectId = projectId;
    this.databaseId = databaseId;
    this.firestoreFactory = firestoreFactory;
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

  threadRef(threadId) {
    return this.getDb().collection(this.rootCollection).doc(digest(threadId));
  }

  namespaceRef(threadId, checkpointNs) {
    return this.threadRef(threadId).collection('namespaces').doc(digest(checkpointNs));
  }

  checkpointsCollection(threadId, checkpointNs) {
    return this.namespaceRef(threadId, checkpointNs).collection('checkpoints');
  }

  checkpointRef(threadId, checkpointNs, checkpointId) {
    return this.checkpointsCollection(threadId, checkpointNs).doc(digest(checkpointId));
  }

  async getCheckpoint(threadId, checkpointNs, checkpointId) {
    if (checkpointId) {
      const snapshot = await this.checkpointRef(threadId, checkpointNs, checkpointId).get();
      return snapshot.exists ? clone(snapshot.data()) : null;
    }
    const snapshot = await this.checkpointsCollection(threadId, checkpointNs)
      .orderBy('checkpointId', 'desc')
      .limit(1)
      .get();
    return snapshot.empty ? null : clone(snapshot.docs[0].data());
  }

  async listCheckpoints(threadId, checkpointNs) {
    if (!threadId) throw new TypeError('Firestore checkpoint listing requires configurable.thread_id.');
    const snapshot = await this.checkpointsCollection(threadId, checkpointNs || '')
      .orderBy('checkpointId', 'desc')
      .get();
    return snapshot.docs.map((doc) => clone(doc.data()));
  }

  async putCheckpoint(record) {
    await this.checkpointRef(record.threadId, record.checkpointNs, record.checkpointId).set(clone(record));
  }

  async getWrites(threadId, checkpointNs, checkpointId) {
    const snapshot = await this.checkpointRef(threadId, checkpointNs, checkpointId)
      .collection('writes')
      .get();
    return snapshot.docs
      .map((doc) => clone(doc.data()))
      .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.index - right.index);
  }

  async putWrites(records) {
    if (!records.length) return;
    const db = this.getDb();
    await db.runTransaction(async (transaction) => {
      const refs = records.map((record) => this.checkpointRef(
        record.threadId,
        record.checkpointNs,
        record.checkpointId,
      ).collection('writes').doc(digest(`${record.taskId}\0${record.index}`)));
      const snapshots = [];
      for (const ref of refs) snapshots.push(await transaction.get(ref));
      for (let index = 0; index < records.length; index += 1) {
        if (records[index].index >= 0 && snapshots[index].exists) continue;
        transaction.set(refs[index], clone(records[index]));
      }
    });
  }

  async deleteThread(threadId) {
    const db = this.getDb();
    if (typeof db.recursiveDelete !== 'function') {
      throw new Error('Firestore client does not support recursiveDelete; refusing a partial checkpoint deletion.');
    }
    await db.recursiveDelete(this.threadRef(threadId));
  }
}

class DurablePipelineCheckpointer extends BaseCheckpointSaver {
  constructor({ backend, serde } = {}) {
    super(serde);
    if (!backend) throw new TypeError('checkpoint backend is required.');
    this.backend = backend;
  }

  async serialize(value) {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    return { type, data: Buffer.from(bytes).toString('base64') };
  }

  deserialize(value) {
    return this.serde.loadsTyped(value.type, Buffer.from(value.data, 'base64'));
  }

  async tuple(record) {
    if (!record) return undefined;
    const [checkpoint, metadata, writeRecords] = await Promise.all([
      this.deserialize(record.checkpoint),
      this.deserialize(record.metadata),
      this.backend.getWrites(record.threadId, record.checkpointNs, record.checkpointId),
    ]);
    const pendingWrites = await Promise.all(writeRecords.map(async (write) => [
      write.taskId,
      write.channel,
      await this.deserialize(write.value),
    ]));
    const value = {
      config: { configurable: {
        thread_id: record.threadId,
        checkpoint_ns: record.checkpointNs,
        checkpoint_id: record.checkpointId,
      } },
      checkpoint,
      metadata,
      pendingWrites,
    };
    if (record.parentCheckpointId) {
      value.parentConfig = { configurable: {
        thread_id: record.threadId,
        checkpoint_ns: record.checkpointNs,
        checkpoint_id: record.parentCheckpointId,
      } };
    }
    return value;
  }

  async getTuple(config) {
    const { threadId, checkpointNs, checkpointId } = configParts(config);
    return this.tuple(await this.backend.getCheckpoint(threadId, checkpointNs, checkpointId));
  }

  async *list(config, options = {}) {
    const configurable = config && config.configurable ? config.configurable : {};
    const threadId = configurable.thread_id || '';
    const checkpointNs = configurable.checkpoint_ns;
    const requestedCheckpointId = checkpointIdFromConfig(config);
    const beforeId = options.before ? checkpointIdFromConfig(options.before) : '';
    let remaining = options.limit;
    const records = await this.backend.listCheckpoints(threadId, checkpointNs);
    for (const record of records) {
      if (requestedCheckpointId && record.checkpointId !== requestedCheckpointId) continue;
      if (beforeId && record.checkpointId >= beforeId) continue;
      const value = await this.tuple(record);
      if (options.filter && !Object.entries(options.filter).every(([key, expected]) => value.metadata[key] === expected)) {
        continue;
      }
      if (remaining !== undefined) {
        if (remaining <= 0) break;
        remaining -= 1;
      }
      yield value;
    }
  }

  async put(config, checkpoint, metadata) {
    const { threadId, checkpointNs, checkpointId: parentCheckpointId } = configParts(config);
    requiredString(checkpoint && checkpoint.id, 'checkpoint.id');
    const [serializedCheckpoint, serializedMetadata] = await Promise.all([
      this.serialize(copyCheckpoint(checkpoint)),
      this.serialize(metadata),
    ]);
    await this.backend.putCheckpoint({
      threadId,
      checkpointNs,
      checkpointId: checkpoint.id,
      parentCheckpointId: parentCheckpointId || null,
      checkpoint: serializedCheckpoint,
      metadata: serializedMetadata,
      timestamp: checkpoint.ts || new Date().toISOString(),
    });
    return { configurable: {
      thread_id: threadId,
      checkpoint_ns: checkpointNs,
      checkpoint_id: checkpoint.id,
    } };
  }

  async putWrites(config, writes, taskId) {
    const { threadId, checkpointNs, checkpointId } = configParts(config, { requireCheckpoint: true });
    requiredString(taskId, 'taskId');
    const records = await Promise.all(writes.map(async ([channel, value], ordinal) => ({
      threadId,
      checkpointNs,
      checkpointId,
      taskId,
      channel,
      index: Object.prototype.hasOwnProperty.call(SPECIAL_WRITE_INDEX, channel)
        ? SPECIAL_WRITE_INDEX[channel]
        : ordinal,
      value: await this.serialize(value),
    })));
    await this.backend.putWrites(records);
  }

  async deleteThread(threadId) {
    requiredString(threadId, 'threadId');
    await this.backend.deleteThread(threadId);
  }
}

function createPipelineCheckpointer({
  backend = CONFIG.STORE_BACKEND,
  file = path.join(CONFIG.DATA_DIR, 'pipeline-checkpoints.json'),
  rootCollection = namespaceCollection('aifleet_pipeline_checkpoints'),
  firestoreFactory,
  serde,
} = {}) {
  let checkpointBackend;
  if (backend === 'firestore') {
    checkpointBackend = new FirestoreCheckpointBackend({
      rootCollection,
      projectId: CONFIG.GCP.projectId,
      databaseId: process.env.FIRESTORE_DATABASE || undefined,
      firestoreFactory,
    });
  } else if (backend === 'file') {
    checkpointBackend = new JsonCheckpointBackend({ file });
  } else {
    throw new TypeError(`Unsupported durable checkpoint backend "${backend}".`);
  }
  return new DurablePipelineCheckpointer({ backend: checkpointBackend, serde });
}

module.exports = {
  JsonCheckpointBackend,
  FirestoreCheckpointBackend,
  DurablePipelineCheckpointer,
  createPipelineCheckpointer,
};
