'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FirestorePipelineStore, documentId } = require('./storage');
const { PipelineRunRepository } = require('./repository');
const { createPipelineStart, createPreflightSnapshot, createStageCommandV1 } = require('./contracts');

function makeFakeFirestore() {
  const documents = new Map();
  let transactionCount = 0;

  function snapshot(data) {
    return { exists: data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };
  }

  class DocumentRef {
    constructor(key) { this.key = key; }
    collection(name) { return new CollectionRef(`${this.key}/${name}`); }
    async get() { return snapshot(documents.get(this.key)); }
  }

  class CollectionRef {
    constructor(key) { this.key = key; }
    doc(id) { return new DocumentRef(`${this.key}/${id}`); }
    async get() {
      const prefix = `${this.key}/`;
      return {
        docs: [...documents.entries()]
          .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
          .map(([key, data]) => ({ id: key.slice(prefix.length), data: () => structuredClone(data) })),
      };
    }
  }

  return {
    documents,
    get transactionCount() { return transactionCount; },
    collection(name) { return new CollectionRef(name); },
    async runTransaction(callback) {
      transactionCount += 1;
      const pending = new Map(documents);
      const transaction = {
        get: async (ref) => snapshot(pending.get(ref.key)),
        set: (ref, value) => { pending.set(ref.key, structuredClone(value)); },
      };
      const result = await callback(transaction);
      documents.clear();
      for (const [key, value] of pending) documents.set(key, value);
      return result;
    },
  };
}

test('FirestorePipelineStore persists runs and stage attempts in hashed transactionally updated documents', async () => {
  const fake = makeFakeFirestore();
  const store = new FirestorePipelineStore({
    rootCollection: 'aifleet_pipeline_runs__tenant',
    firestoreFactory: () => fake,
  });
  const clock = () => '2026-08-12T10:00:00.000Z';
  const repository = new PipelineRunRepository({ store, clock });
  const start = createPipelineStart({
    runId: 'customer:run-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages: ['plan'],
  }, { clock });
  const preflight = createPreflightSnapshot({
    runId: start.runId,
    organizationId: start.organizationId,
    projectId: start.projectId,
    requestedStages: start.requestedStages,
  }, { clock });
  const command = createStageCommandV1({
    runId: start.runId,
    organizationId: start.organizationId,
    projectId: start.projectId,
    requestedStages: start.requestedStages,
    preflight,
    stage: 'plan',
    attempt: 1,
  }, { clock });

  await repository.createRun(start);
  await repository.savePreflight(preflight);
  await repository.claimStage(command);

  const runPath = `aifleet_pipeline_runs__tenant/${documentId(start.runId)}`;
  const stagePath = `${runPath}/stages/${documentId(command.idempotencyKey)}`;
  assert.equal(fake.documents.has(runPath), true);
  assert.equal(fake.documents.has(stagePath), true);
  assert.equal([...fake.documents.keys()].some((key) => key.includes(start.runId)), false);
  assert.equal(fake.transactionCount, 3);
  assert.equal((await repository.listStageRuns(start.runId))[0].commandId, command.commandId);
});
