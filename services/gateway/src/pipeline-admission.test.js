'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_PIPELINE_REQUEST_BYTES,
  ORCHESTRATOR_RUNS_PATH,
  SETTINGS_PREFLIGHT_PATH,
  assertCredentialBackend,
  assertCredentialRouting,
  assertStageCommandTransportBudget,
  createPipelineAdmission,
  localPreflightDecision,
  localRepositorySnapshot,
  requestedStages,
} = require('./pipeline-admission');
const { createPipelineStart } = require('@ai-fleet/shared-core/pipeline/contracts');
const { createCompatibilityHandlers } = require('./publish');
const { createPipelineRouter } = require('./routes/pipeline');

const CLOCK = '2026-08-13T10:00:00.000Z';
const WORKFLOWS = Object.freeze({
  plan: 'planning',
  code: 'coding',
  test: 'testing',
  deploy: 'deployment',
});
const TEST_SETTINGS = Object.freeze({
  llmProvider: 'ollama',
  thinkingLlmProvider: 'ollama',
  executionLlmProvider: 'ollama',
  testingLlmProvider: 'ollama',
  deploymentLlmProvider: 'ollama',
  ollamaModel: 'gpt-oss:20b',
  agentRuntime: 'deepagent',
});

function request(body = {}, overrides = {}) {
  return {
    body,
    fleetContext: { organizationId: 'org-1', projectId: 'project-1' },
    auth: {
      mode: 'firebase',
      authenticated: true,
      user: { sub: 'user-1', email: 'operator@example.com' },
    },
    headers: { authorization: 'Bearer user-token' },
    get(name) { return this.headers[String(name).toLowerCase()] || ''; },
    ...overrides,
  };
}

function readyDecision(stages, overrides = {}) {
  const providers = overrides.providers || {};
  const models = overrides.models || {};
  const credentialKinds = {
    codex: 'codexTokenBundle',
    claude: 'anthropicApiKey',
    antigravity: 'geminiApiKey',
    huggingface: 'huggingfaceApiKey',
  };
  return {
    schema_version: 1,
    decision_id: 'decision-123',
    project_id: 'project-1',
    ready: true,
    prefs: { agentRuntime: 'deepagent', llmProvider: 'ollama' },
    locks: ['agentRuntime'],
    domains: {
      harness: ['deepagent'],
      tools: [],
      skills: [],
      plugins: [],
      hooks: [],
      models: ['ollama-gpt-oss-20b'],
    },
    stages: stages.map((stage) => {
      const provider = providers[stage] || 'ollama';
      return {
      stage,
      workflow: WORKFLOWS[stage],
      harness: 'deepagent',
      provider,
      model: models[stage] || 'ollama-gpt-oss-20b',
      allowed: true,
      available: true,
      supported: true,
      brokered: true,
      credential: {
        ready: true,
        source: null,
        ...(credentialKinds[provider] ? { kind: credentialKinds[provider] } : {}),
      },
      errors: [],
      };
    }),
    ...overrides,
  };
}

function successfulService(calls, stages = ['plan']) {
  return async (baseUrl, path, options = {}) => {
    calls.push({ baseUrl, path, options });
    if (path === SETTINGS_PREFLIGHT_PATH) {
      return {
        status: 200,
        data: readyDecision(options.body.stages || stages, {
          providers: options.body.providers,
          models: options.body.models,
        }),
      };
    }
    if (path === ORCHESTRATOR_RUNS_PATH && options.method === 'POST') {
      return {
        status: 202,
        data: {
          run: { runId: options.body.runId, status: 'waiting' },
          stages: [{ commandId: `${options.body.runId}:${options.body.requestedStages[0]}:1` }],
        },
      };
    }
    throw new Error(`Unexpected service call: ${path}`);
  };
}

function admission(overrides = {}) {
  const calls = overrides.calls || [];
  return {
    calls,
    value: createPipelineAdmission({
      serviceCall: overrides.serviceCall || successfulService(calls),
      getBillingStatus: overrides.getBillingStatus || ((context) => ({
        blocked: false,
        orgId: context.orgId,
        balancePaise: 50000,
      })),
      addConversation: overrides.addConversation || (() => ({ id: 'conversation-1' })),
      idFactory: overrides.idFactory || (() => 'run-1'),
      clock: () => CLOCK,
      settingsUrl: 'http://settings.internal',
      orchestratorUrl: 'http://orchestrator.internal',
      orchestratorEnabled: overrides.orchestratorEnabled !== false,
      deploymentEnabled: overrides.deploymentEnabled === true,
      pinnedOrganizationId: overrides.pinnedOrganizationId || '',
      getSettings: overrides.getSettings || (() => TEST_SETTINGS),
      resolveRepository: overrides.resolveRepository || (() => ({
        provider: 'github',
        owner: 'acme',
        name: 'fleet',
        fullName: 'acme/fleet',
        url: 'https://github.com/acme/fleet.git',
      })),
    }),
  };
}

test('requested stages are explicit, ordered, unique, and deploy requires the exact full pipeline', () => {
  assert.deepEqual(requestedStages(['plan', 'code', 'test']), ['plan', 'code', 'test']);
  assert.throws(() => requestedStages(undefined), /explicitly contain/);
  assert.throws(() => requestedStages(['code', 'plan']), /canonical order/);
  assert.throws(() => requestedStages(['plan', 'plan']), /duplicate/);
  assert.throws(() => requestedStages(['plan', 'test']), /earlier code stage/);
  assert.throws(() => requestedStages(['plan', 'test', 'deploy']), /earlier code stage|exact full sequence/);
  assert.deepEqual(
    requestedStages(['plan', 'code', 'test', 'deploy']),
    ['plan', 'code', 'test', 'deploy'],
  );
});

test('deploy is fail-fast disabled by default and injectable only for the exact full sequence', async () => {
  let billingCalls = 0;
  const disabled = admission({
    getBillingStatus: () => { billingCalls += 1; return { blocked: false }; },
  });
  await assert.rejects(
    () => disabled.value.submit(request({ requestedStages: ['plan', 'code', 'test', 'deploy'] })),
    (error) => error.status === 403 && error.code === 'pipeline_deployment_disabled',
  );
  assert.equal(billingCalls, 0);
  assert.equal(disabled.calls.length, 0);

  const enabled = admission({ deploymentEnabled: true });
  const accepted = await enabled.value.submit(request({
    requestedStages: ['plan', 'code', 'test', 'deploy'],
    request: { workItem: { id: 'ENG-42' }, deployment: { environment: 'production' } },
  }));
  assert.deepEqual(accepted.requestedStages, ['plan', 'code', 'test', 'deploy']);
  assert.equal(enabled.calls.at(-1).path, ORCHESTRATOR_RUNS_PATH);
});

test('canonical pipeline control is a typed 503 while the rollout switch is off', async () => {
  const disabled = admission({ orchestratorEnabled: false });
  await assert.rejects(
    () => disabled.value.submit(request({ requestedStages: ['plan'] })),
    (error) => error.status === 503 && error.code === 'pipeline_orchestrator_disabled',
  );
  await assert.rejects(
    () => disabled.value.status(request(), 'run-1'),
    (error) => error.status === 503 && error.code === 'pipeline_orchestrator_disabled',
  );
  assert.equal(disabled.calls.length, 0);
});

test('settings preflight outage and non-ready decisions fail closed without orchestrator dispatch', async () => {
  const outageCalls = [];
  const outage = admission({
    calls: outageCalls,
    serviceCall: async (baseUrl, path, options) => {
      outageCalls.push({ baseUrl, path, options });
      throw new Error('offline');
    },
  });
  await assert.rejects(
    () => outage.value.submit(request({ requestedStages: ['plan'] })),
    (error) => error.status === 503 && error.code === 'pipeline_preflight_unavailable',
  );
  assert.deepEqual(outageCalls.map((entry) => entry.path), [SETTINGS_PREFLIGHT_PATH]);

  const denialCalls = [];
  const deniedDecision = readyDecision(['code'], {
    ready: false,
    stages: [{
      ...readyDecision(['code']).stages[0],
      credential: { ready: false, source: null },
      errors: ['provider_credential_unavailable'],
    }],
  });
  const denied = admission({
    calls: denialCalls,
    serviceCall: async (baseUrl, path, options) => {
      denialCalls.push({ baseUrl, path, options });
      return { status: 200, data: deniedDecision };
    },
  });
  await assert.rejects(
    () => denied.value.submit(request({ requestedStages: ['code'] })),
    (error) => error.status === 409
      && error.code === 'pipeline_preflight_not_ready'
      && error.details.stages[0].errors[0] === 'provider_credential_unavailable',
  );
  assert.deepEqual(denialCalls.map((entry) => entry.path), [SETTINGS_PREFLIGHT_PATH]);
});

test('malformed preflight and mismatched dispatch acknowledgements fail closed', async () => {
  const invalidPreflight = admission({
    serviceCall: async () => ({
      status: 200,
      data: readyDecision(['plan'], { decision_id: '', stages: [{
        ...readyDecision(['plan']).stages[0],
        workflow: 'coding',
      }] }),
    }),
  });
  await assert.rejects(
    () => invalidPreflight.value.submit(request({ requestedStages: ['plan'] })),
    (error) => error.status === 503 && error.code === 'pipeline_preflight_invalid',
  );

  const wrongRun = admission({
    serviceCall: async (baseUrl, path, options) => path === SETTINGS_PREFLIGHT_PATH
      ? { status: 200, data: readyDecision(options.body.stages) }
      : { status: 202, data: { run: { runId: 'another-run', status: 'waiting' }, stages: [] } },
  });
  await assert.rejects(
    () => wrongRun.value.submit(request({ requestedStages: ['plan'] })),
    (error) => error.status === 502 && error.code === 'pipeline_dispatch_invalid_response',
  );
});

test('the SDK-free billing gate uses authoritative tenant scope and blocks before external admission', async () => {
  const seen = [];
  const blocked = admission({
    getBillingStatus: (context) => {
      seen.push(context);
      return { blocked: true, orgId: context.orgId, balancePaise: -1, reason: 'Credits exhausted.' };
    },
  });
  await assert.rejects(
    () => blocked.value.submit(request({ requestedStages: ['plan'] })),
    (error) => error.status === 402
      && error.code === 'billing_blocked'
      && error.details.orgId === 'org-1',
  );
  assert.deepEqual(seen, [{ orgId: 'org-1', projectId: 'project-1' }]);
  assert.equal(blocked.calls.length, 0);
});

test('admission forwards user auth and authoritative scope, then dispatches only a normalized secret-free snapshot', async () => {
  const context = { organizationId: 'org-tenant', projectId: 'project-tenant' };
  const calls = [];
  const value = createPipelineAdmission({
    serviceCall: async (baseUrl, path, options) => {
      calls.push({ baseUrl, path, options });
      if (path === SETTINGS_PREFLIGHT_PATH) {
        return {
          status: 200,
          data: {
            ...readyDecision(['plan', 'code']),
            project_id: context.projectId,
            stages: readyDecision(['plan', 'code']).stages.map((stage, index) => ({
              ...stage,
              credential: { ready: true, source: index ? 'customer' : 'managed' },
            })),
          },
        };
      }
      return {
        status: 202,
        data: {
          run: { runId: options.body.runId, status: 'waiting' },
          stages: [{ commandId: `${options.body.runId}:plan:1` }],
        },
      };
    },
    getBillingStatus: (scope) => ({ blocked: false, orgId: scope.orgId, balancePaise: 1 }),
    addConversation: () => ({ id: 'conversation-tenant' }),
    idFactory: () => 'run-tenant',
    clock: () => CLOCK,
    settingsUrl: 'http://settings.internal',
    orchestratorUrl: 'http://orchestrator.internal',
    orchestratorEnabled: true,
    pinnedOrganizationId: context.organizationId,
    getSettings: () => TEST_SETTINGS,
    resolveRepository: () => ({
      provider: 'github',
      owner: 'trusted',
      name: 'fleet',
      fullName: 'trusted/fleet',
      url: 'https://github.com/trusted/fleet.git',
    }),
  });

  const accepted = await value.submit(request({
    requestedStages: ['plan', 'code'],
    harnesses: { plan: 'deepagent' },
    request: {
      repository: { provider: 'github', owner: 'acme', name: 'fleet' },
      workItem: { id: 'ENG-42' },
    },
  }, { fleetContext: context }));

  const settingsCall = calls[0];
  assert.equal(settingsCall.baseUrl, 'http://settings.internal');
  assert.equal(settingsCall.path, SETTINGS_PREFLIGHT_PATH);
  assert.equal(settingsCall.options.userAuth, 'Bearer user-token');
  assert.deepEqual(settingsCall.options.context, context);
  assert.deepEqual(settingsCall.options.body, {
    project_id: context.projectId,
    stages: ['plan', 'code'],
    harnesses: { plan: 'deepagent' },
    providers: { plan: 'ollama', code: 'ollama' },
    models: { plan: 'ollama-gpt-oss-20b', code: 'ollama-gpt-oss-20b' },
  });

  const dispatch = calls[1];
  assert.equal(dispatch.baseUrl, 'http://orchestrator.internal');
  assert.equal(dispatch.path, ORCHESTRATOR_RUNS_PATH);
  assert.deepEqual(dispatch.options.context, context);
  const start = dispatch.options.body;
  assert.equal(start.organizationId, context.organizationId);
  assert.equal(start.projectId, context.projectId);
  assert.equal(start.requestedBy, 'user-1');
  assert.equal(start.metadata.initiatingUserId, 'user-1');
  assert.equal(start.metadata.conversationId, 'conversation-tenant');
  assert.equal(start.request.conversationId, 'conversation-tenant');
  assert.equal(start.request.policy.decisionId, 'decision-123');
  assert.equal(start.request.policy.stages[0].providerReady, true);
  assert.equal(start.request.policy.stages[0].providerSource, 'managed');
  assert.deepEqual(start.request.policy.effectivePolicy.models.effective, ['ollama-gpt-oss-20b']);
  assert.deepEqual(start.request.repository, {
    provider: 'github',
    owner: 'trusted',
    name: 'fleet',
    fullName: 'trusted/fleet',
    url: 'https://github.com/trusted/fleet.git',
  });
  assert.deepEqual(start.request.stageConfiguration, {
    plan: {
      harness: 'deepagent', provider: 'ollama', model: 'gpt-oss:20b', modelId: 'ollama-gpt-oss-20b',
      providerReady: true, brokered: true,
    },
    code: {
      harness: 'deepagent', provider: 'ollama', model: 'gpt-oss:20b', modelId: 'ollama-gpt-oss-20b',
      providerReady: true, brokered: true,
    },
  });
  assert.equal(start.metadata.preflightDecisionId, 'decision-123');
  assert.doesNotMatch(JSON.stringify(start), /"credential"|user-token|authorization/i);
  assert.deepEqual(accepted, {
    accepted: true,
    runId: 'run-tenant',
    conversationId: 'conversation-tenant',
    stageIds: ['run-tenant:plan:1'],
    requestedStages: ['plan', 'code'],
    status: 'waiting',
  });
});

test('deploy admission requires an explicit bounded environment and strips caller approval', async () => {
  const context = admission({ deploymentEnabled: true });
  await assert.rejects(
    () => context.value.submit(request({
      requestedStages: ['plan', 'code', 'test', 'deploy'],
      request: { deployment: {} },
    })),
    (error) => error.code === 'pipeline_deployment_environment_invalid',
  );

  await context.value.submit(request({
    requestedStages: ['plan', 'code', 'test', 'deploy'],
    request: {
      deployment: {
        environment: 'Production',
        approval: { approved: true, source: 'caller' },
      },
    },
  }));
  const start = context.calls.at(-1).options.body;
  assert.equal(start.request.stageConfiguration.deploy.enabled, true);
  assert.equal(start.request.stageConfiguration.deploy.environment, 'production');
  assert.equal(start.request.stageConfiguration.deploy.approval, undefined);
  assert.deepEqual(start.request.deployment, { environment: 'production' });
});

test('repository snapshot is server-derived, project-aware, and rejects unbrokered providers', () => {
  const business = {
    projectId: 'linear-project',
    repoProvider: 'github',
    repo: 'trusted/project-repo',
  };
  assert.deepEqual(localRepositorySnapshot(
    {
      projectId: 'linear-project',
      repository: { provider: 'github', fullName: 'attacker/repo' },
    },
    ['plan', 'code'],
    {
      getBusinessByProjectId: (id) => id === business.projectId ? business : null,
      getRepositoryConfig: () => ({ provider: 'github', url: 'fallback/repo', token: 'never-copy' }),
      configuredRepositoryUrl: '',
    },
  ), {
    provider: 'github',
    owner: 'trusted',
    name: 'project-repo',
    fullName: 'trusted/project-repo',
    url: 'https://github.com/trusted/project-repo.git',
  });

  assert.throws(() => localRepositorySnapshot(
    {},
    ['code'],
    {
      getBusinessByProjectId: () => null,
      getRepositoryConfig: () => ({ provider: 'gitlab', url: 'group/repo', token: 'never-copy' }),
      configuredRepositoryUrl: '',
    },
  ), (error) => error.code === 'pipeline_repository_provider_not_brokered');

  assert.throws(() => localRepositorySnapshot(
    {},
    ['test'],
    {
      getBusinessByProjectId: () => null,
      getRepositoryConfig: () => ({ provider: 'github', url: '', token: 'never-copy' }),
      configuredRepositoryUrl: '',
    },
  ), (error) => error.code === 'pipeline_repository_not_configured');

  assert.deepEqual(localRepositorySnapshot(
    {},
    ['plan'],
    {
      getBusinessByProjectId: () => null,
      getRepositoryConfig: () => ({ provider: 'github', url: '', token: 'never-copy' }),
      configuredRepositoryUrl: '',
    },
  ), {});
});

test('canonical input rejects nested secret-bearing fields before preflight or dispatch', async () => {
  const context = admission();
  await assert.rejects(
    () => context.value.submit(request({
      requestedStages: ['plan'],
      request: { repository: { apiKey: 'must-not-cross' } },
    })),
    (error) => error.status === 400 && /secret-bearing field/.test(error.message),
  );
  assert.equal(context.calls.length, 0);

  await assert.rejects(
    () => context.value.submit(request({
      requestedStages: ['plan'],
      request: { payload: 'x'.repeat(MAX_PIPELINE_REQUEST_BYTES) },
    })),
    (error) => error.status === 413 && error.code === 'pipeline_request_too_large',
  );
  assert.equal(context.calls.length, 0);
});

test('customer credentials fail closed on the shared stack and are allowed only on the matching pinned org', () => {
  const decision = {
    stages: [{ stage: 'plan', providerSource: 'customer' }],
  };
  const context = { organizationId: 'org-1', projectId: 'project-1' };
  assert.throws(
    () => assertCredentialRouting(decision, context, ''),
    (error) => error.status === 409
      && error.code === 'pipeline_customer_credential_requires_dedicated_stack',
  );
  assert.throws(
    () => assertCredentialRouting(decision, context, 'org-2'),
    (error) => error.code === 'pipeline_customer_credential_requires_dedicated_stack',
  );
  assert.doesNotThrow(() => assertCredentialRouting(decision, context, 'org-1'));
  assert.doesNotThrow(() => assertCredentialRouting({
    stages: [{ stage: 'plan', providerSource: 'managed' }],
  }, context, ''));
});

test('Codex credential kind must match the configured proxy backend', () => {
  const apiKeyDecision = {
    stages: [{ stage: 'code', provider: 'codex', providerAuthKind: 'openaiApiKey' }],
  };
  assert.throws(
    () => assertCredentialBackend(apiKeyDecision, 'chatgpt'),
    (error) => error.status === 409
      && error.code === 'pipeline_provider_credential_backend_mismatch',
  );
  assert.doesNotThrow(() => assertCredentialBackend(apiKeyDecision, 'api'));
  assert.doesNotThrow(() => assertCredentialBackend({
    stages: [{ stage: 'code', provider: 'codex', providerAuthKind: 'codexTokenBundle' }],
  }, 'chatgpt'));
});

test('gateway reserves transport space for maximum prior results before dispatch', () => {
  const base = {
    runId: 'transport-budget-run',
    organizationId: 'org-1',
    projectId: 'project-1',
    requestedStages: ['plan', 'code', 'test', 'deploy'],
    requestedBy: 'user-1',
    correlationId: 'conversation-1',
  };
  const admitted = createPipelineStart({
    ...base,
    request: {
      policy: { serverGenerated: 'x'.repeat(40 * 1024) },
      repository: { provider: 'github', fullName: 'acme/fleet' },
      stageConfiguration: { plan: {}, code: {}, test: {}, deploy: { enabled: true, environment: 'test' } },
    },
  }, { clock: () => CLOCK });
  assert.doesNotThrow(() => assertStageCommandTransportBudget(admitted));

  const unsafe = createPipelineStart({
    ...base,
    request: {
      ...admitted.request,
      policy: { serverGenerated: 'x'.repeat(90 * 1024) },
    },
  }, { clock: () => CLOCK });
  assert.throws(
    () => assertStageCommandTransportBudget(unsafe),
    (error) => error.status === 413 && error.code === 'pipeline_stage_command_too_large',
  );
});

test('SDK-free local preflight enforces catalog availability, broker support, and provider readiness', () => {
  const ready = localPreflightDecision(['plan', 'code'], {}, {
    settings: { agentRuntime: 'deepagent', llmProvider: 'ollama' },
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.stages[0].provider, 'ollama');
  assert.equal(ready.stages[1].brokered, true);
  assert.ok(ready.domains.tools.includes('quality'));
  assert.ok(ready.domains.tools.includes('playwright'));
  assert.ok(ready.domains.models.includes('ollama-gpt-oss-20b'));
  assert.equal(JSON.stringify(ready).includes('apiKey'), false);

  const unsupported = localPreflightDecision(['code'], { code: 'codex-sdk' }, {
    settings: { agentRuntime: 'deepagent', llmProvider: 'ollama', codexTokens: { accessToken: 'hidden' } },
  });
  assert.equal(unsupported.ready, false);
  assert.ok(unsupported.stages[0].errors.includes('brokered_stage_unsupported'));

  const missingProvider = localPreflightDecision(['plan'], { plan: 'claude-agent-sdk' }, {
    settings: {
      agentRuntime: 'deepagent',
      llmProvider: 'ollama',
      thinkingLlmProvider: 'claude',
      claudeModel: 'claude-opus-4-8',
      claudeTokens: null,
      anthropicApiKey: '',
    },
  });
  assert.equal(missingProvider.ready, false);
  assert.ok(missingProvider.stages[0].errors.includes('provider_credential_unavailable'));
});

test('auth-disabled local starts use SDK-free local preflight and stable nonempty scope', async () => {
  const calls = [];
  const value = createPipelineAdmission({
    serviceCall: async (baseUrl, path, options) => {
      calls.push({ baseUrl, path, options });
      return { status: 202, data: { run: { runId: options.body.runId, status: 'waiting' }, stages: [] } };
    },
    getBillingStatus: () => ({ blocked: false }),
    addConversation: () => ({ id: 'local-conversation' }),
    idFactory: () => 'local-run',
    settingsUrl: 'http://settings.internal',
    orchestratorUrl: 'http://orchestrator.internal',
    orchestratorEnabled: true,
    getSettings: () => TEST_SETTINGS,
    resolveLocalPreflight: () => readyDecision(['plan'], { project_id: null }),
    resolveRepository: () => ({}),
  });
  await value.submit(request(
    { requestedStages: ['plan'] },
    { fleetContext: {}, auth: { mode: 'disabled', authenticated: true, user: null }, headers: {} },
  ));
  assert.equal(calls.length, 1, 'local preflight must not call the auth-gated settings service');
  assert.equal(calls[0].options.body.organizationId, 'local-org');
  assert.equal(calls[0].options.body.projectId, 'local-project');
  assert.equal(calls[0].options.body.requestedBy, 'local-operator');
});

test('status, cancel, and resume proxy only through authoritative orchestrator scope', async () => {
  const calls = [];
  const value = createPipelineAdmission({
    serviceCall: async (baseUrl, path, options = {}) => {
      calls.push({ baseUrl, path, options });
      return {
        status: 200,
        data: {
          run: {
            runId: 'run-1',
            status: path.endsWith('/cancel') ? 'cancelled' : 'waiting',
          },
          stages: [],
        },
      };
    },
    orchestratorUrl: 'http://orchestrator.internal',
    orchestratorEnabled: true,
    internalApiToken: 'gateway-orchestrator-token',
  });
  const req = request({ reason: 'Superseded' });
  assert.equal((await value.status(req, 'run-1')).run.status, 'waiting');
  assert.equal((await value.cancel(req, 'run-1')).run.status, 'cancelled');
  req.body = { retryFailed: true };
  assert.equal((await value.resume(req, 'run-1')).run.status, 'waiting');
  assert.deepEqual(calls.map(({ path }) => path), [
    `${ORCHESTRATOR_RUNS_PATH}/run-1`,
    `${ORCHESTRATOR_RUNS_PATH}/run-1/cancel`,
    `${ORCHESTRATOR_RUNS_PATH}/run-1/resume`,
  ]);
  assert.ok(calls.every((entry) => entry.options.context.organizationId === 'org-1'));
  assert.ok(calls.every((entry) => entry.options.internalToken === 'gateway-orchestrator-token'));
  assert.deepEqual(calls[1].options.body, { requestedBy: 'user-1', reason: 'Superseded' });
  assert.deepEqual(calls[2].options.body, { retryFailed: true });
});

async function invoke(handler, req) {
  const result = { status: 200, body: null, error: null };
  const res = {
    status(value) { result.status = value; return this; },
    json(value) { result.body = value; return this; },
  };
  await handler(req, res, (error) => { result.error = error; });
  if (result.error) throw result.error;
  return result;
}

test('legacy enqueue preserves plan-to-tested automation while coder starts stay code-only', async () => {
  const submitted = [];
  const admissionStub = {
    async submit(req, options) {
      submitted.push({ body: req.body, options });
      return { accepted: true, runId: `run-${submitted.length}`, conversationId: `conversation-${submitted.length}` };
    },
  };
  const handlers = createCompatibilityHandlers({
    admission: admissionStub,
    orchestratorEnabled: true,
    getAssumedRole: () => ({ id: 'role-1' }),
  });
  assert.equal((await invoke(handlers.enqueue, request({ projectId: 'project-a', projectName: 'Alpha' }))).status, 202);
  assert.equal((await invoke(handlers.coderRun, request({ issueId: 'ENG-9' }))).status, 202);
  assert.deepEqual(submitted[0].options.stages, ['plan', 'code', 'test']);
  assert.deepEqual(submitted[0].options.adaptRequest(submitted[0].body), {
    projectId: 'project-a',
    projectName: 'Alpha',
    assumedRole: { id: 'role-1' },
  });
  assert.deepEqual(submitted[1].options.stages, ['code']);
  assert.deepEqual(submitted[1].options.adaptRequest(submitted[1].body), { issueId: 'ENG-9' });
});

test('rollout-off compatibility routes retain legacy planner/coder publishing', async () => {
  const published = [];
  const conversations = [];
  let unexpectedAdmission = 0;
  const handlers = createCompatibilityHandlers({
    orchestratorEnabled: false,
    admission: { async submit() { unexpectedAdmission += 1; } },
    getAssumedRole: () => ({ id: 'role-1', name: 'Engineer' }),
    addConversation: (value) => {
      conversations.push(value);
      return { id: `legacy-conversation-${conversations.length}` };
    },
    publish: async (topic, message) => { published.push({ topic, message }); },
    plannerTopic: 'planner-topic',
    coderTopic: 'coder-topic',
  });
  const planner = await invoke(handlers.enqueue, request({ projectId: 'linear-project', projectName: 'Alpha' }));
  const coder = await invoke(handlers.coderRun, request({ issueId: 'ENG-9' }));
  assert.deepEqual(planner.body, { accepted: true, conversationId: 'legacy-conversation-1' });
  assert.deepEqual(coder.body, { accepted: true, conversationId: 'legacy-conversation-2' });
  assert.equal(unexpectedAdmission, 0);
  assert.deepEqual(published, [
    {
      topic: 'planner-topic',
      message: {
        type: 'enqueue',
        projectId: 'linear-project',
        projectName: 'Alpha',
        assumedRole: { id: 'role-1', name: 'Engineer' },
        conversationId: 'legacy-conversation-1',
        orgId: 'org-1',
        nativeProjectId: 'project-1',
      },
    },
    {
      topic: 'coder-topic',
      message: {
        issueId: 'ENG-9',
        conversationId: 'legacy-conversation-2',
        orgId: 'org-1',
        nativeProjectId: 'project-1',
      },
    },
  ]);

  assert.deepEqual(
    await invoke(handlers.enqueue, request({ projectId: '' })),
    { status: 400, body: { error: 'projectId is required.' }, error: null },
  );
  assert.deepEqual(
    await invoke(handlers.coderRun, request({ issueId: '' })),
    { status: 400, body: { error: 'issueId is required.' }, error: null },
  );
});

test('pipeline router exposes canonical start, status, and cancel routes', () => {
  let eulaGateCalls = 0;
  const router = createPipelineRouter({
    admission: { submit() {}, status() {}, cancel() {}, resume() {} },
    startMiddleware(req, res, next) { eulaGateCalls += 1; next(); },
  });
  const routes = router.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  assert.deepEqual(routes, [
    'POST /runs',
    'GET /runs/:runId',
    'POST /runs/:runId/cancel',
    'POST /runs/:runId/resume',
  ]);
  assert.equal(router.stack[0].route.stack.length, 2, 'start has EULA middleware + admission handler');
  assert.equal(router.stack[1].route.stack.length, 1, 'status remains visible without EULA middleware');
  assert.equal(router.stack[2].route.stack.length, 1, 'cancel is not re-gated by EULA');
  assert.equal(router.stack[3].route.stack.length, 1, 'resume is not re-gated by EULA');
  assert.equal(eulaGateCalls, 0, 'route inspection must not invoke middleware');
});
