'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPreflightSnapshot,
  createStageCommandV1,
} = require('@ai-fleet/shared-core/pipeline/contracts');
const { toPipelinePushEnvelope } = require('@ai-fleet/shared-core/pipeline/bus');
const { pipelineStageAuth } = require('@ai-fleet/shared/agent/pipeline-stage-service');
const { mergeReceiptDigest } = require('@ai-fleet/shared/agent/repository-broker');
const {
  MAX_PIPELINE_CODING_WORK_ITEMS,
  assertRepositorySnapshot,
  createCoderPipelineRouter,
  executeCodingStage,
  issueIdsFromCommand,
  orderCodingIssues,
} = require('./pipeline-stage');

const NOW = '2026-08-13T10:00:00.000Z';
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const TREE_A = 'c'.repeat(40);
const TREE_B = 'd'.repeat(40);

function command({ workItem = {}, request = {}, priorResults, repository } = {}) {
  const stages = priorResults ? ['plan', 'code'] : ['code'];
  const preflight = createPreflightSnapshot({
    runId: 'coder-pipeline-run',
    organizationId: 'org-1',
    projectId: 'native-project-1',
    requestedStages: stages,
    repository: repository || { provider: 'github', fullName: 'acme/fleet' },
    workItem,
    stageConfiguration: {
      code: {
        harness: 'deepagent', provider: 'ollama', model: 'qwen2.5-coder:7b',
        modelId: 'ollama-qwen2.5-coder-7b', providerReady: true, brokered: true,
      },
    },
    policy: {
      effectivePolicy: {
        harness: { effective: ['deepagent'] }, tools: { effective: [] }, skills: { effective: [] },
        plugins: { effective: [] }, hooks: { effective: [] }, models: { effective: ['ollama-qwen2.5-coder-7b'] },
      },
      prefs: {},
    },
  }, { clock: () => NOW });
  return createStageCommandV1({
    runId: preflight.runId,
    organizationId: preflight.organizationId,
    projectId: preflight.projectId,
    requestedStages: stages,
    preflight,
    stage: 'code',
    attempt: 1,
    input: { request, priorResults: priorResults || [] },
  }, { clock: () => NOW });
}

function routeStack(router, path) {
  const layer = router.stack.find((candidate) => candidate.route && candidate.route.path === path);
  return layer && layer.route.stack.map((candidate) => candidate.handle);
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

function exactAgent() {
  return {
    settings: { linearApiKey: 'linear-key' },
    effectivePolicy: { harness: { effective: ['deepagent'] } },
    llm: { provider: 'ollama', model: 'qwen2.5-coder:7b', host: 'http://ollama' },
    harness: 'deepagent',
    workflowPattern: 'sequential',
  };
}

function loadedIssue(id) {
  return {
    id,
    identifier: id === 'issue-a' ? 'ENG-10' : 'ENG-20',
    title: 'Implement the stage',
    description: 'Acceptance criteria',
    url: `https://linear.app/issue/${id}`,
    state: 'Todo',
    stateType: 'unstarted',
    labels: [],
    project: { id: 'linear-project-1', name: 'Fleet' },
  };
}

function scopedStore(overrides = {}) {
  return {
    getBusinessByProjectId: (id) => id === 'linear-project-1'
      ? {
        projectId: id,
        orgId: 'org-1',
        nativeProjectId: 'native-project-1',
        repoProvider: 'github',
        repo: 'acme/fleet',
      }
      : null,
    getRepositoryConfig: () => ({ provider: 'github', url: 'https://github.com/acme/fleet.git' }),
    ...overrides,
  };
}

function mergeReceipt(value, issue, branch) {
  const commitSha = issue.id === 'issue-a' ? COMMIT_A : COMMIT_B;
  const treeSha = issue.id === 'issue-a' ? TREE_A : TREE_B;
  const payload = {
    schemaVersion: 1,
    kind: 'repository-merge-receipt',
    source: 'repository-broker',
    provider: 'github',
    repository: 'acme/fleet',
    commandId: value.commandId,
    workItemId: issue.id,
    branch,
    baseBranch: 'main',
    reviewId: issue.id === 'issue-a' ? 41 : 42,
    reviewUrl: `https://github.com/acme/fleet/pull/${issue.id === 'issue-a' ? 41 : 42}`,
    headSha: issue.id === 'issue-a' ? 'e'.repeat(40) : 'f'.repeat(40),
    mergedSha: commitSha,
    commitSha,
    treeSha,
    reused: false,
  };
  return { ...payload, receiptDigest: mergeReceiptDigest(payload) };
}

test('coder consumes planner work items deterministically and propagates exact harness/provider/model', async () => {
  const value = command({
    priorResults: [{
      stage: 'plan', status: 'succeeded', attempt: 1, output: {
        workItems: [
          { id: 'issue-a', identifier: 'ENG-10' },
          { id: 'issue-a', identifier: 'ENG-10' },
          { id: 'issue-b', identifier: 'ENG-20' },
        ],
      },
    }],
  });
  assert.deepEqual(issueIdsFromCommand(value), ['issue-a', 'issue-b']);
  const runs = [];
  const finished = [];
  const result = await executeCodingStage(value, {
    store: scopedStore(),
    resolveStageAgent: async (received, resolution) => {
      assert.equal(received.stage, 'code');
      assert.deepEqual(resolution, { role: 'execution', workflowStage: 'coding' });
      return exactAgent();
    },
    loadIssue: async (id) => loadedIssue(id),
    startIssue: async () => ({ name: 'In Progress' }),
    finishIssue: async (apiKey, input) => { finished.push({ apiKey, input }); },
    runCoder: async (options) => {
      runs.push(options);
      const branch = `branch-${options.issue.identifier}`;
      return {
        runtime: 'deepagent',
        branch,
        artifactReceipt: mergeReceipt(value, options.issue, branch),
        finalText: '```verdict\n{"status":"completed","reason":"Merged and green.","pr":"https://github.com/acme/fleet/pull/42"}\n```',
      };
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output.workItems.map((item) => item.identifier), ['ENG-10', 'ENG-20']);
  assert.equal(result.output.selectedHarness, 'deepagent');
  assert.equal(result.output.provider, 'ollama');
  assert.equal(result.output.model, 'qwen2.5-coder:7b');
  assert.deepEqual(result.artifact, { commitSha: COMMIT_B, treeSha: TREE_B });
  assert.equal(result.output.finalBaseSha, COMMIT_B);
  assert.equal(result.output.workItems[0].artifactReceipt.workItemId, 'issue-a');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].llm.model, 'qwen2.5-coder:7b');
  assert.equal(runs[0].keys.requestHarnesses.code, 'deepagent');
  assert.deepEqual(runs[0].settings.effectivePolicy, { harness: { effective: ['deepagent'] } });
  assert.equal(finished.length, 2);
  assert.ok(finished.every((entry) => entry.input.outcome === 'completed'));
});

test('explicit snapshotted work item wins over planner output', () => {
  const value = command({
    workItem: { issueId: 'issue-explicit' },
    priorResults: [{
      stage: 'plan', status: 'succeeded', attempt: 1,
      output: { workItems: [{ id: 'issue-a' }] },
    }],
  });
  assert.deepEqual(issueIdsFromCommand(value), ['issue-explicit']);
  assert.deepEqual(issueIdsFromCommand(command({
    priorResults: [{
      stage: 'plan', status: 'failed', attempt: 1,
      output: { workItems: [{ id: 'issue-a' }] },
    }],
  })), []);
});

test('coder rejects an oversized planner batch before resolution or side effects', async () => {
  const workItems = Array.from(
    { length: MAX_PIPELINE_CODING_WORK_ITEMS + 1 },
    (_, index) => ({ id: `issue-${index + 1}` }),
  );
  const value = command({
    priorResults: [{
      stage: 'plan', status: 'succeeded', attempt: 1, output: { workItems },
    }],
  });
  let sideEffects = 0;

  await assert.rejects(
    () => executeCodingStage(value, {
      resolveStageAgent: async () => { sideEffects += 1; return exactAgent(); },
      loadIssue: async () => { sideEffects += 1; return loadedIssue('issue-a'); },
      startIssue: async () => { sideEffects += 1; },
      runCoder: async () => { sideEffects += 1; },
    }),
    (error) => error.code === 'coding_work_item_limit_exceeded',
  );
  assert.equal(sideEffects, 0);
});

test('coder orders planner work by Linear dependencies and rejects unresolved blockers', () => {
  const first = { ...loadedIssue('issue-a'), dependencies: [] };
  const second = {
    ...loadedIssue('issue-b'),
    dependencies: [{ id: 'issue-a', identifier: 'ENG-10', stateType: 'started' }],
  };
  assert.deepEqual(orderCodingIssues([second, first]).map((issue) => issue.id), ['issue-a', 'issue-b']);
  assert.throws(
    () => orderCodingIssues([{
      ...first,
      dependencies: [{ id: 'outside-batch', identifier: 'ENG-1', stateType: 'started' }],
    }]),
    (error) => error.code === 'coding_dependency_blocked',
  );
});

test('coder fails closed before execution when the repository snapshot drifts', async () => {
  const value = command({ request: { issueId: 'issue-a' } });
  const mismatchedStore = {
    getBusinessByProjectId: (id) => id === 'linear-project-1'
      ? {
        projectId: id,
        orgId: 'org-1',
        nativeProjectId: 'native-project-1',
        repoProvider: 'github',
        repo: 'acme/other',
      }
      : null,
    getRepositoryConfig: () => ({ provider: 'github', url: 'https://github.com/acme/other.git' }),
  };
  assert.throws(
    () => assertRepositorySnapshot(value, mismatchedStore),
    (error) => error.code === 'repository_snapshot_mismatch',
  );
  await assert.rejects(
    () => executeCodingStage(value, {
      store: mismatchedStore,
      resolveStageAgent: async () => exactAgent(),
      loadIssue: async () => loadedIssue('issue-a'),
      runCoder: async () => { throw new Error('must not run'); },
    }),
    (error) => error.code === 'repository_snapshot_mismatch',
  );
});

test('coder publishes a terminal failure and deduplicates command execution across both routes', async () => {
  let executions = 0;
  const published = [];
  const router = createCoderPipelineRouter({
    initStore: async () => {},
    execute: async () => {
      executions += 1;
      const error = new Error('model execution failed');
      error.code = 'model_execution_failed';
      throw error;
    },
    publish: async (result) => { published.push(result); },
    internalAuth: pipelineStageAuth({ mode: 'direct', internalToken: 'internal-secret' }),
    pushAuth: (req, res, next) => next(),
    logger: { warn() {}, error() {} },
  });
  const internal = routeStack(router, '/internal/pipeline/stage');
  const push = routeStack(router, '/pubsub/pipeline-stage');
  assert.equal(internal.length, 2);
  assert.equal(push.length, 2);

  const denied = responseRecorder();
  let nextCalls = 0;
  internal[0]({ get: () => '' }, denied, () => { nextCalls += 1; });
  assert.equal(denied.statusCode, 401);
  assert.equal(nextCalls, 0);

  const body = toPipelinePushEnvelope(command({ request: { issueId: 'issue-a' } }));
  for (const handler of [internal[1], push[1]]) {
    const response = responseRecorder();
    await handler({ body }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 204);
  }
  assert.equal(executions, 1);
  assert.equal(published.length, 2);
  assert.ok(published.every((result) => result.status === 'failed'));
  assert.ok(published.every((result) => result.error.code === 'model_execution_failed'));
});

test('coder rejects label-only recovery for a terminal aidone work item as ambiguous', async () => {
  let runCalls = 0;
  await assert.rejects(
    () => executeCodingStage(command({ request: { issueId: 'issue-a' } }), {
      store: {
        ...scopedStore(),
      },
      resolveStageAgent: async () => exactAgent(),
      loadIssue: async () => ({
        ...loadedIssue('issue-a'),
        state: 'Done',
        stateType: 'completed',
        labels: ['aidone'],
      }),
      runCoder: async () => { runCalls += 1; },
    }),
    (error) => error.code === 'coding_work_item_terminal_ambiguous',
  );
  assert.equal(runCalls, 0);
});

test('coder rejects a completed model verdict without a broker merge receipt', async () => {
  const value = command({ request: { issueId: 'issue-a' } });
  const result = await executeCodingStage(value, {
    store: scopedStore(),
    resolveStageAgent: async () => exactAgent(),
    loadIssue: async () => loadedIssue('issue-a'),
    startIssue: async () => ({ name: 'In Progress' }),
    finishIssue: async () => {},
    runCoder: async () => ({
      runtime: 'deepagent', branch: 'ENG-10',
      finalText: '```verdict\n{"status":"completed","reason":"trust me"}\n```',
    }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'coding_merge_receipt_required');
});

test('coder rejects an issue linked to another native project before any mutation', async () => {
  let sideEffects = 0;
  await assert.rejects(
    () => executeCodingStage(command({ request: { issueId: 'issue-a' } }), {
      store: scopedStore({
        getBusinessByProjectId: () => ({
          projectId: 'linear-project-1',
          orgId: 'org-1',
          nativeProjectId: 'native-project-other',
          repoProvider: 'github',
          repo: 'acme/fleet',
        }),
      }),
      resolveStageAgent: async () => exactAgent(),
      loadIssue: async () => loadedIssue('issue-a'),
      startIssue: async () => { sideEffects += 1; },
      runCoder: async () => { sideEffects += 1; },
    }),
    (error) => error.code === 'linear_project_scope_mismatch',
  );
  assert.equal(sideEffects, 0);
});
