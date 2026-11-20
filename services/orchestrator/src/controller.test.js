'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryPipelineStore } = require('@software-factory/shared-core/pipeline/storage');
const { PipelineRunRepository } = require('@software-factory/shared-core/pipeline/repository');
const { createStageResultV1, createPreflightSnapshot } = require('@software-factory/shared-core/pipeline/contracts');
const { PipelineOrchestrator } = require('./controller');
const { SnapshotPreflight } = require('./preflight');
const { fakeLangGraph } = require('./fake-langgraph.test-helper');

const clock = () => '2026-08-12T10:00:00.000Z';

function start(stages = ['plan', 'code']) {
  return {
    runId: 'run-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages: stages,
    request: {
      repository: { provider: 'github', owner: 'acme', name: 'fleet' },
      workItem: { id: 'issue-id', identifier: 'ENG-42' },
    },
  };
}

function result(command, status = 'succeeded', extra = {}) {
  return createStageResultV1({
    runId: command.runId,
    stage: command.stage,
    attempt: command.attempt,
    status,
    ...(status === 'failed'
      ? { error: { code: 'stage_failed', message: 'Worker failed', retryable: true } }
      : {}),
    ...(status === 'succeeded' && ['code', 'test'].includes(command.stage)
      ? { artifact: { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) } }
      : {}),
    ...extra,
  }, { clock });
}

function setup({
  store = new MemoryPipelineStore(),
  dispatch,
  cancel,
  graph,
  preflight,
} = {}) {
  const commands = [];
  const repository = new PipelineRunRepository({ store, clock });
  const bus = {
    async dispatch(command) {
      commands.push(command);
      if (dispatch) return dispatch(command);
      return { messageId: `message:${command.commandId}`, transport: 'direct' };
    },
    ...(cancel ? { cancel } : {}),
  };
  const orchestrator = new PipelineOrchestrator({
    repository,
    bus,
    clock,
    langgraph: fakeLangGraph(),
    graph,
    preflight: preflight || new SnapshotPreflight({ clock }),
  });
  return { orchestrator, repository, commands, store };
}

test('start checkpoints preflight and dispatches the first requested stage', async () => {
  const context = setup();
  const status = await context.orchestrator.start(start());

  assert.equal(status.run.status, 'waiting');
  assert.equal(status.run.preflight.kind, 'pipeline.preflight.snapshot.v1');
  assert.deepEqual(context.commands.map((command) => command.stage), ['plan']);
  assert.equal(context.commands[0].commandId, 'run-1:plan:1');
});

test('deferred start durably admits without dispatching until advance', async () => {
  const context = setup();

  const admitted = await context.orchestrator.start(start(['plan']), { deferDispatch: true });

  assert.equal(admitted.run.status, 'queued');
  assert.deepEqual(context.commands, []);
  const dispatched = await context.orchestrator.advance('run-1');
  assert.equal(dispatched.run.status, 'waiting');
  assert.equal(context.commands[0].commandId, 'run-1:plan:1');
});

test('successful completion resumes from the durable checkpoint and dispatches the next selected stage', async () => {
  const context = setup();
  await context.orchestrator.start(start());
  await context.orchestrator.handleStageResult(result(context.commands[0]));

  assert.deepEqual(context.commands.map((command) => command.stage), ['plan', 'code']);
  const finalStatus = await context.orchestrator.handleStageResult(result(context.commands[1]));
  assert.equal(finalStatus.run.status, 'succeeded');
  assert.deepEqual(finalStatus.run.checkpoint.completedStages, ['plan', 'code']);

  await context.orchestrator.handleStageResult(result(context.commands[1]));
  assert.equal(context.commands.length, 2, 'duplicate completion must not advance twice');
});

test('redelivery advances a completion committed before graph resume', async () => {
  const context = setup();
  await context.orchestrator.start(start());
  const planResult = result(context.commands[0]);

  // Simulate a process dying after the durable result transaction but before
  // PipelineOrchestrator.handleStageResult could invoke the graph.
  await context.repository.completeStage(planResult);
  const recovered = await context.orchestrator.handleStageResult(planResult);

  assert.equal(recovered.run.status, 'waiting');
  assert.deepEqual(context.commands.map((command) => command.stage), ['plan', 'code']);
});

test('redelivery retries only a next-stage command whose publish failed', async () => {
  let failTestDispatch = true;
  const context = setup({
    dispatch: async (command) => {
      if (command.stage === 'code' && failTestDispatch) {
        throw Object.assign(new Error('stage service unavailable'), { code: 'unavailable' });
      }
      return { messageId: `message:${command.commandId}`, transport: 'direct' };
    },
  });
  await context.orchestrator.start(start());
  const planResult = result(context.commands[0]);
  await assert.rejects(
    () => context.orchestrator.handleStageResult(planResult),
    /stage service unavailable/,
  );

  failTestDispatch = false;
  const recovered = await context.orchestrator.handleStageResult(planResult);
  assert.equal(recovered.run.status, 'waiting');
  assert.deepEqual(
    context.commands.map((command) => command.commandId),
    ['run-1:plan:1', 'run-1:code:1', 'run-1:code:1'],
  );
});

test('resume after reconstruction safely re-dispatches the same active idempotency key', async () => {
  const store = new MemoryPipelineStore();
  const first = setup({ store });
  await first.orchestrator.start(start(['plan']));

  const reconstructed = setup({ store });
  const resumed = await reconstructed.orchestrator.resume('run-1');

  assert.equal(resumed.run.status, 'waiting');
  assert.equal(reconstructed.commands[0].commandId, 'run-1:plan:1');
  assert.equal(reconstructed.commands[0].attempt, 1);
  assert.equal(resumed.stages[0].dispatch.count, 2);
});

test('a failed stage remains terminal until explicit retry, which creates the next attempt', async () => {
  const context = setup();
  await context.orchestrator.start(start(['plan']));
  const failed = await context.orchestrator.handleStageResult(result(context.commands[0], 'failed'));
  assert.equal(failed.run.status, 'failed');

  const unchanged = await context.orchestrator.resume('run-1');
  assert.equal(unchanged.run.status, 'failed');
  assert.equal(context.commands.length, 1);

  const retried = await context.orchestrator.resume('run-1', { retryFailed: true });
  assert.equal(retried.run.status, 'waiting');
  assert.equal(context.commands[1].commandId, 'run-1:plan:2');
});

test('cancel records an active cancellation request and a late result stops rather than advances the graph', async () => {
  const context = setup();
  await context.orchestrator.start(start());
  const cancelled = await context.orchestrator.cancel('run-1', { requestedBy: 'user-1', reason: 'No longer needed' });
  assert.equal(cancelled.run.status, 'cancellation_requested');
  assert.equal(cancelled.stages[0].status, 'cancellation_requested');

  const late = await context.orchestrator.handleStageResult(result(context.commands[0]));
  assert.equal(late.run.status, 'cancelled');
  assert.equal(late.stages[0].status, 'succeeded');
  assert.equal(context.commands.length, 1);
});

test('a positive stage-bus cancellation receipt confirms that active work actually stopped', async () => {
  const context = setup({
    cancel: async () => ({ cancelled: true, transport: 'test' }),
  });
  await context.orchestrator.start(start(['plan']));

  const cancelled = await context.orchestrator.cancel('run-1', { requestedBy: 'user-1' });

  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(cancelled.run.cancellation.state, 'confirmed');
  assert.equal(cancelled.stages[0].status, 'cancelled');
});

test('dispatch failure leaves a resumable checkpoint instead of creating a second attempt', async () => {
  let fail = true;
  const context = setup({
    dispatch: async (command) => {
      if (fail) throw Object.assign(new Error('stage service unavailable'), { code: 'unavailable' });
      return { messageId: `message:${command.commandId}`, transport: 'direct' };
    },
  });

  await assert.rejects(() => context.orchestrator.start(start(['plan'])), /stage service unavailable/);
  let status = await context.orchestrator.status('run-1');
  assert.equal(status.stages[0].status, 'dispatching');
  assert.equal(status.stages[0].attempt, 1);

  fail = false;
  status = await context.orchestrator.resume('run-1');
  assert.equal(status.run.status, 'waiting');
  assert.deepEqual(context.commands.map((command) => command.commandId), ['run-1:plan:1', 'run-1:plan:1']);
});

// The deploy stage was retired with the Cloud Run deployer (2026-11): a run
// already carrying deploy in requestedStages must close as succeeded at the
// deploy transition instead of dispatching anything. Preflight rejects deploy
// for NEW runs, so this exercises the legacy path with a stub snapshot.
test('a legacy run reaching the deploy transition closes as succeeded', async () => {
  const legacyPreflight = {
    async capture(st) {
      return createPreflightSnapshot({
        runId: st.runId,
        organizationId: st.organizationId,
        projectId: st.projectId,
        requestedStages: st.requestedStages,
        repository: {},
        workItem: {},
        stageConfiguration: {},
        policy: {},
        capturedAt: clock(),
        metadata: { source: 'test-legacy' },
      }, { clock });
    },
  };
  const context = setup({ preflight: legacyPreflight });
  await context.orchestrator.start(start(['plan', 'code', 'test', 'deploy']));
  for (const stage of ['plan', 'code', 'test']) {
    const command = context.commands.at(-1);
    assert.equal(command.stage, stage);
    await context.orchestrator.handleStageResult(result(command, 'succeeded'));
  }

  const status = await context.orchestrator.status('run-1');
  assert.equal(status.run.status, 'succeeded');
  assert.equal(status.run.pendingDeploymentApproval, null);
  assert.deepEqual(context.commands.map((command) => command.stage), ['plan', 'code', 'test']);

  const again = await context.orchestrator.advance('run-1');
  assert.equal(again.run.status, 'succeeded');
  assert.equal(context.commands.length, 3, 'a retired stage must never re-dispatch');
});
