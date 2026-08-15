'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPreflightSnapshot,
  createStageCommandV1,
} = require('@ai-fleet/shared-core/pipeline/contracts');
const { toPipelinePushEnvelope } = require('@ai-fleet/shared-core/pipeline/bus');
const { pipelineStageAuth } = require('@ai-fleet/shared/agent/pipeline-stage-service');
const {
  createPlannerPipelineRouter,
  executePlanningStage,
  linearProjectId,
} = require('./pipeline-stage');

const NOW = '2026-08-13T10:00:00.000Z';

function command({ stages = ['plan'], workItem = {}, request = {}, priorResults = [] } = {}) {
  const preflight = createPreflightSnapshot({
    runId: 'planner-pipeline-run',
    organizationId: 'org-1',
    projectId: 'native-project-1',
    requestedStages: stages,
    repository: { provider: 'github', fullName: 'acme/fleet' },
    workItem,
    stageConfiguration: {
      plan: {
        harness: 'deepagent', provider: 'ollama', model: 'gpt-oss:20b',
        modelId: 'ollama-gpt-oss-20b', providerReady: true, brokered: true,
      },
    },
    policy: {
      effectivePolicy: {
        harness: { effective: ['deepagent'] }, tools: { effective: [] }, skills: { effective: [] },
        plugins: { effective: [] }, hooks: { effective: [] }, models: { effective: ['ollama-gpt-oss-20b'] },
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
    stage: 'plan',
    attempt: 1,
    input: { request, priorResults },
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

function scopedStore(overrides = {}) {
  return {
    getBusinessByProjectId: (id) => id === 'linear-project-1'
      ? { projectId: id, orgId: 'org-1', nativeProjectId: 'native-project-1' }
      : null,
    getAgentConfig: () => ({ createIssues: true }),
    getApiKey: () => 'linear-key',
    ...overrides,
  };
}

test('planner resolves the admitted agent exactly and returns deterministic coding work items', async () => {
  const generatedCalls = [];
  const applied = [];
  const value = await executePlanningStage(command({
    stages: ['plan', 'code'],
    request: { projectId: 'linear-project-1', projectName: 'Fleet', assumedRole: { id: 'role-1' } },
  }), {
    store: scopedStore(),
    resolveStageAgent: async (received, resolution) => {
      assert.equal(received.stage, 'plan');
      assert.deepEqual(resolution, { role: 'thinking', workflowStage: 'planning' });
      return {
        settings: { linearApiKey: 'linear-key' },
        effectivePolicy: { harness: { effective: ['deepagent'] } },
        llm: { provider: 'ollama', model: 'gpt-oss:20b', host: 'http://ollama' },
        harness: 'deepagent',
        workflowPattern: 'sequential',
      };
    },
    linear: {
      async getProjectIssues() {
        return {
          id: 'linear-project-1', name: 'Fleet', issues: { nodes: [
            { id: 'issue-b', identifier: 'ENG-20', title: 'Second', state: { type: 'unstarted' } },
            { id: 'issue-a', identifier: 'ENG-10', title: 'First', state: { type: 'unstarted' } },
          ] },
        };
      },
      async getMilestonesWithIssueCounts() {
        return { project: { id: 'linear-project-1', name: 'Fleet' }, milestones: [] };
      },
    },
    generatePlan: async (options) => {
      generatedCalls.push(options);
      return { viable: true, plan: { milestones: [], dependencies: [] }, traceUrl: null };
    },
    applyPlan: async (...args) => {
      applied.push(args);
      return {
        milestonesCreated: 1,
        issuesCreated: 2,
        dependenciesCreated: 0,
        warnings: [],
        createdIssueIds: ['issue-b', 'issue-a'],
      };
    },
    applyAiplanned: async () => {},
  });

  assert.equal(value.status, 'succeeded');
  assert.deepEqual(value.output.workItems.map((item) => item.identifier), ['ENG-10', 'ENG-20']);
  assert.equal(value.output.selectedHarness, 'deepagent');
  assert.equal(value.output.provider, 'ollama');
  assert.equal(value.output.model, 'gpt-oss:20b');
  assert.equal(generatedCalls.length, 1);
  assert.equal(generatedCalls[0].keys.requestHarnesses.plan, 'deepagent');
  assert.equal(generatedCalls[0].llm.model, 'gpt-oss:20b');
  assert.deepEqual(generatedCalls[0].settings.effectivePolicy, { harness: { effective: ['deepagent'] } });
  assert.equal(applied.length, 1);
});

test('planner refuses commands that cannot identify their external Linear project', async () => {
  const value = command();
  assert.equal(linearProjectId(value), '');
  await assert.rejects(
    () => executePlanningStage(value, {}),
    (error) => error.code === 'linear_project_required',
  );
});

test('planner never falls back to unrelated open project issues', async () => {
  const value = await executePlanningStage(command({
    stages: ['plan', 'code'],
    request: { projectId: 'linear-project-1' },
  }), {
    store: scopedStore(),
    resolveStageAgent: async () => ({
      settings: { linearApiKey: 'linear-key' },
      effectivePolicy: { harness: { effective: ['deepagent'] } },
      llm: { provider: 'ollama', model: 'gpt-oss:20b' },
      harness: 'deepagent',
      workflowPattern: 'sequential',
    }),
    linear: {
      async getProjectIssues() {
        return {
          id: 'linear-project-1', name: 'Fleet', issues: { nodes: [
            { id: 'unrelated', identifier: 'OTHER-9', title: 'Concurrent issue', state: { type: 'unstarted' } },
          ] },
        };
      },
      async getMilestonesWithIssueCounts() {
        return { project: { id: 'linear-project-1', name: 'Fleet' }, milestones: [] };
      },
    },
    generatePlan: async () => ({ viable: true, plan: { milestones: [], dependencies: [] } }),
    applyPlan: async () => ({
      milestonesCreated: 0, issuesCreated: 0, dependenciesCreated: 0, warnings: [], createdIssueIds: [],
    }),
    applyAiplanned: async () => {},
  });

  assert.equal(value.status, 'failed');
  assert.equal(value.error.code, 'planning_produced_no_work_items');
  assert.deepEqual(value.output.workItems, []);
});

test('planner rejects a Linear project linked to another native project before model or Linear work', async () => {
  let sideEffects = 0;
  await assert.rejects(
    () => executePlanningStage(command({ request: { projectId: 'linear-project-1' } }), {
      store: scopedStore({
        getBusinessByProjectId: () => ({
          projectId: 'linear-project-1', orgId: 'org-1', nativeProjectId: 'native-project-other',
        }),
      }),
      resolveStageAgent: async () => { sideEffects += 1; },
      linear: { getMilestonesWithIssueCounts: async () => { sideEffects += 1; } },
    }),
    (error) => error.code === 'linear_project_scope_mismatch',
  );
  assert.equal(sideEffects, 0);
});

test('planner stage routes authenticate, execute a duplicate once, and republish its terminal result', async () => {
  let executions = 0;
  const published = [];
  const router = createPlannerPipelineRouter({
    initStore: async () => {},
    execute: async () => {
      executions += 1;
      return { output: { workItems: [{ id: 'ENG-1' }] } };
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
  let unauthorizedNext = 0;
  internal[0]({ get: () => 'wrong' }, denied, () => { unauthorizedNext += 1; });
  assert.equal(denied.statusCode, 401);
  assert.equal(unauthorizedNext, 0);

  let authorizedNext = 0;
  internal[0]({ get: () => 'internal-secret' }, responseRecorder(), () => { authorizedNext += 1; });
  assert.equal(authorizedNext, 1);

  const body = toPipelinePushEnvelope(command({ request: { projectId: 'linear-project-1' } }));
  for (const handler of [internal[1], push[1]]) {
    const response = responseRecorder();
    await handler({ body }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 204);
  }
  assert.equal(executions, 1);
  assert.equal(published.length, 2);
  assert.equal(published[0].status, 'succeeded');
  assert.equal(published[0].stage, 'plan');
});

test('planner pipeline router constructs its configured default authentication middleware', () => {
  const router = createPlannerPipelineRouter({
    initStore: async () => {},
    execute: async () => ({ status: 'succeeded', output: {} }),
    publish: async () => {},
  });

  assert.equal(routeStack(router, '/internal/pipeline/stage').length, 2);
  assert.equal(routeStack(router, '/pubsub/pipeline-stage').length, 2);
});
