'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../store');
const { resolveLlm } = require('./llm');

const {
  AgentRuntimeError,
  normalizeAgentRuntime,
  effectiveAgentRuntime,
  normalizeWorkflowPattern,
  runtimeCatalog,
  plannerWebSearchAllowed,
  workflowPatternCatalog,
  applyWorkflowPattern,
  executeAgentRuntime,
  claudePermissionGuard,
} = require('./runtimes');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function chatgptCodexLlm() {
  return {
    provider: 'codex',
    backend: 'chatgpt',
    model: 'gpt-5-codex',
    accessToken: 'chatgpt-access-secret',
    baseUrl: 'https://chatgpt.example.test/backend-api/codex',
    accountId: 'account-123',
    authTokens: {
      accessToken: 'chatgpt-access-secret',
      refreshToken: 'chatgpt-refresh-secret',
      idToken: 'chatgpt-id-secret',
      obtainedAt: Date.now(),
    },
  };
}

test('runtime and workflow registries use stable canonical ids and aliases', () => {
  assert.deepEqual(runtimeCatalog().map((item) => item.id), ['deepagent', 'codex-sdk', 'claude-agent-sdk', 'antigravity-sdk']);
  assert.deepEqual(workflowPatternCatalog().map((item) => item.id), [
    'sequential',
    'parallel',
    'evaluator',
    'supervisor',
  ]);
  assert.equal(normalizeAgentRuntime(), 'deepagent');
  assert.equal(normalizeWorkflowPattern('parallel-fan-out'), 'parallel');
  assert.equal(normalizeWorkflowPattern('evaluator/retry'), 'evaluator');
  assert.equal(normalizeWorkflowPattern('supervisor-handoff'), 'supervisor');
  assert.throws(
    () => normalizeAgentRuntime('unknown', { strict: true }),
    (error) => error instanceof AgentRuntimeError && error.code === 'invalid_agent_runtime'
  );
});

test('sequential keeps the original task while other patterns add bounded guidance', () => {
  assert.equal(applyWorkflowPattern('Do the work', 'sequential'), 'Do the work');
  const prompt = applyWorkflowPattern('Do the work', 'evaluator');
  assert.match(prompt, /workflow_pattern id="evaluator"/);
  assert.match(prompt, /generator-evaluator loop/);
  assert.match(prompt, /Do the work$/);
});

test('SDK web search is limited to the explicit filesystem planning workflow', () => {
  assert.equal(plannerWebSearchAllowed({ workflow: 'planning', backendKind: 'filesystem' }), true);
  assert.equal(plannerWebSearchAllowed({ workflow: 'coding', backendKind: 'shell' }), false);
  assert.equal(plannerWebSearchAllowed({ workflow: 'planning', backendKind: 'shell' }), false);
});

test('brokered coding stays on DeepAgent even with a matching SDK provider', () => {
  assert.equal(
    effectiveAgentRuntime('codex-sdk', { provider: 'codex' }, { strict: true, workflow: 'coding' }),
    'deepagent'
  );
  assert.equal(
    effectiveAgentRuntime('claude-agent-sdk', { provider: 'claude' }, { strict: true, workflow: 'planning' }),
    'claude-agent-sdk'
  );
});

test('resolveLlm exposes a cloned fresh Codex token set to the runtime descriptor', async (t) => {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' },
  })).toString('base64url');
  const tokens = {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    idToken: `e30.${payload}.signature`,
    expiresAt: Date.now() + 3_600_000,
    obtainedAt: Date.now(),
  };
  const original = store.getCodexTokens;
  store.getCodexTokens = () => tokens;
  t.after(() => { store.getCodexTokens = original; });

  const llm = await resolveLlm({ llmProvider: 'codex', codexModel: 'gpt-test' });

  assert.deepEqual(llm.authTokens, tokens);
  assert.notEqual(llm.authTokens, tokens);
  assert.equal(llm.accessToken, 'access-secret');
});

test('DeepAgent adapter preserves behavior and normalizes usage', async () => {
  let invoked;
  const execution = await executeAgentRuntime({
    runtime: 'deepagent',
    workflowPattern: 'sequential',
    prompt: 'Ship it',
    llm: { provider: 'ollama', model: 'qwen' },
    invokeConfig: { runId: 'ignored-by-test', tags: ['coder'] },
    deepAgentInvoke: async (prompt, config) => {
      invoked = { prompt, config };
      return {
        messages: [{
          role: 'assistant',
          content: 'done',
          usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        }],
      };
    },
    lastText: (result) => result.messages.at(-1).content,
    trace: false,
  });

  assert.equal(invoked.prompt, 'Ship it');
  assert.equal(execution.finalText, 'done');
  assert.equal(execution.runtime, 'deepagent');
  assert.deepEqual(execution.usage, {
    inputTokens: 10,
    outputTokens: 4,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 14,
  });
});

test('Codex SDK API backend uses a constrained thread and reports token usage', async (t) => {
  const root = workspace(t);
  const seen = { run: { metadata: {} } };
  class FakeCodex {
    constructor(options) {
      seen.client = options;
    }
    startThread(options) {
      seen.thread = options;
      return {
        id: 'codex-thread-1',
        run: async (prompt) => {
          seen.prompt = prompt;
          return {
            finalResponse: 'Codex finished',
            items: [],
            usage: {
              input_tokens: 20,
              cached_input_tokens: 3,
              output_tokens: 8,
              reasoning_output_tokens: 2,
            },
          };
        },
      };
    }
  }

  const execution = await executeAgentRuntime({
    runtime: 'codex-sdk',
    workflowPattern: 'parallel',
    prompt: 'Inspect the repository',
    rootDir: root,
    backendKind: 'shell',
    systemPrompt: 'Trusted coding rules',
    llm: {
      provider: 'codex',
      backend: 'api',
      model: 'gpt-5-codex',
      accessToken: 'secret-token',
      baseUrl: 'https://example.test/v1',
      reasoningEffort: 'high',
    },
    loaders: { 'codex-sdk': async () => ({ Codex: FakeCodex }) },
    invokeConfig: { metadata: { issueId: 'ABC-1' }, tags: ['coder'] },
    getCurrentRunTree: () => seen.run,
    traceFactory: (fn, config) => {
      seen.trace = config;
      return fn;
    },
  });

  assert.equal(seen.thread.sandboxMode, 'workspace-write');
  assert.equal(seen.thread.approvalPolicy, 'never');
  assert.equal(seen.thread.networkAccessEnabled, false);
  assert.equal(seen.client.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(seen.client.env.GH_TOKEN, undefined);
  assert.equal(seen.client.apiKey, 'secret-token');
  assert.equal(seen.client.baseUrl, 'https://example.test/v1');
  assert.equal(seen.client.config.allow_login_shell, false);
  assert.equal(seen.client.config.developer_instructions, 'Trusted coding rules');
  assert.equal(seen.client.config.shell_environment_policy.inherit, 'core');
  assert.equal(seen.client.config.shell_environment_policy.ignore_default_excludes, false);
  assert.deepEqual(seen.client.config.shell_environment_policy.exclude, [
    '*TOKEN*',
    '*KEY*',
    '*SECRET*',
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GITLAB_TOKEN',
    'LINEAR_API_KEY',
    'LANGSMITH_API_KEY',
  ]);
  assert.doesNotMatch(seen.prompt, /Trusted coding rules/);
  assert.match(seen.prompt, /workflow_pattern id="parallel"/);
  assert.equal(execution.sessionId, 'codex-thread-1');
  assert.equal(execution.usage.totalTokens, 28);
  assert.equal(execution.usage.cachedInputTokens, 3);
  assert.equal(execution.costUsd, null);
  assert.equal(seen.trace.metadata.agent_runtime, 'codex-sdk');
  assert.equal(seen.trace.metadata.model_provider, 'codex');
  assert.equal(seen.trace.metadata.model_name, 'gpt-5-codex');
  assert.equal(seen.trace.metadata.ls_provider, 'openai');
  assert.equal(seen.trace.metadata.ls_model_name, 'gpt-5-codex');
  assert.equal(seen.trace.run_type, 'llm');
  assert.equal(seen.trace.metadata.issueId, 'ABC-1');
  // Harness + model surface both as trace metadata and as flat tags.
  assert.equal(seen.trace.metadata.harness, 'codex');
  assert.ok(seen.trace.tags.includes('harness:codex'));
  assert.ok(seen.trace.tags.includes('model:gpt-5-codex'));
  assert.ok(seen.trace.tags.includes('runtime:codex-sdk'));
  assert.ok(seen.trace.tags.includes('pattern:parallel'));
  assert.ok(seen.trace.tags.includes('coder')); // caller-supplied tag preserved
  assert.equal(seen.run.metadata.usage_input_tokens, 20);
  assert.equal(seen.run.metadata.usage_output_tokens, 8);
  assert.deepEqual(seen.run.metadata.usage_metadata, {
    input_tokens: 20,
    output_tokens: 8,
    total_tokens: 28,
  });
  assert.equal(seen.run.metadata.cost_available, false);
  assert.equal(Object.hasOwn(seen.run.metadata, 'cost_usd'), false);
});

test('Codex SDK ChatGPT backend uses an isolated official auth file and removes it', async (t) => {
  const root = workspace(t);
  const seen = {};
  class FakeCodex {
    constructor(options) {
      seen.client = options;
      seen.home = options.env.HOME;
      seen.authFile = path.join(seen.home, '.codex', 'auth.json');
      seen.auth = JSON.parse(fs.readFileSync(seen.authFile, 'utf8'));
      seen.homeMode = fs.statSync(seen.home).mode & 0o777;
      seen.codexHomeMode = fs.statSync(path.dirname(seen.authFile)).mode & 0o777;
      seen.authMode = fs.statSync(seen.authFile).mode & 0o777;
    }
    startThread() {
      return {
        id: 'chatgpt-thread',
        run: async () => {
          seen.authExistedDuringRun = fs.existsSync(seen.authFile);
          return { finalResponse: 'done', usage: null };
        },
      };
    }
  }

  const execution = await executeAgentRuntime({
    runtime: 'codex-sdk',
    prompt: 'Use ChatGPT auth',
    rootDir: root,
    llm: chatgptCodexLlm(),
    loaders: { 'codex-sdk': async () => ({ Codex: FakeCodex }) },
    trace: false,
  });

  assert.equal(Object.hasOwn(seen.client, 'apiKey'), false);
  assert.equal(Object.hasOwn(seen.client, 'baseUrl'), false);
  assert.equal(seen.client.config.cli_auth_credentials_store, 'file');
  assert.equal(seen.client.config.forced_login_method, 'chatgpt');
  assert.equal(seen.client.config.history.persistence, 'none');
  assert.equal(seen.client.env.CODEX_HOME, path.join(seen.home, '.codex'));
  assert.equal(seen.authExistedDuringRun, true);
  assert.deepEqual(seen.auth, {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'chatgpt-id-secret',
      access_token: 'chatgpt-access-secret',
      refresh_token: '',
      account_id: 'account-123',
    },
    last_refresh: seen.auth.last_refresh,
  });
  assert.equal(JSON.stringify(seen.auth).includes('chatgpt-refresh-secret'), false);
  assert.equal(Number.isNaN(Date.parse(seen.auth.last_refresh)), false);
  if (process.platform !== 'win32') {
    assert.equal(seen.homeMode, 0o700);
    assert.equal(seen.codexHomeMode, 0o700);
    assert.equal(seen.authMode, 0o600);
  }
  assert.equal(execution.sessionId, 'chatgpt-thread');
  assert.equal(fs.existsSync(seen.authFile), false);
  assert.equal(fs.existsSync(seen.home), false);
});

test('Codex SDK removes isolated ChatGPT auth when execution fails', async (t) => {
  const root = workspace(t);
  let home;
  class FailingCodex {
    constructor(options) {
      home = options.env.HOME;
    }
    startThread() {
      return { run: async () => { throw new Error('simulated SDK failure'); } };
    }
  }

  await assert.rejects(
    executeAgentRuntime({
      runtime: 'codex-sdk',
      prompt: 'fail safely',
      rootDir: root,
      llm: chatgptCodexLlm(),
      loaders: { 'codex-sdk': async () => ({ Codex: FailingCodex }) },
      trace: false,
    }),
    (error) => error.code === 'runtime_execution_failed'
  );
  assert.ok(home);
  assert.equal(fs.existsSync(home), false);
});

test('Claude Agent SDK adapter streams a result with cost and isolated settings', async (t) => {
  const root = workspace(t);
  const seen = { run: { metadata: {} } };
  const fakeQuery = (request) => {
    seen.request = request;
    return (async function* messages() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Claude finished',
        session_id: 'claude-session-1',
        total_cost_usd: 0.0125,
        usage: {
          input_tokens: 30,
          output_tokens: 12,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        },
      };
    })();
  };

  const execution = await executeAgentRuntime({
    runtime: 'claude-agent-sdk',
    workflowPattern: 'supervisor',
    prompt: 'Implement the change',
    rootDir: root,
    backendKind: 'shell',
    systemPrompt: 'Trusted coding rules',
    maxTurns: 9,
    llm: { provider: 'claude', model: 'claude-sonnet-4-6', accessToken: 'oauth-secret' },
    loaders: { 'claude-agent-sdk': async () => ({ query: fakeQuery }) },
    getCurrentRunTree: () => seen.run,
    traceFactory: (fn, config) => {
      seen.trace = config;
      return fn;
    },
  });

  assert.equal(seen.request.options.maxTurns, 9);
  assert.deepEqual(seen.request.options.settingSources, []);
  assert.equal(seen.request.options.strictMcpConfig, true);
  assert.equal(seen.request.options.persistSession, false);
  assert.equal(seen.request.options.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-secret');
  assert.equal(seen.request.options.tools.includes('Bash'), false);
  assert.equal(seen.request.options.tools.includes('Agent'), true);
  assert.equal(execution.finalText, 'Claude finished');
  assert.equal(execution.workflowPattern, 'supervisor');
  assert.equal(execution.costUsd, 0.0125);
  assert.equal(execution.usage.totalTokens, 42);
  assert.equal(seen.trace.metadata.workflow_pattern, 'supervisor');
  assert.equal(seen.trace.metadata.ls_provider, 'anthropic');
  assert.equal(seen.trace.metadata.harness, 'claudecode');
  assert.ok(seen.trace.tags.includes('harness:claudecode'));
  assert.ok(seen.trace.tags.includes('model:claude-sonnet-4-6'));
  assert.equal(seen.trace.run_type, 'llm');
  assert.equal(seen.run.metadata.cost_usd, 0.0125);
  assert.equal(seen.run.metadata.usage_total_tokens, 42);
  assert.equal(seen.run.metadata.usage_metadata.total_cost, 0.0125);
});

test('runtime/provider mismatches fall back to traced DeepAgent execution', async (t) => {
  const root = workspace(t);
  const seen = { run: { metadata: {} }, sdkLoads: 0 };
  const execution = await executeAgentRuntime({
    runtime: 'codex-sdk',
    prompt: 'local task',
    rootDir: root,
    llm: { provider: 'ollama', model: 'qwen' },
    deepAgentInvoke: async () => ({ messages: [{ role: 'assistant', content: 'local done' }] }),
    lastText: (result) => result.messages.at(-1).content,
    loaders: { 'codex-sdk': async () => { seen.sdkLoads += 1; return {}; } },
    getCurrentRunTree: () => seen.run,
    traceFactory: (fn, config) => {
      seen.trace = config;
      return fn;
    },
  });

  assert.equal(execution.runtime, 'deepagent');
  assert.equal(execution.finalText, 'local done');
  assert.equal(seen.sdkLoads, 0);
  assert.equal(seen.trace.metadata.agent_runtime, 'deepagent');
  assert.equal(seen.trace.metadata.requested_agent_runtime, 'codex-sdk');
  assert.equal(seen.trace.metadata.runtime_fallback_reason, 'provider_mismatch');
  assert.equal(seen.trace.run_type, 'chain');
  assert.match(seen.trace.name, /deepagent/);
});

test('matching SDK providers still fail closed when authentication is unavailable', async (t) => {
  const root = workspace(t);
  await assert.rejects(
    executeAgentRuntime({
      runtime: 'claude-agent-sdk',
      prompt: 'task',
      rootDir: root,
      llm: { provider: 'claude', model: 'claude' },
      trace: false,
    }),
    (error) => error.code === 'runtime_auth_unavailable' && error.status === 401
  );
});

test('RubricMiddleware grades a DeepAgent run and surfaces its verdict on the trace', async (t) => {
  const seen = { run: { metadata: {} } };
  const execution = await executeAgentRuntime({
    runtime: 'deepagent',
    prompt: 'Ship the feature',
    llm: { provider: 'ollama', model: 'qwen' },
    deepAgentInvoke: async () => ({ messages: [{ role: 'assistant', content: 'Opened PR #7.' }] }),
    lastText: (result) => result.messages.at(-1).content,
    rubric: '- feature works\n- PR opened',
    rubricOptions: { deps: { callJson: async () => ({ json: { criteria: [{ name: 'feature works', passed: true }, { name: 'PR opened', passed: true }] } }) } },
    getCurrentRunTree: () => seen.run,
    traceFactory: (fn) => fn,
  });

  assert.equal(execution.finalText, 'Opened PR #7.');
  assert.equal(execution.review.result, 'satisfied');
  assert.equal(execution.review.satisfied, true);
  assert.equal(execution.review.iterations, 1);
  // Verdict is copied into trace metadata for analytics.
  assert.equal(seen.run.metadata.rubric_reviewed, true);
  assert.equal(seen.run.metadata.rubric_result, 'satisfied');
  assert.equal(seen.run.metadata.rubric_satisfied, true);
  assert.equal(seen.run.metadata.rubric_iterations, 1);
});

test('RubricMiddleware re-runs the SAME SDK runtime (Codex) on needs_revision', async (t) => {
  const root = workspace(t);
  const runs = [];
  class FakeCodex {
    startThread() {
      return {
        id: 't',
        run: async (prompt) => {
          runs.push(prompt);
          // First attempt is incomplete; the revision includes the gap block.
          return { finalResponse: runs.length === 1 ? 'draft' : 'DONE with tests', usage: { input_tokens: 5, output_tokens: 2 } };
        },
      };
    }
  }
  let round = 0;
  const execution = await executeAgentRuntime({
    runtime: 'codex-sdk',
    prompt: 'Do the SDK task',
    rootDir: root,
    llm: { provider: 'codex', backend: 'api', model: 'gpt-5-codex', accessToken: 'k', baseUrl: 'https://x.test/v1' },
    loaders: { 'codex-sdk': async () => ({ Codex: FakeCodex }) },
    rubric: ['ships tests'],
    rubricOptions: {
      deps: { callJson: async () => { round += 1; return { json: { criteria: [{ name: 'ships tests', passed: round >= 2, gap: 'add tests' }] } }; } },
    },
    trace: false,
  });

  assert.equal(execution.runtime, 'codex-sdk');
  assert.equal(runs.length, 2); // original run + one revision re-run
  assert.match(runs[1], /rubric_revision/); // the re-run carried the gap feedback
  assert.equal(execution.review.result, 'satisfied');
  assert.equal(execution.review.iterations, 2);
  assert.equal(execution.finalText, 'DONE with tests'); // final iteration output wins
  assert.equal(execution.usage.totalTokens, 14); // usage accumulated across both runs (7 + 7)
});

test('a grader defect never fails a completed run (fail-open backstop)', async (t) => {
  const execution = await executeAgentRuntime({
    runtime: 'deepagent',
    prompt: 'task',
    llm: { provider: 'ollama', model: 'qwen' },
    deepAgentInvoke: async () => ({ messages: [{ role: 'assistant', content: 'done' }] }),
    lastText: (result) => result.messages.at(-1).content,
    rubric: ['a'],
    rubricOptions: { deps: { callJson: async () => { throw new Error('grader exploded'); } } },
    trace: false,
  });

  assert.equal(execution.finalText, 'done');
  assert.equal(execution.review.result, 'grader_error');
  assert.equal(execution.review.satisfied, false);
  assert.match(execution.review.error, /grader exploded/);
});

test('a prebuilt rubricMiddleware instance is honored', async (t) => {
  const { createRubricMiddleware } = require('./rubric-middleware');
  const middleware = createRubricMiddleware({
    rubric: ['a'],
    deps: { callJson: async () => ({ json: { criteria: [{ name: 'a', passed: true }] } }) },
  });
  const execution = await executeAgentRuntime({
    runtime: 'deepagent',
    prompt: 'task',
    llm: { provider: 'ollama', model: 'qwen' },
    deepAgentInvoke: async () => ({ messages: [{ role: 'assistant', content: 'done' }] }),
    lastText: (result) => result.messages.at(-1).content,
    rubricMiddleware: middleware,
    trace: false,
  });
  assert.equal(execution.review.result, 'satisfied');
});

test('runs without a rubric attach no review (opt-in, backwards compatible)', async () => {
  const execution = await executeAgentRuntime({
    runtime: 'deepagent',
    prompt: 'task',
    llm: { provider: 'ollama', model: 'qwen' },
    deepAgentInvoke: async () => ({ messages: [{ role: 'assistant', content: 'done' }] }),
    lastText: (result) => result.messages.at(-1).content,
    trace: false,
  });
  assert.equal(Object.hasOwn(execution, 'review'), false);
});

test('Antigravity harness gates on a matching provider and the coding workflow', () => {
  // Matching provider (planning) runs the harness; a mismatch or brokered coding
  // falls back to DeepAgent — mirroring the codex/claude gating.
  assert.equal(
    effectiveAgentRuntime('antigravity-sdk', { provider: 'antigravity' }, { strict: true, workflow: 'planning' }),
    'antigravity-sdk'
  );
  assert.equal(
    effectiveAgentRuntime('antigravity-sdk', { provider: 'claude' }, { strict: true, workflow: 'planning' }),
    'deepagent'
  );
  assert.equal(
    effectiveAgentRuntime('antigravity-sdk', { provider: 'antigravity' }, { strict: true, workflow: 'coding' }),
    'deepagent'
  );
});

test('Antigravity SDK adapter returns the contract shape via the interactions API', async (t) => {
  const root = workspace(t);
  const seen = { run: { metadata: {} } };
  class FakeGoogleGenAI {
    constructor(options) {
      seen.client = options;
    }
    get interactions() {
      return {
        create: async (request) => {
          seen.request = request;
          return {
            id: 'antigravity-interaction-1',
            output: [{ content: [{ text: 'Antigravity finished' }] }],
            usageMetadata: {
              promptTokenCount: 18,
              candidatesTokenCount: 7,
              totalTokenCount: 25,
              thoughtsTokenCount: 2,
            },
          };
        },
      };
    }
  }

  const execution = await executeAgentRuntime({
    runtime: 'antigravity-sdk',
    workflowPattern: 'parallel',
    prompt: 'Plan the change',
    rootDir: root,
    backendKind: 'filesystem',
    systemPrompt: 'Trusted planning rules',
    llm: {
      provider: 'antigravity',
      model: 'gemini-2.5-flash',
      apiKey: 'gemini-secret',
      // Config-driven target: the preview agent id overrides the model for the call.
      agentId: 'antigravity-preview-agent',
    },
    loaders: { 'antigravity-sdk': async () => ({ GoogleGenAI: FakeGoogleGenAI }) },
    getCurrentRunTree: () => seen.run,
    traceFactory: (fn, config) => {
      seen.trace = config;
      return fn;
    },
  });

  assert.equal(seen.client.apiKey, 'gemini-secret');
  // The configured agent id is the call target; the trusted rules ride in `input`.
  assert.equal(seen.request.model, 'antigravity-preview-agent');
  assert.match(seen.request.input, /Trusted planning rules/);
  assert.match(seen.request.input, /workflow_pattern id="parallel"/);
  assert.match(seen.request.input, /Plan the change/);

  assert.equal(execution.runtime, 'antigravity-sdk');
  assert.equal(execution.provider, 'antigravity');
  // The contract's `model` stays the descriptor model even when an agent id is used.
  assert.equal(execution.model, 'gemini-2.5-flash');
  assert.equal(execution.finalText, 'Antigravity finished');
  assert.equal(execution.sessionId, 'antigravity-interaction-1');
  assert.equal(execution.costUsd, null);
  assert.equal(execution.usage.inputTokens, 18);
  assert.equal(execution.usage.outputTokens, 7);
  assert.equal(execution.usage.reasoningOutputTokens, 2);
  assert.equal(execution.usage.totalTokens, 25);

  assert.equal(seen.trace.metadata.agent_runtime, 'antigravity-sdk');
  assert.equal(seen.trace.metadata.harness, 'antigravity');
  assert.equal(seen.trace.metadata.ls_provider, 'google');
  assert.equal(seen.trace.run_type, 'llm');
  assert.ok(seen.trace.tags.includes('harness:antigravity'));
  assert.ok(seen.trace.tags.includes('runtime:antigravity-sdk'));
  assert.equal(seen.run.metadata.usage_total_tokens, 25);
});

test('Antigravity SDK falls back to models.generateContent when interactions is unavailable', async (t) => {
  const root = workspace(t);
  const seen = {};
  class FakeGoogleGenAI {
    constructor() {}
    get models() {
      return {
        generateContent: async (request) => {
          seen.request = request;
          return {
            responseId: 'gc-1',
            candidates: [{ content: { parts: [{ text: 'Generated content' }] } }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
          };
        },
      };
    }
  }

  const execution = await executeAgentRuntime({
    runtime: 'antigravity-sdk',
    prompt: 'Summarize',
    rootDir: root,
    llm: { provider: 'antigravity', model: 'gemini-2.5-flash', apiKey: 'gemini-secret' },
    loaders: { 'antigravity-sdk': async () => ({ GoogleGenAI: FakeGoogleGenAI }) },
    trace: false,
  });

  assert.equal(seen.request.model, 'gemini-2.5-flash');
  assert.equal(execution.finalText, 'Generated content');
  assert.equal(execution.sessionId, 'gc-1');
  assert.equal(execution.usage.totalTokens, 8);
});

test('Antigravity SDK fails closed when the Gemini API key is unavailable', async (t) => {
  const root = workspace(t);
  await assert.rejects(
    executeAgentRuntime({
      runtime: 'antigravity-sdk',
      prompt: 'task',
      rootDir: root,
      llm: { provider: 'antigravity', model: 'gemini-2.5-flash' },
      trace: false,
    }),
    (error) => error.code === 'runtime_auth_unavailable' && error.status === 401
  );
});

test('RubricMiddleware re-runs the SAME SDK runtime (Antigravity) on needs_revision', async (t) => {
  const root = workspace(t);
  const inputs = [];
  class FakeGoogleGenAI {
    constructor() {}
    get interactions() {
      return {
        create: async (request) => {
          inputs.push(request.input);
          // First attempt is incomplete; the revision includes the gap block.
          return {
            id: `antigravity-${inputs.length}`,
            output: [{ content: [{ text: inputs.length === 1 ? 'draft' : 'DONE with tests' }] }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
          };
        },
      };
    }
  }
  let round = 0;
  const execution = await executeAgentRuntime({
    runtime: 'antigravity-sdk',
    prompt: 'Do the SDK task',
    rootDir: root,
    llm: { provider: 'antigravity', model: 'gemini-2.5-flash', apiKey: 'gemini-secret' },
    loaders: { 'antigravity-sdk': async () => ({ GoogleGenAI: FakeGoogleGenAI }) },
    rubric: ['ships tests'],
    rubricOptions: {
      deps: { callJson: async () => { round += 1; return { json: { criteria: [{ name: 'ships tests', passed: round >= 2, gap: 'add tests' }] } }; } },
    },
    trace: false,
  });

  assert.equal(execution.runtime, 'antigravity-sdk');
  assert.equal(inputs.length, 2); // original run + one revision re-run
  assert.match(inputs[1], /rubric_revision/); // the re-run carried the gap feedback
  assert.equal(execution.review.result, 'satisfied');
  assert.equal(execution.review.iterations, 2);
  assert.equal(execution.finalText, 'DONE with tests'); // final iteration output wins
  assert.equal(execution.usage.totalTokens, 14); // usage accumulated across both runs (7 + 7)
});

test('Antigravity SDK resolves the key from settings (ctx) and falls back to env/store', async (t) => {
  const root = workspace(t);
  const seen = {};
  class FakeGoogleGenAI {
    constructor(options) {
      seen.apiKey = options.apiKey;
    }
    get models() {
      return {
        generateContent: async () => ({
          responseId: 'gc',
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      };
    }
  }
  const loaders = { 'antigravity-sdk': async () => ({ GoogleGenAI: FakeGoogleGenAI }) };

  // The settings-resolved key (ctx.geminiApiKey) wins over the descriptor key.
  await executeAgentRuntime({
    runtime: 'antigravity-sdk',
    prompt: 'task',
    rootDir: root,
    llm: { provider: 'antigravity', model: 'gemini-2.5-flash', apiKey: 'env-fallback-key' },
    ctx: { geminiApiKey: 'settings-resolved-key' },
    loaders,
    trace: false,
  });
  assert.equal(seen.apiKey, 'settings-resolved-key');

  // With no settings value, the descriptor's key (from GEMINI_API_KEY env/store) is used.
  await executeAgentRuntime({
    runtime: 'antigravity-sdk',
    prompt: 'task',
    rootDir: root,
    llm: { provider: 'antigravity', model: 'gemini-2.5-flash', apiKey: 'env-fallback-key' },
    ctx: {},
    loaders,
    trace: false,
  });
  assert.equal(seen.apiKey, 'env-fallback-key');
});

test('effectiveAgentRuntime downgrades a policy-excluded harness (enforcement)', () => {
  // codex is the provider so codex-sdk normally survives; the policy excludes it.
  const llm = { provider: 'codex' };
  const excludesCodex = { harness: { effective: ['deepagent', 'claude-agent-sdk'] } };
  assert.equal(
    effectiveAgentRuntime('codex-sdk', llm, { strict: true, workflow: 'planning', effectivePolicy: excludesCodex }),
    'deepagent'
  );
  // Without a policy, the provider-matched runtime is unchanged (no regression).
  assert.equal(
    effectiveAgentRuntime('codex-sdk', llm, { strict: true, workflow: 'planning' }),
    'codex-sdk'
  );
});

test('Claude permission guard denies credential-bearing shell and path escapes', async (t) => {
  const root = workspace(t);
  const outside = workspace(t);
  fs.symlinkSync(outside, path.join(root, 'outside-link'), 'dir');
  const guard = claudePermissionGuard(root, true);
  assert.equal((await guard('Bash', { command: 'env' })).behavior, 'deny');
  assert.equal((await guard('Read', { file_path: path.join(root, 'README.md') })).behavior, 'allow');
  assert.equal((await guard('Read', { file_path: path.join(root, '..', 'secret') })).behavior, 'deny');
  assert.equal((await guard('Read', { file_path: path.join(root, 'outside-link', 'secret') })).behavior, 'deny');
});
