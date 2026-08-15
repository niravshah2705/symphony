'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('./scheduler');
const store = require('../store');
const workspaceEvents = require('./workspace-events');
const {
  runWithWorkspaceContext,
  currentWorkspaceContext,
} = require('../store/workspace-context');
const { AgentAvailabilityError } = require('./availability');
const { AgentError } = require('./plan');
const { PolicyDeniedError } = require('./settings-policy');

test('planner model outage keeps the same job pending and successful preflight clears the pause', async (t) => {
  scheduler._test.clearModelPause();
  t.after(() => scheduler._test.clearModelPause());

  const job = {
    id: 'job-1',
    projectId: 'project-1',
    projectName: 'Project',
    assumedRole: { id: 'role-1', name: 'Planner' },
    status: 'pending',
    error: 'old pause message',
    pauseReason: { code: 'model-unavailable' },
    steps: [],
  };
  let added = 0;
  const fakeStore = {
    addJob() { added += 1; },
    updateJob(id, patch) {
      assert.equal(id, job.id);
      Object.assign(job, patch);
      return job;
    },
    appendJobStep(id, step) {
      assert.equal(id, job.id);
      job.steps.push(step);
    },
  };
  const llm = { provider: 'codex', model: 'gpt-test' };

  const result = await scheduler._test.runJob(
    job,
    { apiKey: 'linear-key', keys: {}, llm, config: { createIssues: true } },
    {
      store: fakeStore,
      getSettings: () => ({ llmProvider: 'codex' }),
      linear: {
        getMilestonesWithIssueCounts: async () => ({ project: { id: 'project-1' }, milestones: [] }),
      },
      generatePlan: async () => {
        throw new AgentAvailabilityError('model', 'raw provider 403 detail', 403);
      },
    }
  );

  assert.equal(result.paused, true);
  assert.equal(added, 0, 'an unavailable retry must not enqueue a duplicate job');
  assert.equal(job.status, 'pending', 'the same job remains the sole active retry candidate');
  assert.equal(job.startedAt, null);
  assert.equal(job.finishedAt, null);
  assert.equal(job.pauseReason.resource, 'model');
  assert.match(job.error, /model is unavailable/i);
  assert.doesNotMatch(JSON.stringify(job), /raw provider 403 detail/);
  assert.equal(scheduler.getStatus().paused, true);

  const ready = await scheduler._test.verifyModelReadiness(
    { llmProvider: 'codex' },
    {
      resolveLlm: async () => llm,
      probeModelAvailability: async () => ({ available: true }),
    }
  );
  assert.equal(ready, llm);
  assert.equal(scheduler.getStatus().paused, false);
  assert.equal(scheduler.getStatus().pauseReason, null);

  await scheduler._test.runJob(
    job,
    { apiKey: 'linear-key', keys: {}, llm, config: { createIssues: true } },
    {
      store: fakeStore,
      getSettings: () => ({ llmProvider: 'codex' }),
      linear: {
        getMilestonesWithIssueCounts: async () => ({
          project: { id: 'project-1' },
          milestones: [{ id: 'milestone-1', issueCount: 1 }],
        }),
      },
      applyAiplanned: async () => ({ applied: true }),
    },
  );
  assert.equal(added, 0);
  assert.equal(job.id, 'job-1');
  assert.equal(job.status, 'done');
  assert.equal(job.error, null);
  assert.equal(job.pauseReason, null);
});

test('planner invalid model output is a job error, not a global availability pause', async (t) => {
  scheduler._test.clearModelPause();
  t.after(() => scheduler._test.clearModelPause());
  const job = {
    id: 'job-invalid-output',
    projectId: 'project-2',
    projectName: 'Project',
    assumedRole: { id: 'role-1', name: 'Planner' },
    status: 'pending',
    steps: [],
  };
  const fakeStore = {
    updateJob(_id, patch) { Object.assign(job, patch); return job; },
    appendJobStep(_id, step) { job.steps.push(step); },
  };

  const result = await scheduler._test.runJob(
    job,
    {
      apiKey: 'linear-key',
      keys: {},
      llm: { provider: 'codex', model: 'gpt-test' },
      config: { createIssues: true },
    },
    {
      store: fakeStore,
      getSettings: () => ({ llmProvider: 'codex' }),
      linear: {
        getMilestonesWithIssueCounts: async () => ({ project: { id: 'project-2' }, milestones: [] }),
      },
      generatePlan: async () => {
        throw new AgentError('Plan failed validation.', 502, { code: 'model_output_invalid' });
      },
    },
  );

  assert.match(result.error, /validation/i);
  assert.equal(job.status, 'error');
  assert.equal(scheduler.getStatus().paused, false);
  assert.equal(scheduler.getStatus().pauseReason, null);
});

test('planner runtime policy denial is an error and never becomes a model pause', async (t) => {
  const context = { organizationId: 'org-planner-policy-denied', projectId: 'native-planner-policy-denied' };
  scheduler._test.resetRuntime(context);
  t.after(() => scheduler._test.resetRuntime(context));
  const job = {
    id: 'job-runtime-policy-denied',
    projectId: 'linear-project-policy-denied',
    projectName: 'Policy denied',
    assumedRole: null,
    orgId: context.organizationId,
    nativeProjectId: context.projectId,
    status: 'pending',
    steps: [],
  };
  const fakeStore = {
    updateJob(_id, patch) { Object.assign(job, patch); return job; },
    appendJobStep(_id, step) { job.steps.push(step); },
  };

  const result = await scheduler._test.runJob(
    job,
    {
      apiKey: 'linear-key',
      keys: { agentRuntime: 'deepagent' },
      llm: { provider: 'codex', model: 'gpt-5.6-terra' },
      config: { createIssues: true },
    },
    {
      store: fakeStore,
      getSettings: () => ({ llmProvider: 'codex' }),
      linear: {
        getMilestonesWithIssueCounts: async () => ({ project: { id: job.projectId }, milestones: [] }),
      },
      resolvePolicy: async () => ({
        effectivePolicy: { harness: { effective: ['deepagent'] } },
        prefs: {},
      }),
      generatePlan: async () => {
        throw new PolicyDeniedError('harness', 'claude-agent-sdk');
      },
    },
  );

  assert.equal(result.policyDenied, true);
  assert.equal(job.status, 'error');
  assert.equal(job.policyDenied, true);
  assert.equal(scheduler.getStatus(context).paused, false);
  assert.equal(scheduler.getStatus(context).pauseReason, null);
});

test('processApprovalDeadlines delegates to the sweep and swallows errors', async () => {
  let called = 0;
  await scheduler._test.processApprovalDeadlines({ sweepExpiredGates: async () => { called += 1; return []; } });
  assert.equal(called, 1); // runs with no Linear key/role — it is not gated by processPending

  const res = await scheduler._test.processApprovalDeadlines({
    sweepExpiredGates: async () => { throw new Error('boom'); },
  });
  assert.deepEqual(res, { error: true }); // a failing sweep cannot break the scheduling loop
});

test('approval deadline sweeps see only the active native workspace', async () => {
  const fakeStore = {
    listApprovalGates: () => [
      { id: 'gate-a', orgId: 'org-gates', nativeProjectId: 'native-a' },
      { id: 'gate-b', orgId: 'org-gates', nativeProjectId: 'native-b' },
      { id: 'gate-c', orgId: 'org-other', nativeProjectId: 'native-a' },
    ],
  };
  const visible = await runWithWorkspaceContext(
    { organizationId: 'org-gates', projectId: 'native-a' },
    () => scheduler.processApprovalDeadlines({
      gateDeps: { store: fakeStore },
      sweepExpiredGates: async (_now, deps) => deps.store.listApprovalGates().map((gate) => gate.id),
    }),
  );
  assert.deepEqual(visible, ['gate-a']);
});

test('runJob threads selected native project policy and org attribution into generatePlan', async () => {
  const job = {
    id: 'job-enf', projectId: 'p1', projectName: 'Proj', assumedRole: null,
    orgId: 'org-1', nativeProjectId: 'native-project-1', status: 'pending', steps: [],
  };
  const fakeStore = {
    addJob() {},
    updateJob(id, patch) { Object.assign(job, patch); return job; },
    appendJobStep(id, step) { job.steps.push(step); },
  };
  const effectivePolicy = { harness: { effective: ['deepagent'] }, tools: { effective: ['quality'] } };
  let seen = null;
  let resolvedOrgId = null;
  let resolvedProjectId = null;
  await scheduler._test.runJob(
    job,
    { apiKey: 'k', keys: {}, llm: { provider: 'codex', model: 'm' }, config: { createIssues: true } },
    {
      store: fakeStore,
      getSettings: () => ({ llmProvider: 'codex' }),
      linear: { getMilestonesWithIssueCounts: async () => ({ project: { id: 'p1' }, milestones: [] }) },
      resolvePolicy: async (orgId, projectId) => {
        resolvedOrgId = orgId;
        resolvedProjectId = projectId;
        return { effectivePolicy, prefs: {} };
      },
      generatePlan: async (args) => { seen = args.settings; return { viable: true, plan: {}, traceUrl: null, traced: false, runId: 'r' }; },
      applyPlan: async () => ({ milestonesCreated: 1, issuesCreated: 1, dependenciesCreated: 0, warnings: [] }),
      applyAiplanned: async () => {},
    }
  );
  assert.deepEqual(seen.effectivePolicy, effectivePolicy);
  assert.equal(seen.orgId, 'org-1');
  assert.equal(seen.nativeProjectId, 'native-project-1');
  assert.equal(resolvedOrgId, 'org-1');
  assert.equal(resolvedProjectId, 'native-project-1');
});

test('runJob fails closed on a tenant organization-context mismatch', async () => {
  const job = {
    id: 'job-mismatch', projectId: 'p1', projectName: 'Proj', assumedRole: null,
    orgId: 'org-other', nativeProjectId: 'native-project-1', status: 'pending', steps: [],
  };
  const fakeStore = {
    updateJob(_id, patch) { Object.assign(job, patch); return job; },
    appendJobStep(_id, step) { job.steps.push(step); },
  };
  let generated = false;

  const result = await scheduler._test.runJob(
    job,
    { apiKey: 'k', keys: {}, llm: { provider: 'codex', model: 'm' }, config: { createIssues: true } },
    {
      store: fakeStore,
      getSettings: () => ({ llmProvider: 'codex' }),
      linear: { getMilestonesWithIssueCounts: async () => ({ project: { id: 'p1' }, milestones: [] }) },
      resolvePolicy: async () => {
        const error = new Error('Selected organization does not match this deployment.');
        error.code = 'organization_context_mismatch';
        error.status = 403;
        throw error;
      },
      generatePlan: async () => { generated = true; },
    },
  );

  assert.equal(generated, false);
  assert.equal(job.status, 'error');
  assert.match(result.error, /does not match this deployment/i);
});

test('legacy empty-context runJob remains allow-all when policy resolution throws', async () => {
  const job = { id: 'job-fo', projectId: 'p1', projectName: 'Proj', assumedRole: null, status: 'pending', steps: [] };
  const fakeStore = { addJob() {}, updateJob(id, p) { Object.assign(job, p); return job; }, appendJobStep(id, s) { job.steps.push(s); } };
  let seen = 'unset';
  await scheduler._test.runJob(
    job,
    { apiKey: 'k', keys: {}, llm: { provider: 'codex', model: 'm' }, config: { createIssues: true } },
    {
      store: fakeStore,
      getSettings: () => ({ llmProvider: 'codex' }),
      linear: { getMilestonesWithIssueCounts: async () => ({ project: { id: 'p1' }, milestones: [] }) },
      resolvePolicy: async () => { throw new Error('settings down'); },
      generatePlan: async (args) => { seen = args.settings; return { viable: true, plan: {}, traceUrl: null, traced: false, runId: 'r' }; },
      applyPlan: async () => ({ milestonesCreated: 0, issuesCreated: 0, dependenciesCreated: 0, warnings: [] }),
      applyAiplanned: async () => {},
    }
  );
  assert.equal(seen.effectivePolicy, null);
});

test('selected-organization runJob stays pending when policy resolution is unavailable', async (t) => {
  const context = { organizationId: 'org-policy-down', projectId: 'native-policy-down' };
  scheduler._test.resetRuntime(context);
  t.after(() => scheduler._test.resetRuntime(context));
  const job = {
    id: 'job-policy-down',
    projectId: 'p1',
    projectName: 'Proj',
    assumedRole: null,
    orgId: context.organizationId,
    nativeProjectId: context.projectId,
    status: 'pending',
    steps: [],
  };
  const fakeStore = {
    updateJob(_id, patch) { Object.assign(job, patch); return job; },
    appendJobStep(_id, step) { job.steps.push(step); },
  };
  let generated = false;

  const result = await scheduler._test.runJob(
    job,
    { apiKey: 'k', keys: {}, llm: { provider: 'codex', model: 'm' }, config: { createIssues: true } },
    {
      store: fakeStore,
      getSettings: () => ({ llmProvider: 'codex' }),
      linear: { getMilestonesWithIssueCounts: async () => ({ project: { id: 'p1' }, milestones: [] }) },
      resolvePolicy: async () => { throw new Error('settings transport details must stay private'); },
      generatePlan: async () => { generated = true; },
    },
  );

  assert.equal(generated, false);
  assert.equal(job.status, 'pending');
  assert.equal(result.paused, true);
  assert.equal(result.pauseReason.code, 'policy-unavailable');
  assert.match(job.error, /policy is temporarily unavailable/i);
  assert.doesNotMatch(job.error, /transport details/i);
});

test('selected-organization runJob fails closed when resolver returns no effective policy', async (t) => {
  const responses = [null, {}, { effectivePolicy: null, prefs: {} }];
  for (const [index, response] of responses.entries()) {
    const context = {
      organizationId: `org-policy-missing-${index}`,
      projectId: `native-policy-missing-${index}`,
    };
    scheduler._test.resetRuntime(context);
    t.after(() => scheduler._test.resetRuntime(context));
    const job = {
      id: `job-policy-missing-${index}`,
      projectId: 'linear-project-missing-policy',
      projectName: 'Missing policy',
      assumedRole: null,
      orgId: context.organizationId,
      nativeProjectId: context.projectId,
      status: 'pending',
      steps: [],
    };
    const fakeStore = {
      updateJob(_id, patch) { Object.assign(job, patch); return job; },
      appendJobStep(_id, step) { job.steps.push(step); },
    };
    let generated = false;

    const result = await scheduler._test.runJob(
      job,
      {
        apiKey: 'linear-key',
        keys: {},
        llm: { provider: 'codex', model: 'gpt-5.6-terra' },
        config: { createIssues: true },
      },
      {
        store: fakeStore,
        getSettings: () => ({ llmProvider: 'codex' }),
        linear: {
          getMilestonesWithIssueCounts: async () => ({ project: { id: job.projectId }, milestones: [] }),
        },
        resolvePolicy: async () => response,
        generatePlan: async () => { generated = true; },
      },
    );

    assert.equal(generated, false);
    assert.equal(result.paused, true);
    assert.equal(result.pauseReason.code, 'policy-unavailable');
    assert.equal(job.status, 'pending');
  }
});

test('enforceLlmModel downgrades within a provider and fails closed without an allowed model', () => {
  const catalog = { presets: [
    { id: 'claude-opus-4-8', provider: 'claude', model: 'claude-opus-4-8' },
    { id: 'claude-sonnet-5', provider: 'claude', model: 'claude-sonnet-5' },
    { id: 'codex-gpt-5-5', provider: 'codex', model: 'gpt-5.5' },
  ] };
  const effective = { models: { effective: ['claude-sonnet-5', 'codex-gpt-5-5'] } }; // opus denied

  const denied = { provider: 'claude', model: 'claude-opus-4-8', baseUrl: 'x', accessToken: 't' };
  const out = scheduler._test.enforceLlmModel(denied, effective, catalog);
  assert.equal(out.model, 'claude-sonnet-5'); // swapped to a same-provider allowed model
  assert.equal(out.provider, 'claude');
  assert.equal(out.baseUrl, 'x'); // rest of the descriptor preserved

  // Already-allowed model → unchanged (same object).
  const ok = { provider: 'claude', model: 'claude-sonnet-5' };
  assert.equal(scheduler._test.enforceLlmModel(ok, effective, catalog), ok);
  // No models policy → unchanged (allow-all).
  assert.equal(scheduler._test.enforceLlmModel(denied, {}, catalog), denied);
  // A governed policy with no same-provider alternative fails closed.
  const noClaude = { models: { effective: ['codex-gpt-5-5'] } };
  assert.throws(
    () => scheduler._test.enforceLlmModel(denied, noClaude, catalog),
    (error) => error.code === 'policy_denied' && error.status === 403,
  );
});

test('runJob overlays org operational prefs (runtime/workflow/tracing) onto the planner keys', async () => {
  const job = { id: 'job-prefs', projectId: 'p1', projectName: 'Proj', assumedRole: null, status: 'pending', steps: [] };
  const fakeStore = { addJob() {}, updateJob(id, p) { Object.assign(job, p); return job; }, appendJobStep(id, s) { job.steps.push(s); } };
  let seenKeys = null;
  await scheduler._test.runJob(
    job,
    { apiKey: 'k', keys: { agentRuntime: 'deepagent', workflowPattern: 'sequential', langsmithTracing: true }, llm: { provider: 'codex', model: 'm' }, config: { createIssues: true } },
    {
      store: fakeStore,
      getSettings: () => ({ llmProvider: 'codex' }),
      linear: { getMilestonesWithIssueCounts: async () => ({ project: { id: 'p1' }, milestones: [] }) },
      resolvePolicy: async () => ({ effectivePolicy: null, prefs: { agentRuntime: 'codex-sdk', workflowPattern: 'parallel', langsmithTracing: 'false' } }),
      generatePlan: async (args) => { seenKeys = args.keys; return { viable: true, plan: {}, traceUrl: null, traced: false, runId: 'r' }; },
      applyPlan: async () => ({ milestonesCreated: 1, issuesCreated: 1, dependenciesCreated: 0, warnings: [] }),
      applyAiplanned: async () => {},
    }
  );
  assert.equal(seenKeys.agentRuntime, 'codex-sdk');    // overridden by org pref
  assert.equal(seenKeys.workflowPattern, 'parallel');  // overridden by org pref
  assert.equal(seenKeys.langsmithTracing, false);      // "false" string coerced to boolean
});

test('runJob leaves keys unchanged when there are no operational prefs (no regression)', async () => {
  const job = { id: 'job-noprefs', projectId: 'p1', projectName: 'Proj', assumedRole: null, status: 'pending', steps: [] };
  const fakeStore = { addJob() {}, updateJob(id, p) { Object.assign(job, p); return job; }, appendJobStep(id, s) { job.steps.push(s); } };
  let seenKeys = null;
  await scheduler._test.runJob(
    job,
    { apiKey: 'k', keys: { agentRuntime: 'deepagent', workflowPattern: 'sequential', langsmithTracing: true }, llm: { provider: 'codex', model: 'm' }, config: { createIssues: true } },
    {
      store: fakeStore,
      getSettings: () => ({ llmProvider: 'codex' }),
      linear: { getMilestonesWithIssueCounts: async () => ({ project: { id: 'p1' }, milestones: [] }) },
      resolvePolicy: async () => ({ effectivePolicy: null, prefs: {} }),
      generatePlan: async (args) => { seenKeys = args.keys; return { viable: true, plan: {}, traceUrl: null, traced: false, runId: 'r' }; },
      applyPlan: async () => ({ milestonesCreated: 0, issuesCreated: 0, dependenciesCreated: 0, warnings: [] }),
      applyAiplanned: async () => {},
    }
  );
  assert.equal(seenKeys.agentRuntime, 'deepagent');
  assert.equal(seenKeys.workflowPattern, 'sequential');
  assert.equal(seenKeys.langsmithTracing, true);
});

test('getStatus counts only jobs in the selected native workspace', (t) => {
  const originalListJobs = store.listJobs;
  const originalGetAgentConfig = store.getAgentConfig;
  store.listJobs = () => [
    { orgId: 'org-1', nativeProjectId: 'native-1', status: 'pending' },
    { orgId: 'org-1', nativeProjectId: 'native-2', status: 'running' },
    { orgId: 'org-2', nativeProjectId: 'native-1', status: 'error' },
  ];
  store.getAgentConfig = () => ({ intervalMinutes: 5, scheduleEnabled: true });
  t.after(() => {
    store.listJobs = originalListJobs;
    store.getAgentConfig = originalGetAgentConfig;
  });

  assert.deepEqual(
    scheduler.getStatus({ organizationId: 'org-1', projectId: 'native-1' }).counts,
    { pending: 1, running: 0, done: 0, error: 0 },
  );
  assert.deepEqual(
    scheduler.getStatus({ organizationId: 'org-1' }).counts,
    { pending: 1, running: 1, done: 0, error: 0 },
  );
});

test('concurrent organization/project runtimes isolate pauses, ticking, timestamps, and errors', async (t) => {
  scheduler._test.resetAllRuntimes();
  const originalListJobs = store.listJobs;
  const originalGetAgentConfig = store.getAgentConfig;
  store.listJobs = () => [
    { orgId: 'org-a', nativeProjectId: 'native-a', status: 'pending' },
    { orgId: 'org-b', nativeProjectId: 'native-b', status: 'running' },
  ];
  store.getAgentConfig = () => ({ intervalMinutes: 5, scheduleEnabled: true });
  t.after(() => {
    store.listJobs = originalListJobs;
    store.getAgentConfig = originalGetAgentConfig;
    scheduler._test.resetAllRuntimes();
  });

  const snapshots = {};
  await Promise.all([
    runWithWorkspaceContext(
      { organizationId: 'org-a', projectId: 'native-a' },
      async () => {
        scheduler._test.pauseForModel(
          new Error('provider A unavailable'),
          { thinkingLlmProvider: 'codex' },
          { provider: 'codex', model: 'model-a' },
        );
        const runtime = scheduler._test.runtimeFor();
        runtime.isTicking = true;
        runtime.lastRunAt = 'run-a';
        await new Promise((resolve) => setTimeout(resolve, 15));
        snapshots.a = scheduler.getStatus();
      },
    ),
    runWithWorkspaceContext(
      { organizationId: 'org-b', projectId: 'native-b' },
      async () => {
        scheduler._test.pauseForModel(
          new Error('provider B unavailable'),
          { thinkingLlmProvider: 'claude' },
          { provider: 'claude', model: 'model-b' },
        );
        const runtime = scheduler._test.runtimeFor();
        runtime.lastRunAt = 'run-b';
        await scheduler._test.verifyModelReadiness(
          { thinkingLlmProvider: 'claude' },
          {
            resolveLlm: async () => ({ provider: 'claude', model: 'model-b' }),
            probeModelAvailability: async () => ({ available: true }),
          },
        );
        snapshots.b = scheduler.getStatus();
      },
    ),
  ]);

  assert.equal(snapshots.a.paused, true);
  assert.equal(snapshots.a.pauseReason.provider, 'codex');
  assert.equal(snapshots.a.isTicking, true);
  assert.equal(snapshots.a.lastRunAt, 'run-a');
  assert.deepEqual(snapshots.a.counts, { pending: 1, running: 0, done: 0, error: 0 });

  assert.equal(snapshots.b.paused, false);
  assert.equal(snapshots.b.pauseReason, null);
  assert.equal(snapshots.b.isTicking, false);
  assert.equal(snapshots.b.lastRunAt, 'run-b');
  assert.equal(snapshots.b.lastError, null);
  assert.deepEqual(snapshots.b.counts, { pending: 0, running: 1, done: 0, error: 0 });

  assert.equal(scheduler.getStatus().paused, false, 'legacy empty context remains independent');
});

test('authenticated shared autonomous ticks fail closed without an organization', async () => {
  const shared = { authEnabled: true, storeNamespace: '', pinnedOrganizationId: '' };
  assert.equal(scheduler._test.shouldSkipUnscopedSharedTick({}, shared), true);
  assert.equal(
    scheduler._test.shouldSkipUnscopedSharedTick({ organizationId: 'org-a' }, shared),
    false,
  );
  assert.equal(
    scheduler._test.shouldSkipUnscopedSharedTick({}, { ...shared, pinnedOrganizationId: 'org:pinned' }),
    false,
  );
  assert.equal(
    scheduler._test.shouldSkipUnscopedSharedTick({}, { ...shared, storeNamespace: 'tenant1' }),
    false,
  );
  assert.equal(
    scheduler._test.shouldSkipUnscopedSharedTick({}, { ...shared, authEnabled: false }),
    false,
  );

  assert.deepEqual(
    await scheduler.processPending(undefined, { workspaceGuard: shared }),
    { skipped: 'workspace-context-required' },
  );
});

test('discovery stamps the active org/project and ignores another project in-flight set', async () => {
  const enqueued = [];
  const context = { organizationId: 'org-discovery', projectId: 'native-selected' };
  const queued = await runWithWorkspaceContext(context, () => scheduler._test.discover(
    { apiKey: 'key', assumedRole: { id: 'role-1' }, config: { enrichLabels: ['AI'] } },
    {
      linear: {
        getProjectsWithLabels: async () => [{ id: 'linear-project', name: 'Project' }],
      },
      store: {
        listJobs: () => [{
          projectId: 'linear-project', orgId: 'org-discovery',
          nativeProjectId: 'native-other', status: 'running',
        }],
      },
      enqueue: (job) => { enqueued.push(job); return { id: 'job-1', ...job }; },
    },
  ));

  assert.equal(queued, 1);
  assert.equal(enqueued[0].orgId, 'org-discovery');
  assert.equal(enqueued[0].nativeProjectId, 'native-selected');
});

test('each queued job re-enters its exact org/project context during processing', async () => {
  const seen = await runWithWorkspaceContext(
    { organizationId: 'org-run', projectId: '' },
    () => Promise.all([
      scheduler._test.runJobInWorkspace(
        { orgId: 'org-run', nativeProjectId: 'native-one' },
        currentWorkspaceContext(),
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return currentWorkspaceContext();
        },
      ),
      scheduler._test.runJobInWorkspace(
        { orgId: 'org-run', nativeProjectId: 'native-two' },
        currentWorkspaceContext(),
        async () => currentWorkspaceContext(),
      ),
    ]),
  );
  assert.deepEqual(seen, [
    { organizationId: 'org-run', projectId: 'native-one' },
    { organizationId: 'org-run', projectId: 'native-two' },
  ]);
});

test('self-scheduling timers are stored independently per workspace', (t) => {
  scheduler._test.resetAllRuntimes();
  const originalGetAgentConfig = store.getAgentConfig;
  store.getAgentConfig = () => ({ intervalMinutes: 5, scheduleEnabled: false });
  t.after(() => {
    store.getAgentConfig = originalGetAgentConfig;
    scheduler._test.resetAllRuntimes();
  });

  const first = { organizationId: 'org-timer', projectId: 'native-one' };
  const second = { organizationId: 'org-timer', projectId: 'native-two' };
  scheduler._test.scheduleNext(first);
  scheduler._test.scheduleNext(second);

  const runtimeOne = scheduler._test.runtimeFor(first);
  const runtimeTwo = scheduler._test.runtimeFor(second);
  assert.notEqual(runtimeOne, runtimeTwo);
  assert.notEqual(runtimeOne.timer, runtimeTwo.timer);
  assert.match(runtimeOne.nextRunAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(runtimeTwo.nextRunAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('enqueue defaults to the ALS selection and emits only that workspace', async (t) => {
  const originals = {
    listJobs: store.listJobs,
    addJob: store.addJob,
    getAgentConfig: store.getAgentConfig,
    getAssumedRole: store.getAssumedRole,
    publishJobsSnapshot: workspaceEvents.publishJobsSnapshot,
    publishAgentStatus: workspaceEvents.publishAgentStatus,
  };
  const jobs = [];
  const emitted = [];
  store.listJobs = () => jobs;
  store.addJob = (job) => { jobs.unshift(job); return job; };
  store.getAgentConfig = () => ({ intervalMinutes: 5, scheduleEnabled: true });
  store.getAssumedRole = () => ({ id: 'role-1', name: 'Planner' });
  workspaceEvents.publishJobsSnapshot = (context) => emitted.push(['jobs', context]);
  workspaceEvents.publishAgentStatus = (_status, context) => emitted.push(['status', context]);
  t.after(() => {
    Object.assign(store, {
      listJobs: originals.listJobs,
      addJob: originals.addJob,
      getAgentConfig: originals.getAgentConfig,
      getAssumedRole: originals.getAssumedRole,
    });
    workspaceEvents.publishJobsSnapshot = originals.publishJobsSnapshot;
    workspaceEvents.publishAgentStatus = originals.publishAgentStatus;
  });

  const context = { organizationId: 'org-enqueue', projectId: 'native-enqueue' };
  const job = await runWithWorkspaceContext(context, () => scheduler.enqueue({
    projectId: 'linear-enqueue',
    projectName: 'Enqueue',
    assumedRole: { id: 'role-1', name: 'Planner' },
  }));

  assert.equal(job.orgId, 'org-enqueue');
  assert.equal(job.nativeProjectId, 'native-enqueue');
  // No per-request llm-gateway flag => the job record carries no dead field.
  assert.equal('llmGateway' in job, false);
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted.map(([, selected]) => selected), [context, context]);

  const flagged = await runWithWorkspaceContext(context, () => scheduler.enqueue({
    projectId: 'linear-enqueue-flagged',
    projectName: 'Enqueue flagged',
    assumedRole: { id: 'role-1', name: 'Planner' },
    llmGateway: 'langsmith',
  }));
  assert.equal(flagged.llmGateway, 'langsmith');

  const unknownSelector = await runWithWorkspaceContext(context, () => scheduler.enqueue({
    projectId: 'linear-enqueue-unknown',
    projectName: 'Enqueue unknown',
    assumedRole: { id: 'role-1', name: 'Planner' },
    llmGateway: 'other-router',
  }));
  assert.equal('llmGateway' in unknownSelector, false);
});
