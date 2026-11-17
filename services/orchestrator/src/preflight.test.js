'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPipelineStart } = require('@ai-fleet/shared-core/pipeline/contracts');
const { SnapshotPreflight } = require('./preflight');

const clock = () => '2026-08-13T00:00:00.000Z';

function start(requestedStages, request = {}) {
  return createPipelineStart({
    runId: 'run-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages,
    request,
  }, { clock });
}

test('the retired deploy stage is rejected at preflight', async () => {
  await assert.rejects(
    () => new SnapshotPreflight({ clock }).capture(start(['plan', 'code', 'test', 'deploy'])),
    (error) => error.code === 'pipeline_deploy_retired' && error.status === 410,
  );
});

test('runs that end after test capture a snapshot', async () => {
  const snapshot = await new SnapshotPreflight({ clock }).capture(
    start(['plan', 'code', 'test'], { stageConfiguration: {} }),
  );
  assert.deepEqual(snapshot.requestedStages, ['plan', 'code', 'test']);
  assert.equal(snapshot.metadata.deploymentApproval, undefined);
});
