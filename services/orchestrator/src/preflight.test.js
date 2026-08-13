'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPipelineStart } = require('@ai-fleet/shared-core/pipeline/contracts');
const { SnapshotPreflight } = require('./preflight');

const clock = () => '2026-08-13T00:00:00.000Z';

function fullRun(request = {}) {
  return createPipelineStart({
    runId: 'run-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages: ['plan', 'code', 'test', 'deploy'],
    request,
  }, { clock });
}

test('deployment is disabled by default', async () => {
  await assert.rejects(
    () => new SnapshotPreflight({ clock }).capture(fullRun()),
    (error) => error.code === 'pipeline_deployment_disabled',
  );
});

test('enabled deployment preflight strips every caller approval before persistence', async () => {
  const snapshot = await new SnapshotPreflight({
    clock,
    deploymentEnabled: true,
  }).capture(fullRun({
    stageConfiguration: {
      deploy: {
        enabled: true,
        environment: 'production',
        approval: { approved: true, by: 'attacker', at: clock(), source: 'caller' },
      },
    },
  }));
  assert.equal(snapshot.stageConfiguration.deploy.approval, null);
  assert.equal(snapshot.metadata.deploymentApproval, undefined);
});
