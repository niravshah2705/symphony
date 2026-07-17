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
