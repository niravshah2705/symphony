'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPipelineCheckpointer, DurablePipelineCheckpointer, FirestoreCheckpointBackend } = require('./checkpointer');

function checkpoint(id, value) {
  return {
    v: 4,
    id,
    ts: '2026-08-13T00:00:00.000Z',
    channel_values: { value },
    channel_versions: { value: 1 },
    versions_seen: {},
  };
}

test('JSON LangGraph checkpoints and pending writes survive process reconstruction', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-checkpointer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'checkpoints.json');
  const first = createPipelineCheckpointer({ backend: 'file', file });
  const base = { configurable: { thread_id: 'run-1', checkpoint_ns: '' } };

  const firstConfig = await first.put(base, checkpoint('0001', 'one'), { source: 'input', step: -1, parents: {} });
  await first.putWrites(firstConfig, [['result', { ok: true }]], 'task-1');
  await first.put(firstConfig, checkpoint('0002', 'two'), { source: 'loop', step: 0, parents: {} });

  const reconstructed = createPipelineCheckpointer({ backend: 'file', file });
  const latest = await reconstructed.getTuple(base);
  assert.equal(latest.checkpoint.id, '0002');
  assert.equal(latest.checkpoint.channel_values.value, 'two');
  assert.equal(latest.parentConfig.configurable.checkpoint_id, '0001');

  const prior = await reconstructed.getTuple(firstConfig);
  assert.deepEqual(prior.pendingWrites, [['task-1', 'result', { ok: true }]]);
  const history = [];
  for await (const item of reconstructed.list(base)) history.push(item);
  assert.equal(history.length, 2);

  await reconstructed.deleteThread('run-1');
  assert.equal(await reconstructed.getTuple(base), undefined);
});

test('the cloud checkpointer factory rejects memory and constructs a Firestore-backed saver', () => {
  assert.throws(() => createPipelineCheckpointer({ backend: 'memory' }), /Unsupported durable checkpoint backend/);
  const firestoreFactory = () => ({ collection() { throw new Error('lazy'); } });
  const saver = createPipelineCheckpointer({ backend: 'firestore', firestoreFactory });
  assert.equal(saver instanceof DurablePipelineCheckpointer, true);
  assert.equal(saver.backend instanceof FirestoreCheckpointBackend, true);
  assert.equal(saver.backend.db, null, 'Firestore initialization remains lazy until first use');
});
