'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createPreflightSnapshot,
  createStageCommandV1,
  createStageResultV1,
} = require('@ai-fleet/shared-core/pipeline/contracts');
const {
  MemoryStageExecutionStore,
  JsonFileStageExecutionStore,
  FirestoreStageExecutionStore,
  createStageExecutionStore,
  documentId,
} = require('./pipeline-stage-execution-store');

const NOW = '2026-08-13T10:00:00.000Z';

function command() {
  const requestedStages = ['plan', 'code', 'test'];
  const preflight = createPreflightSnapshot({
    runId: 'durable-worker-run',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages,
    stageConfiguration: { test: {} },
  }, { clock: () => NOW });
  return createStageCommandV1({
    runId: preflight.runId,
    organizationId: preflight.organizationId,
    projectId: preflight.projectId,
    requestedStages,
    preflight,
    stage: 'test',
    attempt: 1,
  }, { clock: () => NOW });
}

function result(value = command()) {
  const artifact = { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) };
  return createStageResultV1({
    runId: value.runId,
    stage: value.stage,
    attempt: value.attempt,
    status: 'succeeded',
    output: { summary: 'done', artifact },
    artifact,
  }, { clock: () => NOW });
}

test('memory store claims once and replays the exact durable completion', async () => {
  const value = command();
  const store = new MemoryStageExecutionStore({ leaseMs: 100, now: () => 1_000 });
  const claim = await store.claim(value, { startedAt: NOW });
  assert.equal(claim.acquired, true);
  assert.deepEqual(await store.claim(value, { startedAt: NOW }), {
    acquired: false,
    state: 'in_progress',
  });
  const completion = result(value);
  await store.complete(value, claim.claimId, completion);
  assert.deepEqual(await store.claim(value, { startedAt: NOW }), {
    acquired: false,
    state: 'completed',
    result: completion,
  });
});

test('expired execution lease fails safe to a durable unknown-outcome result without reacquisition', async () => {
  let nowMs = 1_000;
  const value = command();
  const store = new MemoryStageExecutionStore({ leaseMs: 100, now: () => nowMs });
  const first = await store.claim(value, { startedAt: NOW });
  assert.equal(first.acquired, true);
  nowMs = 1_101;
  const recoveredResult = createStageResultV1({
    runId: value.runId,
    stage: value.stage,
    attempt: value.attempt,
    status: 'failed',
    output: {},
    error: { code: 'stage_execution_outcome_unknown', message: 'Unknown outcome.', retryable: false },
  }, { clock: () => NOW });
  const recovered = await store.claim(value, {
    startedAt: NOW,
    recoverExpired: () => recoveredResult,
  });
  assert.equal(recovered.acquired, false);
  assert.equal(recovered.state, 'recovered');
  assert.deepEqual(recovered.result, recoveredResult);
  assert.equal((await store.claim(value, { startedAt: NOW })).state, 'completed');
});

test('local file store replays a completion after a new store instance starts', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-worker-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'test.json');
  const value = command();
  const firstStore = new JsonFileStageExecutionStore({ file, now: () => 1_000 });
  const claim = await firstStore.claim(value, { startedAt: NOW });
  await firstStore.complete(value, claim.claimId, result(value));

  const restarted = new JsonFileStageExecutionStore({ file, now: () => 2_000 });
  const replay = await restarted.claim(value, { startedAt: NOW });
  assert.equal(replay.state, 'completed');
  assert.equal(replay.result.output.summary, 'done');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.records[documentId(value.idempotencyKey)].status, 'completed');
});

test('Firestore store transactionally replays a completion across worker instances', async () => {
  const documents = new Map();
  const fakeFirestore = {
    collection(name) {
      return { doc: (id) => ({ path: `${name}/${id}` }) };
    },
    async runTransaction(operation) {
      const writes = [];
      const result = await operation({
        async get(ref) {
          const data = documents.get(ref.path);
          return { exists: data !== undefined, data: () => data };
        },
        set(ref, data) { writes.push([ref.path, structuredClone(data)]); },
      });
      for (const [key, value] of writes) documents.set(key, value);
      return result;
    },
  };
  const factory = () => fakeFirestore;
  const value = command();
  const first = new FirestoreStageExecutionStore({ firestoreFactory: factory, now: () => 1_000 });
  const claim = await first.claim(value, { startedAt: NOW });
  await first.complete(value, claim.claimId, result(value));

  const restarted = new FirestoreStageExecutionStore({ firestoreFactory: factory, now: () => 2_000 });
  const replay = await restarted.claim(value, { startedAt: NOW });
  assert.equal(replay.acquired, false);
  assert.equal(replay.state, 'completed');
  assert.equal(replay.result.output.summary, 'done');
});

test('production worker store refuses non-Firestore durability', () => {
  assert.throws(
    () => createStageExecutionStore({
      stage: 'plan',
      env: { NODE_ENV: 'production', PIPELINE_STAGE_STORE_BACKEND: 'memory' },
    }),
    /require.*firestore/i,
  );
});
