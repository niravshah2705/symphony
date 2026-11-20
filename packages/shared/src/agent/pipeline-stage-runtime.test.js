'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createPreflightSnapshot,
  createStageCommandV1,
} = require('@software-factory/shared-core/pipeline/contracts');
const {
  parseStageVerdict,
  repositoryReference,
  executeTestingStage,
  stampTrustedEvidence,
} = require('./pipeline-stage-runtime');

const NOW = '2026-08-13T10:00:00.000Z';
const MODEL = Object.freeze({ provider: 'ollama', model: 'qwen-test' });
const ARTIFACT = Object.freeze({ commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) });
const EFFECTIVE_POLICY = Object.freeze({
  harness: { effective: ['deepagent'] },
  tools: { effective: ['environments', 'build', 'quality', 'security', 'playwright'] },
  skills: { effective: [] },
  plugins: { effective: [] },
  hooks: { effective: [] },
  models: { effective: ['qwen-test-preset'] },
});

function typedCommand(stage, configuration = {}, { priorResults, requestedStages } = {}) {
  const stages = requestedStages || (stage === 'test' ? ['code', 'test'] : [stage]);
  const stageConfiguration = {
    harness: 'deepagent',
    provider: MODEL.provider,
    model: MODEL.model,
    modelId: 'qwen-test-preset',
    providerReady: true,
    brokered: true,
    ...configuration,
  };
  const preflight = createPreflightSnapshot({
    runId: `run-${stage}`,
    organizationId: 'org-1',
    projectId: 'native-project-1',
    requestedStages: stages,
    repository: { provider: 'github', url: 'https://github.com/acme/widgets.git', fullName: 'acme/widgets' },
    workItem: { id: 'issue-1', identifier: 'ENG-1' },
    stageConfiguration: { [stage]: stageConfiguration },
    policy: { effectivePolicy: EFFECTIVE_POLICY, prefs: { workflowPattern: 'sequential' } },
  }, { clock: () => NOW });
  const defaultPriorResults = stage === 'test'
    ? [{
          stage: 'code', status: 'succeeded', attempt: 1,
          commandId: `run-${stage}:code:1`, artifact: ARTIFACT,
          output: { summary: 'coded', artifact: ARTIFACT, branch: 'ENG-1' },
        }]
      : [];
  return createStageCommandV1({
    runId: preflight.runId,
    organizationId: preflight.organizationId,
    projectId: preflight.projectId,
    requestedStages: stages,
    preflight,
    stage,
    attempt: 1,
    input: {
      request: { acceptanceCriteria: ['works'] },
      priorResults: priorResults || defaultPriorResults,
    },
  }, { clock: () => NOW });
}

function trustedEvidence(commandId, overrides = {}) {
  return stampTrustedEvidence({
    name: 'unit tests',
    runner: 'npm',
    command: 'npm test',
    status: 'passed',
    exitCode: 0,
    startedAt: NOW,
    completedAt: NOW,
    output: 'all tests passed',
    ...overrides,
  }, { idempotencyKey: commandId }, ARTIFACT, { clock: () => NOW });
}

function executionDependencies({ broker = null, capture = () => {}, roleCapture = () => {} } = {}) {
  const effectiveBroker = broker === null ? null : {
    pinRevision: async (artifact) => artifact,
    dispose() {},
    ...broker,
  };
  return {
    store: {
      getSettings: () => ({ agentRuntime: 'changed-live', workflowPattern: 'parallel', unexpectedFreshSetting: 'not-forwarded' }),
      getRepositoryToken: () => 'broker-secret',
    },
    resolveLlm: async (settings, role) => {
      roleCapture(role);
      return { ...MODEL };
    },
    prepareWorkspace: async () => ({
      workDir: '/tmp/pipeline-stage-runtime-fixture',
      branch: 'ENG-1',
      env: { PATH: '/usr/bin:/bin' },
      repositoryBroker: effectiveBroker,
    }),
    clock: () => NOW,
    runTrustedChecks: async () => [{
      name: 'unit tests', runner: 'npm', command: 'npm test', status: 'passed', exitCode: 0,
      startedAt: NOW, completedAt: NOW, output: 'all tests passed',
    }],
    runWorkflow: async (options) => {
      capture(options);
      return {
        runtime: 'deepagent',
        finalText: '```stage-result\n{"status":"succeeded","summary":"verified","checks":[{"name":"unit","status":"passed","details":"ok"}]}\n```',
      };
    },
  };
}

test('fixed execution stages reject GitLab until a brokered egress path exists', () => {
  assert.throws(
    () => repositoryReference({ preflight: { repository: {
      provider: 'gitlab', url: 'https://gitlab.com/acme/widgets.git', fullName: 'acme/widgets',
    } } }),
    (error) => error.code === 'repository_provider_not_brokered',
  );
});

test('tester resolves the testing model role and exact admitted harness', async () => {
  let role;
  let invocation;
  let disposed = false;
  const command = typedCommand('test');
  const result = await executeTestingStage(command, executionDependencies({
    broker: { dispose: () => { disposed = true; } },
    roleCapture: (value) => { role = value; },
    capture: (value) => { invocation = value; },
  }));

  assert.equal(role, 'testing');
  assert.equal(invocation.runtime, 'deepagent');
  assert.equal(invocation.workflow.name, 'testing');
  assert.deepEqual(invocation.settings, { workflowPattern: 'sequential' });
  assert.equal(invocation.workflow.backend, 'filesystem');
  assert.deepEqual(invocation.workflow.permissions, [
    { operations: ['write'], paths: ['/**'], mode: 'deny' },
  ]);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.artifact, ARTIFACT);
  assert.equal(result.output.testEvidence.length, 1);
  assert.equal(result.output.testEvidence[0].source, 'pipeline-tester');
  assert.equal(result.output.testEvidence[0].commandId, 'run-test:test:1');
  assert.equal(result.output.selectedHarness, 'deepagent');
  assert.equal(disposed, true);
});

test('stage execution fails closed when the live model differs from the admission snapshot', async () => {
  const command = typedCommand('test');
  const dependencies = executionDependencies();
  dependencies.resolveLlm = async () => ({ provider: MODEL.provider, model: 'changed-after-admission' });
  await assert.rejects(
    () => executeTestingStage(command, dependencies),
    (error) => error.code === 'stage_model_snapshot_mismatch',
  );
});

test('stage execution rejects missing policy domains and denied snapshot resources', async () => {
  const missingPolicy = typedCommand('test');
  const raw = JSON.parse(JSON.stringify(missingPolicy));
  delete raw.preflight.policy.effectivePolicy.tools;
  await assert.rejects(
    () => executeTestingStage(raw, executionDependencies()),
    (error) => error.code === 'policy_snapshot_incomplete',
  );

  const deniedHarness = typedCommand('test');
  const deniedRaw = JSON.parse(JSON.stringify(deniedHarness));
  deniedRaw.preflight.policy.effectivePolicy.harness.effective = [];
  await assert.rejects(
    () => executeTestingStage(deniedRaw, executionDependencies()),
    (error) => error.code === 'stage_harness_snapshot_mismatch',
  );

  const deniedModel = typedCommand('test');
  const deniedModelRaw = JSON.parse(JSON.stringify(deniedModel));
  deniedModelRaw.preflight.policy.effectivePolicy.models.effective = ['another-preset'];
  await assert.rejects(
    () => executeTestingStage(deniedModelRaw, executionDependencies()),
    (error) => error.code === 'stage_model_snapshot_mismatch',
  );
});

test('tester fails before workspace/model execution without a prior coded artifact', async () => {
  let prepared = false;
  const dependencies = executionDependencies({ broker: {} });
  dependencies.prepareWorkspace = async () => { prepared = true; throw new Error('must not prepare'); };
  await assert.rejects(
    () => executeTestingStage(typedCommand('test', {}, { priorResults: [] }), dependencies),
    (error) => error.code === 'immutable_artifact_required',
  );
  await assert.rejects(
    () => executeTestingStage(typedCommand('test', {}, { priorResults: [{
      stage: 'code', status: 'failed', artifact: ARTIFACT, output: { artifact: ARTIFACT },
    }] }), dependencies),
    (error) => error.code === 'immutable_artifact_required',
  );
  await assert.rejects(
    () => executeTestingStage(typedCommand('test', {}, { priorResults: [{
      stage: 'code', status: 'succeeded', artifact: ARTIFACT,
      output: { artifact: { ...ARTIFACT, treeSha: 'f'.repeat(40) } },
    }] }), dependencies),
    (error) => error.code === 'immutable_artifact_mismatch',
  );
  assert.equal(prepared, false);
});

test('trusted failed and skipped-only checks cannot be rescued by a model success assertion', async () => {
  for (const status of ['failed', 'skipped']) {
    let modelRuns = 0;
    const dependencies = executionDependencies({ broker: {} });
    dependencies.runTrustedChecks = async () => [{
      name: 'unit tests', runner: 'npm', command: 'npm test', status,
      exitCode: status === 'failed' ? 1 : null, startedAt: NOW, completedAt: NOW, output: status,
    }];
    dependencies.runWorkflow = async () => {
      modelRuns += 1;
      return { runtime: 'deepagent', finalText: '```stage-result\n{"status":"succeeded","summary":"trust me","checks":[]}\n```' };
    };
    const result = await executeTestingStage(typedCommand('test'), dependencies);
    assert.equal(result.status, 'failed');
    assert.equal(modelRuns, 0);
    assert.equal(
      result.error.code,
      status === 'failed' ? 'tests_failed' : 'trusted_test_evidence_required',
    );
  }

  const inconsistent = executionDependencies({ broker: {} });
  inconsistent.runTrustedChecks = async () => [{
    name: 'unit tests', runner: 'npm', command: 'npm test', status: 'passed',
    exitCode: 1, startedAt: NOW, completedAt: NOW, output: 'failed',
  }];
  const inconsistentResult = await executeTestingStage(typedCommand('test'), inconsistent);
  assert.equal(inconsistentResult.status, 'failed');
  assert.equal(inconsistentResult.error.code, 'tests_failed');
});

test('model worktree mutations occur only after trusted evidence is sealed for the pinned tree', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-evidence-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const marker = path.join(workDir, 'marker.txt');
  fs.writeFileSync(marker, 'original', 'utf8');
  const dependencies = executionDependencies({ broker: {} });
  dependencies.prepareWorkspace = async () => ({
    workDir,
    branch: 'ENG-1',
    env: { PATH: process.env.PATH || '' },
    repositoryBroker: {
      pinRevision: async (artifact) => artifact,
      dispose() {},
    },
  });
  dependencies.runTrustedChecks = async () => [{
    name: 'pinned bytes', runner: 'fixture', command: 'verify marker', status: 'passed', exitCode: 0,
    startedAt: NOW, completedAt: NOW, output: fs.readFileSync(marker, 'utf8'),
  }];
  dependencies.runWorkflow = async () => {
    fs.writeFileSync(marker, 'model-mutated', 'utf8');
    return {
      runtime: 'deepagent',
      finalText: '```stage-result\n{"status":"succeeded","summary":"verified","checks":[{"name":"unit","status":"passed"}]}\n```',
    };
  };

  const result = await executeTestingStage(typedCommand('test'), dependencies);
  assert.equal(result.status, 'succeeded');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'model-mutated');
  assert.equal(
    result.output.testEvidence[0].outputDigest,
    crypto.createHash('sha256').update('original').digest('hex'),
  );
});

test('stage verdict parser accepts only the bounded fenced contract', () => {
  assert.equal(parseStageVerdict('{"status":"succeeded"}'), null);
  assert.equal(parseStageVerdict('```stage-result\nnot json\n```'), null);
  assert.deepEqual(
    parseStageVerdict('```stage-result\n{"status":"failed","summary":"no","checks":[{"name":"lint","status":"failed","details":"bad"}]}\n```'),
    { status: 'failed', summary: 'no', checks: [{ name: 'lint', status: 'failed', details: 'bad' }] },
  );
});
