'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPreflightSnapshot,
  createStageCommandV1,
} = require('@ai-fleet/shared-core/pipeline/contracts');
const { toPipelinePushEnvelope } = require('@ai-fleet/shared-core/pipeline/bus');
const {
  DEFAULT_ORCHESTRATOR_PORT,
  createStageCommandProcessor,
  createStageCommandHandler,
  createStageResultPublisher,
  pipelineStageAuth,
  resultPublisherDefaults,
} = require('./pipeline-stage-service');
const { MemoryStageExecutionStore } = require('./pipeline-stage-execution-store');

const NOW = '2026-08-13T10:00:00.000Z';
const ARTIFACT = Object.freeze({ commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) });

function command(stage = 'test') {
  const requestedStages = stage === 'deploy'
    ? ['plan', 'code', 'test', 'deploy']
    : stage === 'test'
      ? ['code', 'test']
      : [stage];
  const preflight = createPreflightSnapshot({
    runId: 'run-stage-service',
    organizationId: 'org-1',
    projectId: 'native-project-1',
    requestedStages,
    repository: { provider: 'github', fullName: 'acme/widgets' },
    workItem: { id: 'issue-1' },
    stageConfiguration: { [stage]: {} },
  }, { clock: () => NOW });
  return createStageCommandV1({
    runId: preflight.runId,
    organizationId: preflight.organizationId,
    projectId: preflight.projectId,
    requestedStages,
    preflight,
    stage,
    attempt: 1,
    input: { request: {}, priorResults: [] },
  }, { clock: () => NOW });
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

test('processor executes a concurrent redelivery once and republishes one typed completion per delivery', async () => {
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const published = [];
  const projected = [];
  const processCommand = createStageCommandProcessor({
    stage: 'test',
    execute: async () => {
      executions += 1;
      await gate;
      return { artifact: ARTIFACT, output: { summary: 'verified', artifact: ARTIFACT } };
    },
    publish: async (result) => { published.push(result); return { messageId: 'result' }; },
    projectResult: async (stageCommand, result) => projected.push([stageCommand.stage, result.status]),
    clock: () => NOW,
  });
  const value = command();
  const first = processCommand(value);
  const second = processCommand(value);
  while (executions === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);
  release();
  const completions = await Promise.all([first, second]);

  assert.equal(executions, 1);
  assert.equal(published.length, 2);
  assert.equal(projected.length, 2);
  assert.strictEqual(completions[0].result, completions[1].result);
  assert.equal(completions[0].result.commandId, 'run-stage-service:test:1');
  assert.equal(completions[0].result.kind, 'pipeline.stage.result.v1');
  assert.equal(completions[0].result.status, 'succeeded');
});

test('processor converts execution errors to safe failed StageResultV1 values', async () => {
  let published;
  const processCommand = createStageCommandProcessor({
    stage: 'test',
    execute: async () => { throw Object.assign(new Error('check failed'), { code: 'TEST FAILURE', retryable: true }); },
    publish: async (result) => { published = result; },
    clock: () => NOW,
  });
  await processCommand(command());
  assert.equal(published.status, 'failed');
  assert.deepEqual(published.error, {
    code: 'test_failure',
    message: 'check failed',
    retryable: true,
  });
});

test('processor preserves a server-produced immutable artifact on StageResultV1', async () => {
  const artifact = { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) };
  let published;
  const processCommand = createStageCommandProcessor({
    stage: 'test',
    execute: async () => ({ artifact, output: { artifact, summary: 'verified' } }),
    publish: async (result) => { published = result; },
    clock: () => NOW,
  });
  await processCommand(command());
  assert.deepEqual(published.artifact, artifact);
  assert.deepEqual(published.output.artifact, artifact);
});

test('processor replays a durable result after processor restart without re-execution', async () => {
  const executionStore = new MemoryStageExecutionStore();
  let executions = 0;
  const firstPublished = [];
  const first = createStageCommandProcessor({
    stage: 'test',
    execute: async () => {
      executions += 1;
      return { artifact: ARTIFACT, output: { summary: 'durable', artifact: ARTIFACT } };
    },
    publish: async (value) => firstPublished.push(value),
    executionStore,
    clock: () => NOW,
  });
  await first(command());

  const replayed = [];
  const restarted = createStageCommandProcessor({
    stage: 'test',
    execute: async () => { executions += 1; throw new Error('must not execute'); },
    publish: async (value) => replayed.push(value),
    executionStore,
    clock: () => NOW,
  });
  await restarted(command());
  assert.equal(executions, 1);
  assert.deepEqual(replayed, firstPublished);
});

test('processor terminates credential-bearing stage output instead of retrying poison data', async () => {
  let published;
  const processCommand = createStageCommandProcessor({
    stage: 'test',
    execute: async () => ({ output: { accessToken: 'must-never-cross-the-bus' } }),
    publish: async (result) => { published = result; },
    log: { warn() {} },
    clock: () => NOW,
  });
  await processCommand(command());
  assert.equal(published.status, 'failed');
  assert.deepEqual(published.output, {});
  assert.deepEqual(published.error, {
    code: 'invalid_stage_output',
    message: 'Stage output could not be serialized safely.',
    retryable: false,
  });
});

test('handler acknowledges poison and stage-mismatched push envelopes without execution', async () => {
  let calls = 0;
  const handler = createStageCommandHandler({
    stage: 'test',
    execute: async () => { calls += 1; return {}; },
    publish: async () => {},
  });
  for (const body of [{}, toPipelinePushEnvelope(command('deploy'))]) {
    const res = responseRecorder();
    await handler({ body }, res);
    assert.equal(res.statusCode, 204);
  }
  assert.equal(calls, 0);
});

test('result publisher defaults target orchestrator port 4070 and canonical internal ingress', () => {
  assert.equal(DEFAULT_ORCHESTRATOR_PORT, 4070);
  assert.deepEqual(resultPublisherDefaults({}, 'test'), {
    topic: 'pipeline-test-results',
    url: 'http://localhost:4070/internal/pipeline/results',
  });
  assert.equal(
    resultPublisherDefaults({ ORCHESTRATOR_URL: 'https://orchestrator.example/' }).url,
    'https://orchestrator.example/internal/pipeline/results',
  );
  assert.deepEqual(
    resultPublisherDefaults({ ORCHESTRATOR_SERVICE_PORT: '4999', PIPELINE_TEST_RESULTS_TOPIC: 'canonical-test-results' }, 'test'),
    { topic: 'canonical-test-results', url: 'http://localhost:4999/internal/pipeline/results' },
  );
});

test('Pub/Sub result publisher derives a stage-specific topic capability', async () => {
  let topicName;
  const publisher = createStageResultPublisher({
    mode: 'pubsub',
    env: { PUBSUB_PIPELINE_TEST_RESULTS_TOPIC: 'tenant-test-results' },
    pubsub: {
      topic(name) {
        topicName = name;
        return { publishMessage: async () => 'message-1' };
      },
    },
  });
  const processed = createStageCommandProcessor({
    stage: 'test',
    execute: async () => ({ artifact: ARTIFACT, output: { artifact: ARTIFACT } }),
    publish: publisher,
    clock: () => NOW,
  });
  await processed(command());
  assert.equal(topicName, 'tenant-test-results');
});

test('direct result publisher sends the typed result in a push envelope with the internal token', async () => {
  let request;
  const publish = createStageResultPublisher({
    mode: 'direct',
    env: { PIPELINE_RESULTS_URL: 'http://orchestrator/internal/pipeline/results', INTERNAL_API_TOKEN: 'internal-only' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 204 };
    },
  });
  let result;
  const processCommand = createStageCommandProcessor({
    stage: 'test',
    execute: async () => ({ artifact: ARTIFACT, output: { summary: 'ok', artifact: ARTIFACT } }),
    publish,
    clock: () => NOW,
  });
  result = (await processCommand(command())).result;

  assert.equal(request.url, 'http://orchestrator/internal/pipeline/results');
  assert.equal(request.options.headers['x-internal-token'], 'internal-only');
  assert.deepEqual(JSON.parse(request.options.body), toPipelinePushEnvelope(result));
});

test('direct result publisher defaults to stage-bound internal ingress', async () => {
  let requestUrl;
  const publish = createStageResultPublisher({
    mode: 'direct',
    env: { ORCHESTRATOR_URL: 'http://orchestrator' },
    fetchImpl: async (url) => {
      requestUrl = url;
      return { ok: true, status: 204 };
    },
  });
  const processCommand = createStageCommandProcessor({
    stage: 'test',
    execute: async () => ({ artifact: ARTIFACT, output: { artifact: ARTIFACT } }),
    publish,
    clock: () => NOW,
  });
  await processCommand(command());
  assert.equal(requestUrl, 'http://orchestrator/internal/pipeline/results/test');
});

test('Pub/Sub result publisher uses the stage-result-v1 attributes', async () => {
  let message;
  const pubsub = {
    topic(name) {
      assert.equal(name, 'custom-results');
      return { publishMessage: async (value) => { message = value; return 'message-1'; } };
    },
  };
  const captured = [];
  const processCommand = createStageCommandProcessor({
    stage: 'test',
    execute: async () => ({ artifact: ARTIFACT, output: { artifact: ARTIFACT } }),
    publish: createStageResultPublisher({ mode: 'pubsub', topic: 'custom-results', pubsub }),
    projectResult: async (stageCommand, result) => captured.push(result),
    clock: () => NOW,
  });
  await processCommand(command());
  assert.deepEqual(message.json, captured[0]);
  assert.deepEqual(message.attributes, {
    pipelineContract: 'stage-result-v1',
    pipelineRunId: 'run-stage-service',
    pipelineStage: 'test',
    pipelineAttempt: '1',
  });
});

test('direct ingress fails closed by default without its internal token', () => {
  let advanced = false;
  const auth = pipelineStageAuth({ mode: 'direct', internalToken: '' });
  const response = responseRecorder();
  auth({ get: () => '' }, response, () => { advanced = true; });
  assert.equal(response.statusCode, 503);
  assert.equal(advanced, false);
});
