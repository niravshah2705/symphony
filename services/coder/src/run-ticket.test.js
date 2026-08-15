'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runTicket, runTicketInProcess } = require('./run-ticket');
const orchestrator = require('@ai-fleet/shared/agent/coder-orchestrator');
const { PolicyDeniedError } = require('@ai-fleet/shared/agent/settings-policy');
const { SENTINEL_TOKEN } = require('@ai-fleet/shared/egress');

const loadedIssue = Object.freeze({
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Implement context policy',
  description: '',
  url: 'https://linear.app/issue/ENG-1',
  state: 'Todo',
  labels: [],
});

function baseDependencies(overrides = {}) {
  return {
    getApiKey: () => 'linear-key',
    getSettings: () => ({
      linearApiKey: 'linear-key',
      agentRuntime: 'deepagent',
      workflowPattern: 'sequential',
      langsmithTracing: true,
      langsmithApiKey: 'trace-key',
    }),
    loadIssue: async () => ({ ...loadedIssue }),
    billingStatus: () => ({ blocked: false }),
    publishEvent: () => {},
    ...overrides,
  };
}

test('in-process coder resolves selected scope before model preflight and enforces policy + prefs', async () => {
  const effectivePolicy = {
    models: { effective: ['codex-gpt-5-6-terra'] },
    harness: { effective: ['deepagent'] },
    tools: { effective: ['quality'] },
    skills: { effective: ['commit'] },
  };
  const calls = [];
  const events = [];
  let coderArgs;

  const result = await runTicketInProcess(
    {
      issueId: 'issue-1',
      conversationId: 'conversation-1',
      blocking: true,
      orgId: 'org-1',
      nativeProjectId: 'native-project-1',
    },
    baseDependencies({
      resolvePolicy: async (orgId, projectId) => {
        calls.push(['policy', orgId, projectId]);
        return {
          effectivePolicy,
          prefs: {
            agentRuntime: 'claude-agent-sdk',
            workflowPattern: 'supervisor',
            langsmithTracing: 'false',
          },
        };
      },
      resolveLlm: async (_settings, role) => {
        calls.push(['model', role]);
        return { provider: 'codex', model: 'gpt-5.6-sol', accessToken: 'token', baseUrl: 'https://example.test' };
      },
      preflightAndPause: async (_issue, resolveRole) => {
        calls.push(['preflight']);
        return {
          llm: await resolveRole('execution'),
          role: 'execution',
          selection: { provider: 'github' },
        };
      },
      runCoder: async (args) => {
        coderArgs = args;
        args.onStep('Coding with selected scope.');
        return { finalText: 'complete' };
      },
      publishEvent: (conversationId, event, context) => events.push({ conversationId, event, context }),
    }),
  );

  assert.deepEqual(calls[0], ['policy', 'org-1', 'native-project-1']);
  assert.equal(calls[1][0], 'preflight');
  assert.deepEqual(calls[2], ['model', 'execution']);
  assert.equal(result.model, 'gpt-5.6-terra');
  assert.equal(coderArgs.llm.model, 'gpt-5.6-terra');
  assert.equal(coderArgs.issue.orgId, 'org-1');
  assert.equal(coderArgs.issue.nativeProjectId, 'native-project-1');
  assert.equal(coderArgs.keys.agentRuntime, 'claude-agent-sdk');
  assert.equal(coderArgs.keys.workflowPattern, 'supervisor');
  assert.equal(coderArgs.keys.langsmithTracing, false);
  assert.equal(coderArgs.apiKey, 'linear-key');
  assert.equal(coderArgs.keys.linearApiKey, 'linear-key');
  assert.deepEqual(coderArgs.settings, {
    effectivePolicy,
    orgId: 'org-1',
    nativeProjectId: 'native-project-1',
  });
  assert.ok(events.length >= 2);
  for (const emitted of events) {
    assert.equal(emitted.conversationId, 'conversation-1');
    assert.deepEqual(emitted.context, { organizationId: 'org-1', projectId: 'native-project-1' });
  }
});

test('proxy-vault coder needs no stored Linear key and passes only the sentinel to Linear callers', async () => {
  const linearKeys = [];
  let coderArgs;

  await runTicketInProcess(
    {
      issueId: 'issue-1',
      blocking: true,
      orgId: 'org-proxy-vault',
      nativeProjectId: 'project-proxy-vault',
    },
    baseDependencies({
      getSettings: () => ({
        linearApiKey: '',
        agentRuntime: 'deepagent',
        workflowPattern: 'sequential',
      }),
      getApiKey: () => SENTINEL_TOKEN,
      loadIssue: async (_settings, _issueId, apiKey) => {
        linearKeys.push(apiKey);
        return { ...loadedIssue };
      },
      resolvePolicy: async () => ({
        effectivePolicy: { harness: { effective: ['deepagent'] } },
        prefs: {},
      }),
      resolveLlm: async () => ({ provider: 'codex', model: 'gpt-5.6-terra' }),
      preflightAndPause: async (_issue, resolveRole) => ({
        llm: await resolveRole('execution'),
        role: 'execution',
        selection: { provider: 'github' },
      }),
      runCoder: async (args) => {
        coderArgs = args;
        return { finalText: 'complete' };
      },
    }),
  );

  assert.deepEqual(linearKeys, [SENTINEL_TOKEN]);
  assert.equal(coderArgs.apiKey, SENTINEL_TOKEN);
  assert.equal(coderArgs.keys.linearApiKey, SENTINEL_TOKEN);
});

test('legacy empty-context coder remains allow-all when policy resolution is unavailable', async () => {
  let coderArgs;
  const result = await runTicketInProcess(
    { issueId: 'issue-1', blocking: true },
    baseDependencies({
      resolvePolicy: async () => { throw new Error('settings unavailable'); },
      resolveLlm: async () => ({ provider: 'codex', model: 'custom-model' }),
      preflightAndPause: async (_issue, resolveRole) => ({
        llm: await resolveRole('execution'),
        role: 'execution',
        selection: { provider: 'github' },
      }),
      runCoder: async (args) => { coderArgs = args; return { finalText: 'complete' }; },
    }),
  );

  assert.equal(result.model, 'custom-model');
  assert.equal(coderArgs.llm.model, 'custom-model');
  assert.equal(coderArgs.keys.agentRuntime, 'deepagent');
  assert.equal(coderArgs.settings.effectivePolicy, null);
});

test('selected-organization coder fails closed when policy resolution is unavailable', async () => {
  let ran = false;
  await assert.rejects(
    runTicketInProcess(
      { issueId: 'issue-1', blocking: true, orgId: 'org-1', nativeProjectId: 'native-project-1' },
      baseDependencies({
        resolvePolicy: async () => { throw new Error('private settings transport failure'); },
        resolveLlm: async () => ({ provider: 'codex', model: 'gpt-5.6-terra' }),
        runCoder: async () => { ran = true; },
      }),
    ),
    (error) => error.code === 'policy_unavailable'
      && error.status === 503
      && !/private settings transport failure/.test(error.message),
  );
  assert.equal(ran, false);
});

test('selected-organization coder fails closed when resolver returns no effective policy', async () => {
  for (const response of [null, {}, { effectivePolicy: null, prefs: {} }]) {
    let modelResolved = false;
    let ran = false;
    await assert.rejects(
      runTicketInProcess(
        { issueId: 'issue-1', blocking: true, orgId: 'org-missing-policy', nativeProjectId: 'native-missing-policy' },
        baseDependencies({
          resolvePolicy: async () => response,
          resolveLlm: async () => {
            modelResolved = true;
            return { provider: 'codex', model: 'gpt-5.6-terra' };
          },
          runCoder: async () => { ran = true; },
        }),
      ),
      (error) => error.code === 'policy_unavailable' && error.status === 503,
    );
    assert.equal(modelResolved, false);
    assert.equal(ran, false);
  }
});

test('policy denial remains a typed 403 instead of becoming a model pause', async () => {
  let ran = false;
  await assert.rejects(
    runTicketInProcess(
      { issueId: 'issue-1', blocking: true, orgId: 'org-1', nativeProjectId: 'native-project-1' },
      baseDependencies({
        resolvePolicy: async () => ({
          effectivePolicy: { models: { effective: ['codex-gpt-5-6-terra'] } },
          prefs: {},
        }),
        resolveLlm: async () => ({ provider: 'codex', model: 'private-custom-model' }),
        preflightAndPause: async (_issue, resolveRole) => ({
          llm: await resolveRole('execution'),
          role: 'execution',
          selection: { provider: 'github' },
        }),
        runCoder: async () => { ran = true; },
      }),
    ),
    (error) => error.code === 'policy_denied'
      && error.status === 403
      && error.domain === 'model',
  );
  assert.equal(ran, false);
});

test('runtime policy denial remains typed and does not create a model pause', async (t) => {
  const context = { orgId: 'org-runtime-denied', nativeProjectId: 'native-runtime-denied' };
  orchestrator._test.clearPause('test setup', context);
  t.after(() => orchestrator._test.clearPause('test cleanup', context));

  await assert.rejects(
    runTicketInProcess(
      { issueId: 'issue-1', blocking: true, ...context },
      baseDependencies({
        resolvePolicy: async () => ({
          effectivePolicy: { harness: { effective: ['deepagent'] } },
          prefs: {},
        }),
        resolveLlm: async () => ({ provider: 'codex', model: 'gpt-5.6-terra' }),
        preflightAndPause: async (_issue, resolveRole) => ({
          llm: await resolveRole('execution'),
          role: 'execution',
          selection: { provider: 'github' },
        }),
        runCoder: async () => {
          throw new PolicyDeniedError('harness', 'claude-agent-sdk');
        },
      }),
    ),
    (error) => error.code === 'policy_denied'
      && error.status === 403
      && error.domain === 'harness',
  );

  assert.equal(orchestrator.status(context).paused, false);
  assert.equal(orchestrator.status(context).pauseReason, null);
});

test('cloud coder job receives selected context and emits on the same scoped channel', async () => {
  let jobRequest;
  const events = [];
  const result = await runTicket(
    {
      issueId: 'issue-1',
      conversationId: 'conversation-1',
      orgId: 'org-1',
      nativeProjectId: 'native-project-1',
    },
    baseDependencies({
      jobs: {
        isCloudJobEnabled: () => true,
        runCoderJob: async (request) => { jobRequest = request; return { execution: 'execution-1' }; },
      },
      publishEvent: (conversationId, event, context) => events.push({ conversationId, event, context }),
    }),
  );

  assert.equal(result.execution, 'execution-1');
  assert.deepEqual(jobRequest.env, {
    CONVERSATION_ID: 'conversation-1',
    FLEET_ORG_ID: 'org-1',
    AI_FLEET_PROJECT_CONTEXT: 'native-project-1',
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].context, { organizationId: 'org-1', projectId: 'native-project-1' });
});
