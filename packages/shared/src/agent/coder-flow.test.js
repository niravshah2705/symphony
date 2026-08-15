'use strict';

const test = require('node:test');
const assert = require('node:assert');

const orchestrator = require('./coder-orchestrator');
const { parseVerdict, preflightTask, preflightAndPause, pauseForRuntimeError, dispatchReadyTask, dispatch } = orchestrator;
const {
  activeRepositoryArtifactReceipt,
  activeRepositoryBranch,
  assertOpenSweRepositoryProvider,
  executeCodingRuntime,
} = require('./coder');
const framework = require('./framework');
const { AgentAvailabilityError } = require('./availability');
const { RepositoryBrokerError } = require('./repository-broker');
const { AgentRuntimeError } = require('./runtimes');
const { PolicyDeniedError } = require('./settings-policy');
const { pickStateByType } = require('../linear');
const workspaceEvents = require('./workspace-events');
const { SENTINEL_TOKEN } = require('../egress');

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

test('planned coder results export the broker-authoritative artifact receipt', () => {
  const receipt = {
    source: 'repository-broker',
    commandId: 'run-1:code:1',
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
  };
  const broker = { artifactReceipt: () => receipt };

  assert.strictEqual(activeRepositoryArtifactReceipt(broker), receipt);
  assert.strictEqual(activeRepositoryArtifactReceipt(null), null);
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

test('manual readiness guard preserves policy denial without creating a model pause', async (t) => {
  const context = { orgId: 'org-policy-denied', nativeProjectId: 'native-policy-denied' };
  orchestrator._test.clearPause('test setup', context);
  t.after(() => orchestrator._test.clearPause('test cleanup', context));
  const task = {
    id: 'issue-policy-denied',
    identifier: 'ENG-POLICY',
    labels: [],
    project: { id: 'project-policy-denied', name: 'Project' },
    ...context,
  };

  await assert.rejects(
    () => preflightAndPause(
      task,
      async () => { throw new PolicyDeniedError('model', 'private-model'); },
      {
        context,
        repositorySelectionForTask: () => ({ provider: 'github', repoRef: 'acme/app', token: 'secret' }),
        cachedReadinessProbe: (_key, probe) => probe(),
        probeRepositoryAvailability: async () => ({ available: true }),
      },
    ),
    (error) => error.code === 'policy_denied' && error.status === 403,
  );

  assert.equal(orchestrator.status(context).paused, false);
});

test('runtime policy denial is never classified as a model availability pause', (t) => {
  const context = { orgId: 'org-runtime-policy', nativeProjectId: 'native-runtime-policy' };
  orchestrator._test.clearPause('test setup', context);
  t.after(() => orchestrator._test.clearPause('test cleanup', context));

  const reason = pauseForRuntimeError(
    new PolicyDeniedError('harness', 'claude-agent-sdk'),
    {
      task: { id: 'policy-runtime-issue', identifier: 'POLICY-1', ...context },
      role: 'execution',
      llm: { provider: 'codex', model: 'gpt-5.6-terra' },
    },
  );

  assert.equal(reason, null);
  assert.equal(orchestrator.status(context).paused, false);
});

test('selected autonomous policy resolution rejects missing effective policy while local mode stays compatible', async () => {
  const selected = { orgId: 'org-autonomous-policy', nativeProjectId: 'native-autonomous-policy' };
  for (const response of [null, {}, { effectivePolicy: null, prefs: {} }]) {
    await assert.rejects(
      () => orchestrator._test.resolveAutonomousPolicy(
        { agentRuntime: 'deepagent' },
        selected,
        {
          resolvePolicy: async () => response,
          resolveLlm: async () => ({ provider: 'ollama', host: 'http://localhost:11434', model: 'coder' }),
        },
      ),
      (error) => error.code === 'policy_unavailable' && error.status === 503,
    );
  }

  const local = await orchestrator._test.resolveAutonomousPolicy(
    { agentRuntime: 'deepagent' },
    {},
    {
      resolvePolicy: async () => null,
      resolveLlm: async () => ({ provider: 'ollama', host: 'http://localhost:11434', model: 'coder' }),
    },
  );
  assert.equal(local.effectivePolicy, null);
});

test('proxy-vault autonomous polling needs no stored Linear key and uses the sentinel for every Linear read', async (t) => {
  const context = {};
  orchestrator._test.clearPause('test setup', context);
  t.after(() => orchestrator._test.clearPause('test cleanup', context));
  const linearKeys = [];

  const result = await orchestrator.pollOnce(context, {
    getSettings: () => ({
      linearApiKey: '',
      agentRuntime: 'deepagent',
      workflowPattern: 'sequential',
    }),
    getApiKey: () => SENTINEL_TOKEN,
    billingStatus: () => ({ blocked: false }),
    resolvePolicy: async () => null,
    fetchPlannedProjects: async (apiKey) => {
      linearKeys.push(apiKey);
      return [];
    },
    fetchPlannedTasks: async (apiKey) => {
      linearKeys.push(apiKey);
      return new Map();
    },
  });

  assert.deepEqual(result, { dispatched: true });
  assert.deepEqual(linearKeys, [SENTINEL_TOKEN, SENTINEL_TOKEN]);
});

test('autonomous planned coder threads selected policy and loads only permitted MCP plugins', async (t) => {
  const context = { orgId: 'org-autonomous-mcp', nativeProjectId: 'native-autonomous-mcp' };
  const effectivePolicy = {
    harness: { effective: ['deepagent'] },
    plugins: { effective: ['linear'] },
  };
  const policyCalls = [];
  const governed = await orchestrator._test.resolveAutonomousPolicy(
    {
      linearApiKey: 'linear-key',
      agentRuntime: 'deepagent',
      workflowPattern: 'sequential',
      langsmithTracing: true,
    },
    context,
    {
      resolvePolicy: async (orgId, projectId) => {
        policyCalls.push([orgId, projectId]);
        return {
          effectivePolicy,
          prefs: { workflowPattern: 'parallel', langsmithTracing: 'false' },
        };
      },
      resolveLlm: async () => ({ provider: 'ollama', host: 'http://localhost:11434', model: 'coder' }),
    },
  );
  const llm = await governed.resolveRole('execution');
  assert.deepEqual(policyCalls, [['org-autonomous-mcp', 'native-autonomous-mcp']]);
  assert.equal(governed.keys.workflowPattern, 'parallel');
  assert.equal(governed.keys.langsmithTracing, false);

  const mcp = require('./mcp');
  const originalLoadMcpTools = mcp.loadMcpTools;
  const originalInstallSkills = framework.installSkills;
  const sentinel = new Error('stop after governed MCP selection');
  let loadedPlugins = null;
  mcp.loadMcpTools = async (names) => {
    loadedPlugins = names;
    throw sentinel;
  };
  framework.installSkills = () => [];
  t.after(() => {
    mcp.loadMcpTools = originalLoadMcpTools;
    framework.installSkills = originalInstallSkills;
    orchestrator._test.clearPause('test cleanup', context);
  });

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
  let plannedSettings = null;
  await dispatch(
    {
      id: 'issue-autonomous-mcp',
      identifier: 'AUTO-1',
      title: 'Govern MCP',
      project: { id: 'linear-project-autonomous', name: 'Autonomous' },
      ...context,
    },
    {
      apiKey: 'linear-key',
      keys: governed.keys,
      settings: governed.settings,
      llm,
      role: 'execution',
      repositoryProvider: 'github',
      repositoryToken: 'token',
      repositoryUrl: 'acme/app',
      ...context,
    },
    {
      store: fakeStore,
      startIssue: async () => ({ name: 'In Progress' }),
      runPlannedCoder: async (args) => {
        plannedSettings = args.settings;
        await assert.rejects(
          () => executeCodingRuntime({
            llm: args.llm,
            keys: args.keys,
            apiKey: args.apiKey,
            step: () => {},
            workDir: process.cwd(),
            env: {},
            repositoryProvider: args.repositoryProvider,
            repositoryBroker: null,
            prompt: 'test',
            invokeConfig: {},
            settings: args.settings,
            attribution: {},
          }),
          (error) => error === sentinel,
        );
        return { finalText: '{"status":"completed","reason":"governed"}' };
      },
      finishIssue: async () => {},
    },
  );

  assert.deepEqual(plannedSettings, {
    effectivePolicy,
    orgId: context.orgId,
    nativeProjectId: context.nativeProjectId,
  });
  assert.deepEqual(loadedPlugins, ['linear']);
  assert.equal(jobs[0].status, 'done');
});

test('proxied coding isolates DeepAgent shell and developer-tool contexts', async (t) => {
  const mcp = require('./mcp');
  const originalLoadMcpTools = mcp.loadMcpTools;
  const originalInstallSkills = framework.installSkills;
  const originalBuildAgent = framework.buildAgent;
  let mcpContext;
  let agentContext;
  mcp.loadMcpTools = async (_names, ctx) => {
    mcpContext = ctx;
    return [];
  };
  framework.installSkills = () => [];
  framework.buildAgent = (options) => {
    agentContext = options.ctx;
    return {
      agent: { invoke: async () => ({ messages: [{ role: 'assistant', content: 'done' }] }) },
      tools: [],
      skillPaths: [],
    };
  };
  t.after(() => {
    mcp.loadMcpTools = originalLoadMcpTools;
    framework.installSkills = originalInstallSkills;
    framework.buildAgent = originalBuildAgent;
  });

  const result = await executeCodingRuntime({
    llm: { provider: 'ollama', model: 'fixture', host: 'http://127.0.0.1:4030/ollama' },
    keys: { agentRuntime: 'deepagent', workflowPattern: 'sequential' },
    apiKey: 'sentinel',
    step: () => {},
    workDir: process.cwd(),
    env: {},
    repositoryProvider: 'github',
    repositoryBroker: null,
    prompt: 'test',
    invokeConfig: {},
    settings: {},
    attribution: {},
    runtimeEnv: { NODE_ENV: 'development', EGRESS_PROXY_URL: 'http://127.0.0.1:4030' },
  });

  assert.equal(mcpContext.isolateNetwork, true);
  assert.equal(agentContext.isolateNetwork, true);
  assert.equal(agentContext.cwd, process.cwd());
  assert.equal(result.finalText, 'done');
});

test('runtime outage helper pauses direct runs on the execution role regardless of legacy size label', async (t) => {
  orchestrator._test.clearPause('test setup');
  t.after(() => orchestrator._test.clearPause('test cleanup'));
  // The legacy "local" model label no longer influences model selection — the
  // coder always resolves the purpose-based `execution` role.
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
  assert.equal(resolvedRole, 'execution');
  assert.equal(readiness.role, 'execution');

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
  assert.equal(reason.role, 'execution');
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

test('planned runtime policy denial records a governed error without pausing or finalizing the issue', async (t) => {
  const context = { orgId: 'org-planned-policy-denied', nativeProjectId: 'native-planned-policy-denied' };
  orchestrator._test.clearPause('test setup', context);
  t.after(() => orchestrator._test.clearPause('test cleanup', context));
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

  await dispatch(
    {
      id: 'issue-planned-policy-denied',
      identifier: 'POLICY-PLANNED-1',
      title: 'Denied planned runtime',
      project: { id: 'linear-project-policy-denied', name: 'Policy' },
      ...context,
    },
    {
      apiKey: 'linear-key',
      keys: { agentRuntime: 'deepagent' },
      settings: {
        effectivePolicy: { harness: { effective: ['deepagent'] } },
        ...context,
      },
      role: 'execution',
      llm: { provider: 'codex', model: 'gpt-5.6-terra' },
      repositoryProvider: 'github',
      repositoryToken: 'token',
      repositoryUrl: 'acme/app',
      ...context,
    },
    {
      store: fakeStore,
      startIssue: async () => ({ name: 'In Progress' }),
      runPlannedCoder: async () => {
        throw new PolicyDeniedError('harness', 'claude-agent-sdk');
      },
      finishIssue: async () => { finishes += 1; },
    },
  );

  assert.equal(finishes, 0);
  assert.equal(jobs[0].status, 'error');
  assert.equal(jobs[0].policyDenied, true);
  assert.equal(orchestrator.status(context).paused, false);
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

test('duplicate external issue ids run independently and publish exact A/B workspace snapshots', async (t) => {
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
  const coderEvents = [];
  const jobEvents = [];
  const originalPublishCoderStatus = workspaceEvents.publishCoderStatus;
  const originalPublishJobsSnapshot = workspaceEvents.publishJobsSnapshot;
  workspaceEvents.publishCoderStatus = (coder, context) => coderEvents.push({ coder, context });
  workspaceEvents.publishJobsSnapshot = (context) => jobEvents.push(context);

  const releases = new Map();
  t.after(() => {
    workspaceEvents.publishCoderStatus = originalPublishCoderStatus;
    workspaceEvents.publishJobsSnapshot = originalPublishJobsSnapshot;
    for (const release of releases.values()) release();
    orchestrator._test.clearPause('test cleanup', { orgId: 'scope-org-a', nativeProjectId: 'native-a' });
    orchestrator._test.clearPause('test cleanup', { orgId: 'scope-org-b', nativeProjectId: 'native-b' });
  });

  const sharedExternalTask = {
    id: 'same-linear-issue-id',
    identifier: 'ENG-42',
    title: 'Same identifier in separate Linear workspaces',
    labels: [],
    project: { id: 'same-linear-project-id', name: 'App' },
  };
  const commonCtx = {
    apiKey: 'linear-key',
    keys: {},
    role: 'execution',
    llm: { provider: 'codex', model: 'gpt-test' },
    repositoryProvider: 'github',
    repositoryToken: 'secret',
    repositoryUrl: 'acme/app',
  };
  const dependencies = {
    store: fakeStore,
    startIssue: async () => ({ name: 'In Progress' }),
    runPlannedCoder: ({ issue }) => new Promise((resolve) => {
      releases.set(issue.orgId, () => resolve({ finalText: '{"status":"completed","reason":"done"}' }));
    }),
    finishIssue: async () => {},
  };
  const contextA = { orgId: 'scope-org-a', nativeProjectId: 'native-a' };
  const contextB = { orgId: 'scope-org-b', nativeProjectId: 'native-b' };

  const runA = dispatch({ ...sharedExternalTask, ...contextA }, { ...commonCtx, ...contextA }, dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(orchestrator._test.hasCapacity(contextA, 1), false, 'A is at its selected-workspace cap');
  assert.equal(orchestrator._test.hasCapacity(contextB, 1), true, 'A at cap must not block B');

  const runB = dispatch({ ...sharedExternalTask, ...contextB }, { ...commonCtx, ...contextB }, dependencies);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(orchestrator.status({ organizationId: 'scope-org-a', projectId: 'native-a' }).inFlight.map((v) => v.identifier), ['ENG-42']);
  assert.deepEqual(orchestrator.status(contextB).inFlight.map((v) => v.identifier), ['ENG-42']);
  assert.deepEqual(orchestrator.status({ orgId: 'scope-org-a', nativeProjectId: 'native-b' }).inFlight, []);
  assert.equal(jobs.length, 2);
  assert.deepEqual(
    jobs.map((job) => [job.orgId, job.nativeProjectId]).sort(),
    [['scope-org-a', 'native-a'], ['scope-org-b', 'native-b']],
  );

  assert.ok(coderEvents.some(({ coder, context }) =>
    context.organizationId === 'scope-org-a'
      && context.projectId === 'native-a'
      && coder.inFlight.length === 1));
  assert.ok(coderEvents.some(({ coder, context }) =>
    context.organizationId === 'scope-org-b'
      && context.projectId === 'native-b'
      && coder.inFlight.length === 1));
  assert.ok(jobEvents.some((context) => context.organizationId === 'scope-org-a' && context.projectId === 'native-a'));
  assert.ok(jobEvents.some((context) => context.organizationId === 'scope-org-b' && context.projectId === 'native-b'));

  releases.get('scope-org-a')();
  releases.get('scope-org-b')();
  await Promise.all([runA, runB]);
  assert.deepEqual(orchestrator.listInFlight(contextA), []);
  assert.deepEqual(orchestrator.listInFlight(contextB), []);
});

test('availability pauses and readiness deduplication are isolated by exact workspace context', async (t) => {
  const contextA = { orgId: 'pause-org-a', nativeProjectId: 'pause-project-a' };
  const contextB = { orgId: 'pause-org-b', nativeProjectId: 'pause-project-b' };
  t.after(() => {
    orchestrator._test.clearPause('test cleanup', contextA);
    orchestrator._test.clearPause('test cleanup', contextB);
  });

  orchestrator._test.pause('git', new Error('unavailable'), {
    task: { id: 'same-id', identifier: 'A-1', project: { id: 'linear-project' }, ...contextA },
  });
  assert.equal(orchestrator.status(contextA).paused, true);
  assert.equal(orchestrator.status(contextB).paused, false);

  let probes = 0;
  await Promise.all([
    orchestrator._test.cachedReadinessProbe('same-fingerprint', async () => { probes += 1; }, contextA),
    orchestrator._test.cachedReadinessProbe('same-fingerprint', async () => { probes += 1; }, contextA),
    orchestrator._test.cachedReadinessProbe('same-fingerprint', async () => { probes += 1; }, contextB),
  ]);
  assert.equal(probes, 2, 'same-context probes deduplicate while A and B remain independent');
});

test('unscoped autonomous polling is disabled for shared authenticated runtimes only', () => {
  assert.equal(
    orchestrator._test.shouldSkipAutonomousPoll({}, { AUTH: { enabled: true } }),
    true,
  );
  assert.equal(
    orchestrator._test.shouldSkipAutonomousPoll({}, { AUTH: { enabled: false } }),
    false,
    'auth-disabled local mode retains empty-context compatibility',
  );
  assert.equal(
    orchestrator._test.shouldSkipAutonomousPoll(
      { organizationId: 'selected-org', projectId: 'selected-project' },
      { AUTH: { enabled: true } },
    ),
    false,
    'explicitly selected autonomous work remains enabled',
  );
  assert.equal(
    orchestrator._test.shouldSkipAutonomousPoll(
      { organizationId: 'selected-org', projectId: 'selected-project' },
      { AUTH: { enabled: true }, PIPELINE: { orchestratorEnabled: true } },
    ),
    true,
    'the durable orchestrator disables Linear-label auto-discovery even when scoped',
  );
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

/* --------------------------- stacked dependencies ----------------------- */

const { sanitizeBranch } = require('./workspace');

test('dependencyLinks returns all blockers latest-first, including already-Done ones', () => {
  const node = { inverseRelations: { nodes: [
    { type: 'blocks', issue: { identifier: 'ENG-1', createdAt: '2026-01-01T00:00:00Z', state: { type: 'completed' } } },
    { type: 'blocks', issue: { identifier: 'ENG-3', createdAt: '2026-03-01T00:00:00Z', state: { type: 'started' } } },
    { type: 'related', issue: { identifier: 'ENG-9', createdAt: '2026-09-01T00:00:00Z', state: { type: 'started' } } },
  ] } };
  const deps = orchestrator._test.dependencyLinks(node);
  // 'related' is excluded; a completed blocker is still listed (unlike blockers());
  // ordering is newest-created first so the coder stacks on the most recent blocker.
  assert.deepStrictEqual(deps.map((d) => d.identifier), ['ENG-3', 'ENG-1']);
});

test('recordStackLink persists the link and recovers the blocker identifier', () => {
  const links = [];
  const jobStore = { addStackLink: (l) => { links.push(l); return { id: 'stk_x', ...l }; } };
  const task = {
    id: 'i2',
    identifier: 'ENG-2',
    project: { id: 'proj_1', name: 'App' },
    dependencies: [{ identifier: 'ENG-1', createdAt: 'x' }],
  };
  const run = { stackedOn: { branch: sanitizeBranch('ENG-1'), defaultBase: 'main', dependentBranch: sanitizeBranch('ENG-2') } };
  const ctx = { repositoryProvider: 'github', repositoryUrl: 'acme/app' };

  orchestrator._test.recordStackLink(task, run, ctx, jobStore);

  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].dependentBranch, sanitizeBranch('ENG-2'));
  assert.strictEqual(links[0].blockerBranch, sanitizeBranch('ENG-1'));
  assert.strictEqual(links[0].blockerIdentifier, 'ENG-1');
  assert.strictEqual(links[0].defaultBase, 'main');
  assert.strictEqual(links[0].projectId, 'proj_1');
  assert.strictEqual(links[0].repoFullName, 'acme/app');
});

test('recordStackLink is a no-op when the run was not stacked', () => {
  const jobStore = { addStackLink: () => { throw new Error('addStackLink should not be called'); } };
  const result = orchestrator._test.recordStackLink(
    { identifier: 'ENG-2', project: {} },
    { stackedOn: null },
    {},
    jobStore
  );
  assert.strictEqual(result, null);
});
