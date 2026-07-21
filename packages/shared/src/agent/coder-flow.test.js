'use strict';

const test = require('node:test');
const assert = require('node:assert');

const orchestrator = require('./coder-orchestrator');
const { parseVerdict, preflightTask, preflightAndPause, pauseForRuntimeError, dispatchReadyTask, dispatch } = orchestrator;
const { activeRepositoryBranch, assertOpenSweRepositoryProvider } = require('./coder');
const { AgentAvailabilityError } = require('./availability');
const { RepositoryBrokerError } = require('./repository-broker');
const { AgentRuntimeError } = require('./runtimes');
const { pickStateByType } = require('../linear');

/* ------------------------------ parseVerdict ---------------------------- */

test('parseVerdict reads a fenced verdict JSON block (completed)', () => {
  const text = 'Implemented and validated.\n\n```verdict\n{"status": "completed", "reason": "All acceptance criteria met."}\n```';
  const v = parseVerdict(text);
  assert.strictEqual(v.status, 'completed');
  assert.strictEqual(v.reason, 'All acceptance criteria met.');
});

test('parseVerdict reads an insufficient JSON verdict with its reason', () => {
  const v = parseVerdict('{"status":"insufficient","reason":"No repository configured for this project."}');
  assert.strictEqual(v.status, 'insufficient');
  assert.strictEqual(v.reason, 'No repository configured for this project.');
});

test('parseVerdict extracts the merged PR URL when completed', () => {
  const text = '```verdict\n{"status":"completed","reason":"Merged.","pr":"https://github.com/acme/app/pull/42"}\n```';
  const v = parseVerdict(text);
  assert.strictEqual(v.status, 'completed');
  assert.strictEqual(v.pr, 'https://github.com/acme/app/pull/42');
});

test('parseVerdict leaves pr null when absent', () => {
  assert.strictEqual(parseVerdict('{"status":"completed","reason":"done"}').pr, null);
  assert.strictEqual(parseVerdict('VERDICT: completed — done').pr, null);
});

test('parseVerdict accepts a plain VERDICT: line', () => {
  const v = parseVerdict('Work done.\nVERDICT: completed — shipped and green.');
  assert.strictEqual(v.status, 'completed');
  assert.strictEqual(v.reason, 'shipped and green.');
});

test('parseVerdict normalizes case in the status field', () => {
  const v = parseVerdict('{"status":"Completed","reason":"done"}');
  assert.strictEqual(v.status, 'completed');
});

test('parseVerdict defaults to insufficient when no verdict is present', () => {
  const v = parseVerdict('I finished the task and it looks great.');
  assert.strictEqual(v.status, 'insufficient');
  assert.match(v.reason, /did not emit/i);
});

test('parseVerdict defaults to insufficient on empty/nullish input', () => {
  assert.strictEqual(parseVerdict('').status, 'insufficient');
  assert.strictEqual(parseVerdict(undefined).status, 'insufficient');
});

test('OpenSWE fails closed for a GitLab repository selection', () => {
  assert.doesNotThrow(() => assertOpenSweRepositoryProvider('github'));
  assert.throws(() => assertOpenSweRepositoryProvider('gitlab'), /GitHub-only/);
});

test('coder results report the broker branch after an automatic retry rotation', () => {
  const broker = { publicInfo: () => ({ branch: 'task-123-retry-17' }) };
  assert.strictEqual(activeRepositoryBranch('task-123', broker), 'task-123-retry-17');
  assert.strictEqual(activeRepositoryBranch('task-123', null), 'task-123');
});

test('Git 403 preflight stops before model resolution, job creation, or issue transition', async () => {
  const task = {
    id: 'issue-1',
    identifier: 'ENG-1',
    labels: [],
    project: { id: 'project-1', name: 'Project' },
  };
  let modelResolved = false;
  let modelProbed = false;
  let dispatches = 0;

  await assert.rejects(
    () => dispatchReadyTask(
      task,
      async () => {
        modelResolved = true;
        return { provider: 'ollama', host: 'http://localhost:11434', model: 'coder' };
      },
      { apiKey: 'linear-key' },
      {
        repositorySelectionForTask: () => ({ provider: 'github', repoRef: 'acme/app', token: 'secret' }),
        cachedReadinessProbe: (_key, probe) => probe(),
        probeRepositoryAvailability: async () => {
          throw new AgentAvailabilityError('git', 'friendly', 403);
        },
        probeModelAvailability: async () => { modelProbed = true; },
        dispatch: () => { dispatches += 1; },
      }
    ),
    (error) => error && error.resource === 'git' && error.status === 403
  );

  // createCodingJob/startIssue live exclusively in dispatch(), which is reached
  // only after preflightTask succeeds.
  assert.equal(modelResolved, false);
  assert.equal(modelProbed, false);
  assert.equal(dispatches, 0, 'dispatch owns both createCodingJob and startIssue');
});

test('model preflight stops before job creation or issue transition', async () => {
  const task = {
    id: 'issue-model',
    identifier: 'ENG-MODEL',
    labels: [],
    project: { id: 'project-model', name: 'Project' },
  };
  let dispatches = 0;
  let repositoryProbes = 0;

  await assert.rejects(
    () => dispatchReadyTask(
      task,
      async () => ({ provider: 'ollama', host: 'http://localhost:11434', model: 'missing' }),
      { apiKey: 'linear-key' },
      {
        repositorySelectionForTask: () => ({ provider: 'github', repoRef: 'acme/app', token: 'secret' }),
        cachedReadinessProbe: (_key, probe) => probe(),
        probeRepositoryAvailability: async () => { repositoryProbes += 1; },
        probeModelAvailability: async () => {
          throw new AgentAvailabilityError('model', 'friendly', 404, 'model_not_found');
        },
        dispatch: () => { dispatches += 1; },
      },
    ),
    (error) => error && error.resource === 'model' && error.status === 404,
  );

  assert.equal(repositoryProbes, 1);
  assert.equal(dispatches, 0, 'dispatch owns both createCodingJob and startIssue');
});

test('successful readiness is probed again for every later dispatch', async () => {
  const task = {
    id: 'issue-freshness',
    identifier: 'ENG-FRESH',
    labels: [],
    project: { id: 'project-freshness', name: 'Project' },
  };
  let repositoryProbes = 0;
  let modelProbes = 0;
  const dependencies = {
    repositorySelectionForTask: () => ({ provider: 'github', repoRef: 'acme/app', token: 'secret' }),
    probeRepositoryAvailability: async () => { repositoryProbes += 1; },
    probeModelAvailability: async () => { modelProbes += 1; },
  };
  const resolveRole = async () => ({ provider: 'ollama', host: 'http://localhost:11434', model: 'coder' });

  await preflightTask(task, resolveRole, dependencies);
  await preflightTask(task, resolveRole, dependencies);

  assert.equal(repositoryProbes, 2);
  assert.equal(modelProbes, 2);
});

test('manual readiness guard establishes the same sanitized global pause', async (t) => {
  orchestrator._test.clearPause('test setup');
  t.after(() => orchestrator._test.clearPause('test cleanup'));
  const task = {
    id: 'issue-manual',
    identifier: 'ENG-MANUAL',
    labels: [],
    project: { id: 'project-manual', name: 'Project' },
  };

  await assert.rejects(
    () => preflightAndPause(
      task,
      async () => ({ provider: 'codex', model: 'gpt-test' }),
      {
        repositorySelectionForTask: () => ({ provider: 'github', repoRef: 'acme/app', token: 'secret' }),
        cachedReadinessProbe: (_key, probe) => probe(),
        probeRepositoryAvailability: async () => {
          throw new AgentAvailabilityError('git', 'raw provider 403 secret', 403);
        },
      },
    ),
    (error) => error && error.pauseReason && error.pauseReason.resource === 'git',
  );

  assert.equal(orchestrator.status().paused, true);
  assert.match(orchestrator.status().pauseReason.message, /repository access is unavailable/i);
  assert.doesNotMatch(JSON.stringify(orchestrator.status()), /raw provider|secret|403/i);
});

test('runtime outage helper pauses direct runs and preserves the selected model role', async (t) => {
  orchestrator._test.clearPause('test setup');
  t.after(() => orchestrator._test.clearPause('test cleanup'));
  const task = {
    id: 'issue-direct-local',
    identifier: 'ENG-DIRECT',
    labels: ['local'],
    project: { id: 'project-direct', name: 'Project' },
  };
  let resolvedRole = null;
  const readiness = await preflightAndPause(
    task,
    async (role) => {
      resolvedRole = role;
      return { provider: 'ollama', host: 'http://localhost:11434', model: 'local-coder' };
    },
    {
      repositorySelectionForTask: () => ({ provider: 'github', repoRef: 'acme/app', token: 'secret' }),
      cachedReadinessProbe: (_key, probe) => probe(),
      probeRepositoryAvailability: async () => ({ available: true }),
      probeModelAvailability: async () => ({ available: true }),
    },
  );
  assert.equal(resolvedRole, 'local');
  assert.equal(readiness.role, 'local');

  const reason = pauseForRuntimeError(
    new AgentRuntimeError(
      'Local runtime failed.',
      'runtime_execution_failed',
      502,
      { cause: new Error('Request failed with HTTP 403') },
    ),
    { task, role: readiness.role, llm: readiness.llm, repositoryProvider: readiness.selection.provider },
  );
  assert.equal(reason.resource, 'model');
  assert.equal(reason.role, 'local');
  assert.equal(orchestrator.status().paused, true);
});

test('coder pause recovery waits, reschedules failed probes, and clears after a ready settings change', async (t) => {
  orchestrator._test.clearPause('test setup');
  t.after(() => orchestrator._test.clearPause('test cleanup'));
  const task = {
    id: 'issue-recovery',
    identifier: 'ENG-RECOVERY',
    project: { id: 'project-recovery', name: 'Project' },
  };
  orchestrator._test.pause('git', new Error('unavailable'), {
    task,
    taskIdentifier: task.identifier,
    provider: 'github',
  });
  const originalFingerprint = orchestrator._test.readinessFingerprint();
  let now = Date.now();
  let probes = 0;
  const common = {
    now: () => now,
    readinessFingerprint: () => originalFingerprint,
    repositorySelectionForTask: () => ({ provider: 'github', repoRef: 'acme/app', token: 'secret' }),
    probeRepositoryAvailability: async () => { probes += 1; },
  };

  assert.equal(await orchestrator._test.recoverPause({}, common), false);
  assert.equal(probes, 0, 'an early recovery check must not hammer the provider');

  now += 61_000;
  const failing = {
    ...common,
    probeRepositoryAvailability: async () => {
      probes += 1;
      throw new AgentAvailabilityError('git', 'still unavailable', 403);
    },
  };
  assert.equal(await orchestrator._test.recoverPause({}, failing), false);
  assert.equal(probes, 1);
  assert.equal(await orchestrator._test.recoverPause({}, failing), false);
  assert.equal(probes, 1, 'a failed periodic probe must schedule the next retry');

  const changedAndReady = {
    ...common,
    readinessFingerprint: () => 'settings-changed',
  };
  assert.equal(await orchestrator._test.recoverPause({}, changedAndReady), true);
  assert.equal(probes, 2);
  assert.equal(orchestrator.status().paused, false);
  assert.equal(orchestrator.status().pauseReason, null);
});

test('runtime repository unavailability pauses safely without finishing the Linear issue', async (t) => {
  orchestrator._test.clearPause('test setup');
  t.after(() => orchestrator._test.clearPause('test cleanup'));
  const jobs = [];
  const fakeStore = {
    addJob(job) {
      jobs.push({ ...job });
      return job;
    },
    appendJobStep(id, step) {
      const job = jobs.find((candidate) => candidate.id === id);
      job.steps = [...(job.steps || []), step];
    },
    updateJob(id, patch) {
      const job = jobs.find((candidate) => candidate.id === id);
      Object.assign(job, patch);
      return job;
    },
  };
  let starts = 0;
  let finishes = 0;
  const task = {
    id: 'issue-2',
    identifier: 'ENG-2',
    title: 'Change code',
    labels: [],
    project: { id: 'project-2', name: 'Project' },
  };

  await dispatch(
    task,
    {
      apiKey: 'linear-key',
      keys: {},
      role: 'global',
      llm: { provider: 'codex', model: 'gpt-test' },
      repositoryProvider: 'github',
      repositoryToken: 'secret',
      repositoryUrl: 'acme/app',
    },
    {
      store: fakeStore,
      startIssue: async () => {
        starts += 1;
        return { name: 'In Progress' };
      },
      runPlannedCoder: async () => {
        throw new RepositoryBrokerError('git push failed: HTTP 403 token=raw-secret', 'provider_error');
      },
      finishIssue: async () => { finishes += 1; },
    }
  );

  assert.equal(starts, 1);
  assert.equal(finishes, 0, 'availability failures must never be posted as a task verdict');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'error');
  assert.match(jobs[0].error, /repository access is unavailable/i);
  assert.doesNotMatch(JSON.stringify(jobs[0]), /raw-secret|git push failed/i);
  assert.equal(orchestrator.status().paused, true);
  assert.equal(orchestrator.status().pauseReason.resource, 'git');
});

test('ordinary repository workflow errors finish as insufficient without pausing the monitor', async (t) => {
  orchestrator._test.clearPause('test setup');
  t.after(() => orchestrator._test.clearPause('test cleanup'));
  const jobs = [];
  const fakeStore = {
    addJob(job) { jobs.push({ ...job }); return job; },
    appendJobStep(id, step) {
      const job = jobs.find((candidate) => candidate.id === id);
      job.steps = [...(job.steps || []), step];
    },
    updateJob(id, patch) {
      const job = jobs.find((candidate) => candidate.id === id);
      Object.assign(job, patch);
      return job;
    },
  };
  let finishes = 0;
  let outcome = null;
  const task = {
    id: 'issue-workspace',
    identifier: 'ENG-WORKSPACE',
    title: 'Change code',
    labels: [],
    project: { id: 'project-workspace', name: 'Project' },
  };

  await dispatch(
    task,
    {
      apiKey: 'linear-key',
      keys: {},
      role: 'global',
      llm: { provider: 'codex', model: 'gpt-test' },
      repositoryProvider: 'github',
      repositoryToken: 'secret',
      repositoryUrl: 'acme/app',
    },
    {
      store: fakeStore,
      startIssue: async () => ({ name: 'In Progress' }),
      runPlannedCoder: async () => {
        throw new RepositoryBrokerError('Workspace has uncommitted changes.', 'workspace_dirty');
      },
      finishIssue: async (_apiKey, result) => {
        finishes += 1;
        outcome = result.outcome;
      },
    },
  );

  assert.equal(finishes, 1);
  assert.equal(outcome, 'insufficient');
  assert.equal(jobs[0].status, 'done');
  assert.equal(jobs[0].summary.outcome, 'insufficient');
  assert.equal(orchestrator.status().paused, false);
});

/* ----------------------------- pickStateByType -------------------------- */

const STATES = [
  { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 's-prog', name: 'In Progress', type: 'started', position: 2 },
  { id: 's-review', name: 'In Review', type: 'started', position: 3 },
  { id: 's-done', name: 'Done', type: 'completed', position: 4 },
];

test('pickStateByType prefers the state whose name matches', () => {
  assert.strictEqual(pickStateByType(STATES, 'started', 'In Progress').id, 's-prog');
});

test('pickStateByType falls back to the lowest-position state of the type', () => {
  // No "Working" name match → lowest-position started state (In Progress @2).
  assert.strictEqual(pickStateByType(STATES, 'started', 'Working').id, 's-prog');
});

test('pickStateByType resolves the completed (Done) state', () => {
  assert.strictEqual(pickStateByType(STATES, 'completed', 'Done').id, 's-done');
});

test('pickStateByType returns null when no state of the type exists', () => {
  assert.strictEqual(pickStateByType(STATES, 'canceled', 'Canceled'), null);
});

test('resolveMaxConcurrent reflects the UI-editable agent config value', () => {
  const { getAgentConfig } = require('../store');
  const configured = Number(getAgentConfig().maxConcurrentCoders);
  const resolved = orchestrator._test.resolveMaxConcurrent();
  assert.ok(Number.isInteger(resolved) && resolved >= 1);
  if (Number.isFinite(configured) && configured >= 1) {
    assert.strictEqual(resolved, Math.floor(configured));
  }
});
