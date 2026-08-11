'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('./scheduler');
const { AgentAvailabilityError } = require('./availability');
const { AgentError } = require('./plan');

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

test('processApprovalDeadlines delegates to the sweep and swallows errors', async () => {
  let called = 0;
  await scheduler._test.processApprovalDeadlines({ sweepExpiredGates: async () => { called += 1; return []; } });
  assert.equal(called, 1); // runs with no Linear key/role — it is not gated by processPending

  const res = await scheduler._test.processApprovalDeadlines({
    sweepExpiredGates: async () => { throw new Error('boom'); },
  });
  assert.deepEqual(res, { error: true }); // a failing sweep cannot break the scheduling loop
});

test('runJob threads the resolved org effectivePolicy into generatePlan (enforcement wiring)', async () => {
  const job = { id: 'job-enf', projectId: 'p1', projectName: 'Proj', assumedRole: null, status: 'pending', steps: [] };
  const fakeStore = {
    addJob() {},
    updateJob(id, patch) { Object.assign(job, patch); return job; },
    appendJobStep(id, step) { job.steps.push(step); },
  };
  const effectivePolicy = { harness: { effective: ['deepagent'] }, tools: { effective: ['quality'] } };
  let seen = null;
  await scheduler._test.runJob(
    job,
    { apiKey: 'k', keys: {}, llm: { provider: 'codex', model: 'm' }, config: { createIssues: true } },
    {
      store: fakeStore,
      getSettings: () => ({ llmProvider: 'codex' }),
      linear: { getMilestonesWithIssueCounts: async () => ({ project: { id: 'p1' }, milestones: [] }) },
      resolvePolicy: async () => ({ effectivePolicy, prefs: {} }),
      generatePlan: async (args) => { seen = args.settings; return { viable: true, plan: {}, traceUrl: null, traced: false, runId: 'r' }; },
      applyPlan: async () => ({ milestonesCreated: 1, issuesCreated: 1, dependenciesCreated: 0, warnings: [] }),
      applyAiplanned: async () => {},
    }
  );
  assert.deepEqual(seen.effectivePolicy, effectivePolicy);
});

test('runJob is fail-open when policy resolution throws (planning stays allow-all)', async () => {
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

test('enforceLlmModel downgrades a denied model to a same-provider allowed one (fail-open)', () => {
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
  // No same-provider allowed alternative → keep the denied model (fail-open, no brick).
  const noClaude = { models: { effective: ['codex-gpt-5-5'] } };
  assert.equal(scheduler._test.enforceLlmModel(denied, noClaude, catalog).model, 'claude-opus-4-8');
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
