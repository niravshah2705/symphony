'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PIPELINE_CONTRACT_VERSION,
  MAX_STAGE_RESULT_OUTPUT_BYTES,
  stageIdempotencyKey,
  createPipelineStart,
  createPreflightSnapshot,
  createStageCommandV1,
  createStageResultV1,
  validatePipelineStart,
  validatePreflightSnapshot,
} = require('./contracts');

const clock = () => '2026-08-12T10:00:00.000Z';

function start(overrides = {}) {
  return createPipelineStart({
    runId: 'run-123',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages: ['plan', 'code', 'test', 'deploy'],
    request: { workItemId: 'ENG-42', objective: 'Ship the durable pipeline' },
    ...overrides,
  }, { clock });
}

test('PipelineStart is versioned, immutable, and requires an explicit canonical stage subset', () => {
  const value = start({ requestedStages: ['plan', 'code', 'test'] });

  assert.equal(value.schemaVersion, PIPELINE_CONTRACT_VERSION);
  assert.equal(value.kind, 'pipeline.start.v1');
  assert.deepEqual(value.requestedStages, ['plan', 'code', 'test']);
  assert.equal(value.createdAt, clock());
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.request), true);

  assert.throws(() => start({ requestedStages: [] }), /requestedStages/);
  assert.throws(() => start({ requestedStages: ['code', 'plan'] }), /canonical order/);
  assert.throws(() => start({ requestedStages: ['plan', 'plan'] }), /duplicate/);
  assert.throws(() => start({ requestedStages: ['plan', 'review'] }), /unsupported stage/);
  assert.throws(() => start({ requestedStages: ['test'] }), /earlier code stage/);
  assert.throws(() => start({ requestedStages: ['plan', 'test'] }), /earlier code stage/);
});

test('deploy is opt-in and allowed only as the exact full plan -> code -> test -> deploy run', () => {
  assert.deepEqual(start().requestedStages, ['plan', 'code', 'test', 'deploy']);
  assert.throws(() => start({ requestedStages: ['deploy'] }), /exact full sequence/);
  assert.throws(() => start({ requestedStages: ['plan', 'test', 'deploy'] }), /exact full sequence/);
  assert.throws(() => start({ requestedStages: ['code', 'test', 'deploy'] }), /exact full sequence/);
});

test('all control-plane contracts reject nested secrets and credential-shaped values', () => {
  assert.throws(
    () => start({ request: { nested: { apiKey: 'must-not-cross-the-bus' } } }),
    /secret-bearing field/i,
  );
  assert.throws(
    () => start({ metadata: { note: 'Bearer abc.def.ghi' } }),
    /credential-shaped value/i,
  );
  assert.throws(
    () => start({ metadata: { note: 'request failed for https://user:password@example.test/path' } }),
    /credential-shaped value/i,
  );
  assert.throws(
    () => start({ metadata: { note: `provider returned ${'sk-test_'.padEnd(30, 'x')}` } }),
    /credential-shaped value/i,
  );
  for (const field of ['accessToken', 'refreshToken', 'idToken', 'authToken', 'oauthToken', 'clientSecret']) {
    assert.throws(
      () => start({ request: { provider: { nested: { [field]: 'opaque-value' } } } }),
      /secret-bearing field/i,
      field,
    );
  }
  assert.throws(
    () => start({ request: JSON.parse('{"__proto__":{"policy":{"deploy":true}}}') }),
    /unsafe object key/i,
  );

  let tooDeep = {};
  for (let depth = 0; depth < 70; depth += 1) tooDeep = { child: tooDeep };
  assert.throws(() => start({ request: tooDeep }), /maximum JSON nesting depth/i);

  const safe = start({
    request: {
      provider: {
        providerReady: true,
        providerSource: 'managed',
      },
    },
  });
  assert.deepEqual(safe.request.provider, { providerReady: true, providerSource: 'managed' });

  const validation = validatePipelineStart({ requestedStages: ['plan'] });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.length > 0);
});

test('PreflightSnapshot captures immutable, secret-free resolved facts for the requested stages', () => {
  const value = createPreflightSnapshot({
    runId: 'run-123',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages: ['plan', 'code'],
    repository: { provider: 'github', owner: 'acme', name: 'fleet', baseRevision: 'abc123' },
    workItem: { id: 'issue-id', identifier: 'ENG-42' },
    stageConfiguration: { plan: { harness: 'deepagent' }, code: { harness: 'codex-sdk' } },
  }, { clock });

  assert.equal(value.kind, 'pipeline.preflight.snapshot.v1');
  assert.equal(value.capturedAt, clock());
  assert.deepEqual(Object.keys(value.stageConfiguration), ['plan', 'code']);
  assert.equal(Object.isFrozen(value.repository), true);
  assert.match(value.preflightDecisionDigest, /^[a-f0-9]{64}$/);

  const reordered = createPreflightSnapshot({
    runId: 'run-123',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages: ['plan', 'code'],
    repository: { baseRevision: 'abc123', name: 'fleet', owner: 'acme', provider: 'github' },
    workItem: { identifier: 'ENG-42', id: 'issue-id' },
    stageConfiguration: { code: { harness: 'codex-sdk' }, plan: { harness: 'deepagent' } },
    capturedAt: clock(),
  }, { clock });
  assert.equal(reordered.preflightDecisionDigest, value.preflightDecisionDigest);

  const tampered = {
    ...value,
    repository: { ...value.repository, name: 'different' },
  };
  assert.equal(validatePreflightSnapshot(tampered).valid, false);
});

test('StageCommandV1 and StageResultV1 share the exact runId:stage:attempt idempotency key', () => {
  const pipelineStart = start({ requestedStages: ['plan', 'code', 'test'] });
  const preflight = createPreflightSnapshot({
    runId: pipelineStart.runId,
    organizationId: pipelineStart.organizationId,
    projectId: pipelineStart.projectId,
    requestedStages: pipelineStart.requestedStages,
    repository: { provider: 'github', owner: 'acme', name: 'fleet' },
  }, { clock });
  const command = createStageCommandV1({
    runId: pipelineStart.runId,
    stage: 'plan',
    attempt: 1,
    organizationId: pipelineStart.organizationId,
    projectId: pipelineStart.projectId,
    requestedStages: pipelineStart.requestedStages,
    preflight,
    input: { priorArtifacts: [] },
  }, { clock });

  assert.equal(command.commandId, 'run-123:plan:1');
  assert.equal(command.idempotencyKey, stageIdempotencyKey('run-123', 'plan', 1));
  assert.equal(command.kind, 'pipeline.stage.command.v1');

  const result = createStageResultV1({
    commandId: command.commandId,
    runId: command.runId,
    stage: command.stage,
    attempt: command.attempt,
    status: 'succeeded',
    output: {
      artifacts: [{ kind: 'plan', uri: 'artifact://plans/123' }],
      artifact: { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) },
    },
  }, { clock });

  assert.equal(result.idempotencyKey, command.idempotencyKey);
  assert.equal(result.completedAt, clock());
  assert.equal(result.error, null);
  assert.deepEqual(result.artifact, { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) });
  assert.throws(
    () => createStageResultV1({ ...result, commandId: 'different' }, { clock }),
    /commandId must equal/,
  );
  assert.throws(
    () => createStageResultV1({ ...result, artifact: { commitSha: 'abc', treeSha: 'b'.repeat(40) } }, { clock }),
    /artifact.commitSha/,
  );
  assert.throws(
    () => createStageResultV1({
      ...result,
      artifact: { commitSha: 'c'.repeat(40), treeSha: 'd'.repeat(40) },
    }, { clock }),
    /artifact must match output.artifact/,
  );
});

test('failed stage results require a bounded safe error and never serialize Error internals', () => {
  const value = createStageResultV1({
    runId: 'run-123',
    stage: 'test',
    attempt: 2,
    commandId: 'run-123:test:2',
    status: 'failed',
    error: { code: 'tests_failed', message: 'Three tests failed', retryable: true },
  }, { clock });

  assert.deepEqual(value.error, {
    code: 'tests_failed',
    message: 'Three tests failed',
    retryable: true,
  });
  assert.throws(
    () => createStageResultV1({ ...value, error: null }, { clock }),
    /error is required/,
  );
});

test('StageResult output has a transport-safe byte ceiling', () => {
  assert.throws(() => createStageResultV1({
    runId: 'run-123',
    stage: 'code',
    attempt: 1,
    status: 'succeeded',
    output: { text: 'x'.repeat(MAX_STAGE_RESULT_OUTPUT_BYTES) },
  }, { clock }), /output must be at most/);
});

test('successful code, test, and deploy results require immutable artifact lineage', () => {
  for (const stage of ['code', 'test', 'deploy']) {
    assert.throws(() => createStageResultV1({
      runId: 'run-123', stage, attempt: 1, status: 'succeeded', output: {},
    }, { clock }), new RegExp(`artifact is required for a succeeded ${stage}`));
  }
});
