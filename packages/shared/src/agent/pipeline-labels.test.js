'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LABEL_TRANSITIONS, linearProjectId, projectStageResult } = require('./pipeline-labels');

function command(stage, workItem = { linearProjectId: 'linear-project-1' }) {
  return {
    stage,
    projectId: 'native-project-1',
    preflight: { workItem },
    input: { request: {} },
  };
}

function dependencies(labels) {
  const writes = [];
  return {
    writes,
    store: { getApiKey: () => 'linear-key' },
    linear: {
      getProjects: async () => [{ id: 'linear-project-1', labels: { nodes: labels } }],
      getOrCreateProjectLabel: async (apiKey, name) => ({ id: `id-${name}`, name }),
      setProjectLabels: async (apiKey, projectId, labelIds) => writes.push({ apiKey, projectId, labelIds }),
    },
  };
}

test('terminal label transitions are fixed projections, and only for test', () => {
  assert.deepEqual(LABEL_TRANSITIONS.test, { from: 'aidone', succeeded: 'aitested', failed: 'aitestfail' });
  // The deploy stage was retired with the Cloud Run deployer (2026-11): runs
  // end after test, so no deploy labels may ever be projected again.
  assert.equal(LABEL_TRANSITIONS.deploy, undefined);
});

test('tester success swaps only aidone and preserves unrelated labels', async () => {
  const deps = dependencies([
    { id: 'old-terminal', name: 'AiDone' },
    { id: 'keep-me', name: 'customer-priority' },
  ]);
  const result = await projectStageResult(command('test'), { status: 'succeeded' }, deps);
  assert.deepEqual(result, { projected: true, label: 'aitested' });
  assert.deepEqual(deps.writes, [{
    apiKey: 'linear-key',
    projectId: 'linear-project-1',
    labelIds: ['keep-me', 'id-aitested'],
  }]);
});

test('retired deploy-stage results are never projected to Linear', async () => {
  const deps = dependencies([{ id: 'tested', name: 'aitested' }]);
  const result = await projectStageResult(command('deploy'), { status: 'failed' }, deps);
  assert.deepEqual(result, { projected: false, skipped: 'unsupported-stage' });
  assert.deepEqual(deps.writes, []);
});

test('cancelled stages do not masquerade as terminal failures in Linear', async () => {
  const deps = dependencies([{ id: 'tested', name: 'aitested' }]);
  const result = await projectStageResult(command('test'), { status: 'cancelled' }, deps);
  assert.deepEqual(result, { projected: false, skipped: 'non-projectable-status' });
  assert.deepEqual(deps.writes, []);
});

test('a missing expected source label is a no-op because labels are not pipeline authority', async () => {
  const deps = dependencies([{ id: 'other', name: 'backlog' }]);
  const result = await projectStageResult(command('test'), { status: 'succeeded' }, deps);
  assert.deepEqual(result, { projected: false, skipped: 'source-label-missing', expected: 'aidone' });
  assert.deepEqual(deps.writes, []);
});

test('native StageCommand project scope is never mistaken for a Linear project id', () => {
  assert.equal(linearProjectId(command('test', {})), '');
  assert.equal(linearProjectId({
    projectId: 'native-project-1',
    preflight: { workItem: {} },
    input: { request: { projectId: 'legacy-linear-project' } },
  }), 'legacy-linear-project');
});
