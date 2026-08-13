'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { createApp } = require('./app');
const {
  PipelineContractError,
  createStageResultV1,
} = require('@ai-fleet/shared-core/pipeline/contracts');
const { MemoryPipelineStore } = require('@ai-fleet/shared-core/pipeline/storage');
const { PipelineRunRepository } = require('@ai-fleet/shared-core/pipeline/repository');
const { toPipelinePushEnvelope } = require('@ai-fleet/shared-core/pipeline/bus');
const { PipelineOrchestrator } = require('./controller');
const { SnapshotPreflight } = require('./preflight');
const { fakeLangGraph } = require('./fake-langgraph.test-helper');
const DIRECT_TOKEN = 'test-internal-token';

function status(state = 'waiting') {
  return {
    run: {
      runId: 'run-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      requestedStages: ['plan'],
      status: state,
    },
    stages: [],
  };
}

function setup(overrides = {}) {
  const calls = { start: [], status: [], cancel: [], resume: [], results: [] };
  const orchestrator = {
    async start(input) { calls.start.push(input); return status(); },
    async status(runId) { calls.status.push(runId); return status(); },
    async cancel(runId, options) { calls.cancel.push({ runId, options }); return status('cancelled'); },
    async resume(runId, options) { calls.resume.push({ runId, options }); return status(); },
    async handleStageResult(result) { calls.results.push(result); return status(); },
    ...overrides.orchestrator,
  };
  const config = {
    messagingMode: 'direct',
    internalApiToken: DIRECT_TOKEN,
    resultAudience: '',
    resultAllowedEmails: [],
    ...overrides.config,
  };
  const logs = [];
  const logger = {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
    error: (message) => logs.push(['error', message]),
  };
  const app = createApp({
    orchestrator,
    config,
    logger,
    authenticatePush: Object.prototype.hasOwnProperty.call(overrides, 'authenticatePush')
      ? overrides.authenticatePush
      : ((req, res, next) => next()),
    verifyResultToken: overrides.verifyResultToken || (async () => {
      const error = new Error('OIDC rejected');
      error.status = 401;
      throw error;
    }),
  });
  return { app, orchestrator, calls, config, logs };
}

async function listen(context) {
  const server = context.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function jsonRequest(url, { method = 'GET', body, headers = {} } = {}) {
  return fetch(url, {
    method,
    headers: {
      'x-internal-token': DIRECT_TOKEN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function integratedSetup({ dispatch } = {}) {
  const clock = () => '2026-08-12T10:00:00.000Z';
  const store = new MemoryPipelineStore();
  const repository = new PipelineRunRepository({ store, clock });
  const commands = [];
  const orchestrator = new PipelineOrchestrator({
    repository,
    bus: {
      async dispatch(command) {
        commands.push(command);
        if (dispatch) return dispatch(command);
        return { messageId: `direct:${command.commandId}`, transport: 'direct' };
      },
    },
    preflight: new SnapshotPreflight({ clock }),
    langgraph: fakeLangGraph(),
    clock,
  });
  return {
    app: createApp({
      orchestrator,
      config: {
        messagingMode: 'direct',
        internalApiToken: DIRECT_TOKEN,
        resultAudience: '',
        resultAllowedEmails: [],
      },
      logger: { info() {}, warn() {}, error() {} },
    }),
    repository,
    store,
    commands,
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous dispatch.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('control API starts, reads, resumes, and cancels a scoped run', async (t) => {
  const context = setup();
  const { server, base } = await listen(context);
  t.after(() => server.close());
  const headers = {
    'x-ai-fleet-organization-id': 'org-1',
    'x-ai-fleet-project-id': 'project-1',
  };

  const created = await jsonRequest(`${base}/api/v1/pipeline-runs`, {
    method: 'POST',
    headers,
    body: { requestedStages: ['plan'], request: { workItem: { id: 'ENG-42' } } },
  });
  assert.equal(created.status, 202);
  assert.equal(context.calls.start[0].organizationId, 'org-1');
  assert.equal(context.calls.start[0].projectId, 'project-1');

  assert.equal((await jsonRequest(`${base}/api/v1/pipeline-runs/run-1`, { headers })).status, 200);
  assert.equal((await jsonRequest(`${base}/api/v1/pipeline-runs/run-1/resume`, {
    method: 'POST', headers, body: { retryFailed: true },
  })).status, 200);
  assert.deepEqual(context.calls.resume[0], { runId: 'run-1', options: { retryFailed: true } });

  const cancelled = await jsonRequest(`${base}/api/v1/pipeline-runs/run-1/cancel`, {
    method: 'POST', headers, body: { requestedBy: 'user-1', reason: 'Superseded' },
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).run.status, 'cancelled');
});

test('direct control and result ingress fail closed without a configured token', async (t) => {
  const context = setup({ config: { messagingMode: 'direct', internalApiToken: '' } });
  const { server, base } = await listen(context);
  t.after(() => server.close());

  const control = await fetch(`${base}/api/v1/pipeline-runs/run-1`);
  assert.equal(control.status, 503);
  assert.equal((await control.json()).code, 'pipeline_control_auth_unconfigured');
  const result = await fetch(`${base}/internal/pipeline/results`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'pipeline.stage.result.v1', runId: 'run-1', stage: 'plan' }),
  });
  assert.equal(result.status, 503);
  assert.equal((await result.json()).code, 'pipeline_result_auth_unconfigured');
});

test('direct HTTP cancellation reports requested until the active worker result actually stops it', async (t) => {
  const context = integratedSetup();
  const { server, base } = await listen(context);
  t.after(() => server.close());
  const headers = {
    'x-ai-fleet-organization-id': 'org-1',
    'x-ai-fleet-project-id': 'project-1',
  };
  const created = await jsonRequest(`${base}/api/v1/pipeline-runs`, {
    method: 'POST',
    headers,
    body: {
      runId: 'http-cancel-run',
      requestedStages: ['plan'],
      request: {},
    },
  });
  assert.equal(created.status, 202);
  await waitFor(() => context.commands.length === 1);
  const command = context.commands[0];

  const cancellation = await jsonRequest(`${base}/api/v1/pipeline-runs/http-cancel-run/cancel`, {
    method: 'POST', headers, body: { requestedBy: 'user-1', reason: 'Superseded' },
  });
  assert.equal(cancellation.status, 200);
  assert.equal((await cancellation.json()).run.status, 'cancellation_requested');

  const lateResult = createStageResultV1({
    runId: command.runId,
    stage: command.stage,
    attempt: command.attempt,
    status: 'succeeded',
  }, { clock: () => '2026-08-12T10:00:01.000Z' });
  assert.equal((await jsonRequest(`${base}/internal/pipeline/results`, {
    method: 'POST', body: lateResult,
  })).status, 204);
  const final = await jsonRequest(`${base}/api/v1/pipeline-runs/http-cancel-run`, { headers });
  const finalBody = await final.json();
  assert.equal(finalBody.run.status, 'cancelled');
  assert.equal(finalBody.stages[0].status, 'succeeded');
  assert.equal(finalBody.run.cancellation.state, 'completed');
});

test('direct HTTP retry returns typed 409 at attempt 100 without reopening the failed run', async (t) => {
  const context = integratedSetup();
  const { server, base } = await listen(context);
  t.after(() => server.close());
  const headers = {
    'x-ai-fleet-organization-id': 'org-1',
    'x-ai-fleet-project-id': 'project-1',
  };
  await jsonRequest(`${base}/api/v1/pipeline-runs`, {
    method: 'POST', headers,
    body: { runId: 'http-limit-run', requestedStages: ['plan'], request: {} },
  });
  await waitFor(() => context.commands.length === 1);
  const command = context.commands[0];
  const failure = createStageResultV1({
    runId: command.runId,
    stage: command.stage,
    attempt: command.attempt,
    status: 'failed',
    error: { code: 'worker_failed', message: 'Worker failed', retryable: true },
  }, { clock: () => '2026-08-12T10:00:01.000Z' });
  assert.equal((await jsonRequest(`${base}/internal/pipeline/results`, {
    method: 'POST', body: failure,
  })).status, 204);
  context.store.state.runs['http-limit-run'].checkpoint.attempts.plan = 100;

  const retry = await jsonRequest(`${base}/api/v1/pipeline-runs/http-limit-run/resume`, {
    method: 'POST', headers, body: { retryFailed: true },
  });

  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).code, 'pipeline_attempt_limit_reached');
  assert.equal((await context.repository.getRun('http-limit-run')).status, 'failed');
});

test('direct HTTP start returns after durable admission without waiting for stage execution', async (t) => {
  let releaseDispatch;
  const dispatchBlocked = new Promise((resolve) => { releaseDispatch = resolve; });
  const context = integratedSetup({
    dispatch: async (command) => {
      await dispatchBlocked;
      return { messageId: `direct:${command.commandId}`, transport: 'direct' };
    },
  });
  const { server, base } = await listen(context);
  t.after(() => {
    releaseDispatch();
    server.close();
  });

  const response = await Promise.race([
    jsonRequest(`${base}/api/v1/pipeline-runs`, {
      method: 'POST',
      body: {
        runId: 'http-prompt-run',
        organizationId: 'org-1',
        projectId: 'project-1',
        requestedStages: ['plan'],
        request: {},
      },
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('start waited for stage execution')),
      500,
    )),
  ]);

  assert.equal(response.status, 202);
  assert.equal((await response.json()).run.status, 'queued');
  await waitFor(() => context.commands.length === 1);
  releaseDispatch();
});

test('authoritative context cannot be overridden and cross-scope status is hidden as 404', async (t) => {
  const context = setup();
  const { server, base } = await listen(context);
  t.after(() => server.close());

  const mismatch = await jsonRequest(`${base}/api/v1/pipeline-runs`, {
    method: 'POST',
    headers: { 'x-ai-fleet-organization-id': 'org-1' },
    body: { organizationId: 'org-2', projectId: 'project-1', requestedStages: ['plan'] },
  });
  assert.equal(mismatch.status, 404);
  assert.equal(context.calls.start.length, 0);

  const hidden = await jsonRequest(`${base}/api/v1/pipeline-runs/run-1`, {
    headers: { 'x-ai-fleet-organization-id': 'org-2' },
  });
  assert.equal(hidden.status, 404);
  assert.equal((await hidden.json()).code, 'pipeline_run_not_found');
});

test('internal and Pub/Sub result endpoints accept the same StageResult body/envelope', async (t) => {
  const context = setup();
  const { server, base } = await listen(context);
  t.after(() => server.close());
  const result = { kind: 'pipeline.stage.result.v1', runId: 'run-1', stage: 'plan' };

  assert.equal((await jsonRequest(`${base}/internal/pipeline/results`, {
    method: 'POST', body: result,
  })).status, 204);
  assert.equal((await jsonRequest(`${base}/pubsub/pipeline-stage-results/plan`, {
    method: 'POST', body: toPipelinePushEnvelope(result),
  })).status, 204);
  assert.deepEqual(context.calls.results, [result, result]);
});

test('stage-specific Pub/Sub ingress rejects cross-stage forgery and has no generic bypass', async (t) => {
  const context = setup();
  const { server, base } = await listen(context);
  t.after(() => server.close());
  const codeResult = { kind: 'pipeline.stage.result.v1', runId: 'run-1', stage: 'code' };

  const mismatched = await jsonRequest(`${base}/pubsub/pipeline-stage-results/plan`, {
    method: 'POST', body: toPipelinePushEnvelope(codeResult),
  });
  const generic = await jsonRequest(`${base}/pubsub/pipeline-stage-results`, {
    method: 'POST', body: toPipelinePushEnvelope(codeResult),
  });

  assert.equal(mismatched.status, 204);
  assert.equal(generic.status, 404);
  assert.deepEqual(context.calls.results, []);
});

test('cloud mode exposes no direct internal result ingress despite a valid shared token', async (t) => {
  const context = setup({
    config: {
      messagingMode: 'pubsub',
      internalApiToken: 'internal-result-token',
      resultAudience: 'https://orchestrator.example.test',
      resultAllowedEmails: ['stage-worker@example.iam.gserviceaccount.com'],
    },
  });
  const { server, base } = await listen(context);
  t.after(() => server.close());
  const body = { kind: 'pipeline.stage.result.v1', runId: 'run-1', stage: 'plan' };

  const response = await jsonRequest(`${base}/internal/pipeline/results/plan`, {
    method: 'POST',
    headers: { 'x-internal-token': 'internal-result-token' },
    body,
  });
  assert.equal(response.status, 404);
  assert.deepEqual(context.calls.results, []);
});

test('cloud Pub/Sub ingress ignores the shared token and requires the push OIDC identity', async (t) => {
  const context = setup({
    config: {
      messagingMode: 'pubsub',
      internalApiToken: 'shared-token-is-not-push-auth',
      resultAudience: 'https://orchestrator.example.test',
      resultAllowedEmails: ['push@example.iam.gserviceaccount.com'],
    },
    authenticatePush: undefined,
  });
  const { server, base } = await listen(context);
  t.after(() => server.close());

  const response = await jsonRequest(`${base}/pubsub/pipeline-stage-results/plan`, {
    method: 'POST',
    headers: { 'x-internal-token': 'shared-token-is-not-push-auth' },
    body: toPipelinePushEnvelope({ stage: 'plan', runId: 'run-1' }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(context.calls.results, []);
});

test('direct result ingress requires the shared token when configured', async (t) => {
  const context = setup({
    config: { messagingMode: 'direct', internalApiToken: 'local-result-token' },
  });
  const { server, base } = await listen(context);
  t.after(() => server.close());
  const body = { kind: 'pipeline.stage.result.v1', runId: 'run-1' };

  assert.equal((await jsonRequest(`${base}/internal/pipeline/results`, {
    method: 'POST', body,
  })).status, 401);
  assert.equal((await jsonRequest(`${base}/internal/pipeline/results`, {
    method: 'POST', headers: { 'x-internal-token': 'local-result-token' }, body,
  })).status, 204);
});

test('direct stage-specific result ingress enforces the stage in its URL', async (t) => {
  const context = setup();
  const { server, base } = await listen(context);
  t.after(() => server.close());
  const codeResult = { kind: 'pipeline.stage.result.v1', runId: 'run-1', stage: 'code' };

  const mismatch = await jsonRequest(`${base}/internal/pipeline/results/plan`, {
    method: 'POST', body: codeResult,
  });
  const accepted = await jsonRequest(`${base}/internal/pipeline/results/code`, {
    method: 'POST', body: codeResult,
  });

  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).code, 'pipeline_result_stage_mismatch');
  assert.equal(accepted.status, 204);
  assert.deepEqual(context.calls.results, [codeResult]);
});

test('cloud internal ingress has neither a stage-specific nor generic shared-token bypass', async (t) => {
  const context = setup({
    config: {
      messagingMode: 'pubsub',
      internalApiToken: 'cloud-result-token',
      resultAudience: 'https://orchestrator.example.test',
      resultAllowedEmails: ['worker@example.iam.gserviceaccount.com'],
    },
  });
  const { server, base } = await listen(context);
  t.after(() => server.close());
  const headers = { 'x-internal-token': 'cloud-result-token' };
  const codeResult = { kind: 'pipeline.stage.result.v1', runId: 'run-1', stage: 'code' };

  const stageSpecific = await jsonRequest(`${base}/internal/pipeline/results/plan`, {
    method: 'POST', headers, body: codeResult,
  });
  const generic = await jsonRequest(`${base}/internal/pipeline/results`, {
    method: 'POST', headers, body: codeResult,
  });
  assert.equal(stageSpecific.status, 404);
  assert.equal(generic.status, 404);
  assert.deepEqual(context.calls.results, []);
});

test('cloud result ingress fails closed when OIDC identity constraints are absent', async (t) => {
  const context = setup({
    config: { messagingMode: 'pubsub', internalApiToken: '', resultAudience: '', resultAllowedEmails: [] },
    authenticatePush: undefined,
  });
  const { server, base } = await listen(context);
  t.after(() => server.close());

  const response = await jsonRequest(`${base}/pubsub/pipeline-stage-results/plan`, {
    method: 'POST', body: { kind: 'pipeline.stage.result.v1' },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'pipeline_result_auth_unconfigured');
});

test('Pub/Sub poison results are acknowledged while transient failures are retried', async (t) => {
  let mode = 'invalid';
  const context = setup({
    orchestrator: {
      async handleStageResult() {
        if (mode === 'invalid') throw new PipelineContractError('invalid result');
        throw new Error('firestore unavailable');
      },
    },
  });
  const { server, base } = await listen(context);
  t.after(() => server.close());
  const envelope = toPipelinePushEnvelope({ invalid: true, stage: 'plan' });

  assert.equal((await jsonRequest(`${base}/pubsub/pipeline-stage-results/plan`, {
    method: 'POST', body: envelope,
  })).status, 204);
  mode = 'transient';
  assert.equal((await jsonRequest(`${base}/pubsub/pipeline-stage-results/plan`, {
    method: 'POST', body: envelope,
  })).status, 500);
});
