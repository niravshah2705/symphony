'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryPipelineStore, JsonFilePipelineStore } = require('./storage');
const { PipelineRunRepository } = require('./repository');
const {
  createPipelineStart,
  createPreflightSnapshot,
  createStageCommandV1,
  createStageResultV1,
} = require('./contracts');

function tickingClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 12, 10, 0, tick++)).toISOString();
}

function fixture({ stages = ['plan', 'code', 'test', 'deploy'], metadata = {} } = {}) {
  const contractClock = () => '2026-08-12T09:00:00.000Z';
  const start = createPipelineStart({
    runId: 'run-123',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages: stages,
    request: { workItemId: 'ENG-42' },
    metadata,
  }, { clock: contractClock });
  const preflight = createPreflightSnapshot({
    runId: start.runId,
    organizationId: start.organizationId,
    projectId: start.projectId,
    requestedStages: start.requestedStages,
    repository: {
      provider: 'github', owner: 'acme', name: 'fleet', fullName: 'acme/fleet', baseRevision: 'abc123',
    },
    stageConfiguration: stages.includes('deploy')
      ? { deploy: { enabled: true, environment: 'production' } }
      : {},
  }, { clock: contractClock });
  const command = (stage, attempt) => createStageCommandV1({
    runId: start.runId,
    organizationId: start.organizationId,
    projectId: start.projectId,
    requestedStages: start.requestedStages,
    preflight,
    stage,
    attempt,
  }, { clock: contractClock });
  const result = (stage, attempt, status = 'succeeded', extra = {}) => createStageResultV1({
    runId: start.runId,
    stage,
    attempt,
    status,
    ...(status === 'failed'
      ? { error: { code: 'stage_failed', message: `${stage} failed`, retryable: true } }
      : {}),
    ...(status === 'succeeded' && ['code', 'test', 'deploy'].includes(stage)
      ? { artifact: { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) } }
      : {}),
    ...extra,
  }, { clock: contractClock });
  return { start, preflight, command, result };
}

function memoryRepository(store = new MemoryPipelineStore()) {
  return new PipelineRunRepository({ store, clock: tickingClock() });
}

async function prepare(repository, values) {
  await repository.createRun(values.start);
  await repository.savePreflight(values.preflight);
}

test('PipelineRun and StageRun lifecycle is durable and advances only the explicitly requested stages', async () => {
  const repository = memoryRepository();
  const values = fixture({ stages: ['plan', 'code', 'test'] });
  await prepare(repository, values);

  await assert.rejects(() => repository.claimStage(values.command('test', 1)), /not the expected stage/);
  const planClaim = await repository.claimStage(values.command('plan', 1));
  assert.equal(planClaim.acquired, true);
  assert.equal(planClaim.stageRun.idempotencyKey, 'run-123:plan:1');
  await repository.markDispatched(planClaim.stageRun.idempotencyKey, { messageId: 'message-1', transport: 'direct' });
  const planCompletion = await repository.completeStage(values.result('plan', 1));
  assert.equal(planCompletion.applied, true);
  assert.equal(planCompletion.run.status, 'queued');
  assert.deepEqual(planCompletion.run.checkpoint.completedStages, ['plan']);
  assert.equal(planCompletion.run.checkpoint.nextStageIndex, 1);

  const codeClaim = await repository.claimStage(values.command('code', 1));
  await repository.completeStage(values.result('code', 1));
  const testClaim = await repository.claimStage(values.command('test', 1));
  await repository.completeStage(values.result('test', 1));
  const status = await repository.getStatus(values.start.runId);
  assert.equal(testClaim.acquired, true);
  assert.equal(status.run.status, 'succeeded');
  assert.deepEqual(status.stages.map((stage) => stage.stage), ['plan', 'code', 'test']);
  assert.equal(codeClaim.acquired, true);
});

test('the runId:stage:attempt claim is transactional under concurrent delivery', async () => {
  const repository = memoryRepository();
  const values = fixture({ stages: ['plan'] });
  await prepare(repository, values);
  const stageCommand = values.command('plan', 1);

  const claims = await Promise.all(Array.from({ length: 12 }, () => repository.claimStage(stageCommand)));

  assert.equal(claims.filter((claim) => claim.acquired).length, 1);
  assert.equal(claims.filter((claim) => !claim.acquired).length, 11);
  assert.equal((await repository.listStageRuns(values.start.runId)).length, 1);
});

test('runId retries ignore a regenerated receipt timestamp but reject changed intent', async () => {
  const repository = memoryRepository();
  const values = fixture({ stages: ['plan'] });
  const first = await repository.createRun(values.start);
  const retried = await repository.createRun({
    ...values.start,
    createdAt: '2026-08-12T09:00:01.000Z',
  });

  assert.equal(first.created, true);
  assert.equal(retried.created, false);
  assert.equal(retried.run.start.createdAt, values.start.createdAt);
  await assert.rejects(() => repository.createRun({
    ...values.start,
    createdAt: '2026-08-12T09:00:02.000Z',
    request: { workItemId: 'ENG-99' },
  }), /different pipeline run/);
});

test('labels are metadata, never a stage-selection control bus', async () => {
  const repository = memoryRepository();
  const values = fixture({ stages: ['plan'], metadata: { labels: ['code', 'deploy', 'aiplanned'] } });
  await prepare(repository, values);

  await repository.claimStage(values.command('plan', 1));
  const completion = await repository.completeStage(values.result('plan', 1));
  assert.equal(completion.run.status, 'succeeded');
  assert.deepEqual(completion.run.requestedStages, ['plan']);
});

test('duplicate results are idempotent while conflicting terminal results are rejected', async () => {
  const repository = memoryRepository();
  const values = fixture({ stages: ['plan'] });
  await prepare(repository, values);
  await repository.claimStage(values.command('plan', 1));
  const success = values.result('plan', 1);

  assert.equal((await repository.completeStage(success)).applied, true);
  assert.equal((await repository.completeStage(success)).applied, false);
  await assert.rejects(
    () => repository.completeStage(values.result('plan', 1, 'failed')),
    /conflicting result/,
  );
});

test('dispatch failures persist only a bounded non-secret diagnostic', async () => {
  const repository = memoryRepository();
  const values = fixture({ stages: ['plan'] });
  await prepare(repository, values);
  const claim = await repository.claimStage(values.command('plan', 1));

  const updated = await repository.markDispatchFailed(claim.stageRun.idempotencyKey, Object.assign(
    new Error('fetch failed for https://user:password@example.test'),
    { code: 'UPSTREAM SECRET' },
  ));
  assert.deepEqual(updated.stageRun.dispatch.lastError, {
    code: 'pipeline_dispatch_failed',
    message: 'Stage command dispatch failed.',
  });
});

test('a stale dispatch acknowledgement cannot regress a completed or no-longer-active stage', async () => {
  const repository = memoryRepository();
  const values = fixture({ stages: ['plan', 'code', 'test'] });
  await prepare(repository, values);
  await repository.claimStage(values.command('plan', 1));
  await repository.completeStage(values.result('plan', 1));
  await repository.claimStage(values.command('code', 1));
  const before = await repository.getRun(values.start.runId);

  const stale = await repository.markDispatched('run-123:plan:1', {
    messageId: 'late-plan-ack',
    transport: 'pubsub',
  });

  assert.equal(stale.applied, false);
  assert.equal(stale.ignored, 'stage_not_active');
  assert.equal(stale.stageRun.status, 'succeeded');
  assert.equal(stale.run.status, 'running');
  assert.equal(stale.run.checkpoint.activeCommandId, 'run-123:code:1');
  assert.equal(stale.run.checkpoint.revision, before.checkpoint.revision);
});

test('stage history is ordered by requested stage and then attempt, independent of timestamps', async () => {
  const store = new MemoryPipelineStore();
  const repository = memoryRepository(store);
  const values = fixture({ stages: ['plan', 'code', 'test'] });
  await prepare(repository, values);
  await repository.claimStage(values.command('plan', 1));
  await repository.completeStage(values.result('plan', 1, 'failed'));
  await repository.reopenFailedRun(values.start.runId);
  await repository.claimStage(values.command('plan', 2));
  await repository.completeStage(values.result('plan', 2));
  await repository.claimStage(values.command('code', 1));
  await repository.completeStage(values.result('code', 1));
  await repository.claimStage(values.command('test', 1));

  for (const stageRun of Object.values(store.state.stages)) {
    stageRun.createdAt = stageRun.stage === 'test'
      ? '2020-01-01T00:00:00.000Z'
      : `2040-01-01T00:00:0${3 - stageRun.attempt}.000Z`;
  }

  assert.deepEqual(
    (await repository.listStageRuns(values.start.runId)).map((stageRun) => stageRun.commandId),
    ['run-123:plan:1', 'run-123:plan:2', 'run-123:code:1', 'run-123:test:1'],
  );
});

test('the 100-attempt ceiling is a typed conflict and a failed run is not reopened', async () => {
  const store = new MemoryPipelineStore();
  const repository = memoryRepository(store);
  const values = fixture({ stages: ['plan'] });
  await prepare(repository, values);
  await repository.claimStage(values.command('plan', 1));
  await repository.completeStage(values.result('plan', 1, 'failed'));
  store.state.runs[values.start.runId].checkpoint.attempts.plan = 100;

  await assert.rejects(
    () => repository.reopenFailedRun(values.start.runId),
    (error) => error.code === 'pipeline_attempt_limit_reached' && error.status === 409,
  );
  assert.equal((await repository.getRun(values.start.runId)).status, 'failed');
  await assert.rejects(
    () => repository.nextAttempt(values.start.runId, 'plan'),
    (error) => error.code === 'pipeline_attempt_limit_reached' && error.status === 409,
  );
});

test('failed runs can be explicitly reopened and active cancellation remains requested until work stops', async () => {
  const repository = memoryRepository();
  const values = fixture({ stages: ['plan', 'code'] });
  await prepare(repository, values);
  await repository.claimStage(values.command('plan', 1));
  await repository.completeStage(values.result('plan', 1, 'failed'));

  const reopened = await repository.reopenFailedRun(values.start.runId);
  assert.equal(reopened.changed, true);
  assert.equal(reopened.run.status, 'queued');
  assert.equal(await repository.nextAttempt(values.start.runId, 'plan'), 2);
  await repository.claimStage(values.command('plan', 2));
  await repository.completeStage(values.result('plan', 2));
  await repository.claimStage(values.command('code', 1));

  const cancelled = await repository.cancelRun(values.start.runId, { requestedBy: 'user-1', reason: 'Superseded' });
  assert.equal(cancelled.changed, true);
  assert.equal(cancelled.run.status, 'cancellation_requested');
  assert.equal(cancelled.activeStage.status, 'cancellation_requested');
  const late = await repository.completeStage(values.result('code', 1));
  assert.equal(late.applied, true);
  assert.equal(late.stageRun.status, 'succeeded');
  assert.equal(late.run.cancellation.state, 'completed');
  assert.equal((await repository.getRun(values.start.runId)).status, 'cancelled');
});

test('deployment approval wait is durable and only valid immediately before deploy', async () => {
  const repository = memoryRepository();
  const values = fixture({ stages: ['plan', 'code', 'test', 'deploy'] });
  await prepare(repository, values);
  await assert.rejects(
    () => repository.markAwaitingApproval(values.start.runId),
    (error) => error.code === 'pipeline_approval_out_of_order',
  );
  for (const stage of ['plan', 'code', 'test']) {
    const attempt = 1;
    await repository.claimStage(values.command(stage, attempt));
    await repository.completeStage(values.result(stage, attempt));
  }
  const waiting = await repository.markAwaitingApproval(values.start.runId);
  assert.equal(waiting.changed, true);
  assert.equal(waiting.run.status, 'awaiting_approval');
  assert.deepEqual(waiting.run.pendingDeploymentApproval, {
    runId: 'run-123',
    projectId: 'project-1',
    repository: 'acme/fleet',
    environment: 'production',
    testCommandId: 'run-123:test:1',
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
    preflightDecisionDigest: values.preflight.preflightDecisionDigest,
  });
  const replay = await repository.markAwaitingApproval(values.start.runId);
  assert.equal(replay.changed, false);
  assert.equal(replay.run.checkpoint.activeCommandId, null);
  assert.equal(await repository.nextAttempt(values.start.runId, 'deploy'), 1);
});

test('JsonFilePipelineStore survives repository reconstruction', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-repository-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'runs.json');
  const values = fixture({ stages: ['plan'] });
  const first = new PipelineRunRepository({ store: new JsonFilePipelineStore({ file }), clock: tickingClock() });
  await prepare(first, values);
  await first.claimStage(values.command('plan', 1));

  const reconstructed = new PipelineRunRepository({
    store: new JsonFilePipelineStore({ file }),
    clock: tickingClock(),
  });
  const status = await reconstructed.getStatus(values.start.runId);
  assert.equal(status.run.checkpoint.activeCommandId, 'run-123:plan:1');
  assert.equal(status.stages[0].status, 'dispatching');
});
