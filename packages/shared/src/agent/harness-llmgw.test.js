'use strict';

// Native SDK harness wiring for LangSmith-gateway descriptors (llm.gateway ===
// 'langsmith'): Bearer credential env, gateway base URL, provider-prefixed wire
// model — while llm.model stays bare in traces and results.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { executeAgentRuntime } = require('./runtimes');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-llmgw-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('claude-agent-sdk gateway run uses ANTHROPIC_AUTH_TOKEN + gateway base + wire model', async (t) => {
  const root = workspace(t);
  const seen = {};
  const fakeQuery = (request) => {
    seen.request = request;
    return (async function* messages() {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's1' };
    })();
  };

  await executeAgentRuntime({
    runtime: 'claude-agent-sdk',
    prompt: 'Implement the change',
    rootDir: root,
    backendKind: 'shell',
    llm: {
      provider: 'claude',
      gateway: 'langsmith',
      model: 'claude-sonnet-4-6',
      accessToken: 'lsv2_workspace',
      baseUrl: 'https://gateway.smith.langchain.com',
    },
    loaders: { 'claude-agent-sdk': async () => ({ query: fakeQuery }) },
  });

  const env = seen.request.options.env;
  // Bearer workspace-key auth — never the Claude Code OAuth env on this path.
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'lsv2_workspace');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://gateway.smith.langchain.com');
  assert.equal(seen.request.options.model, 'anthropic/claude-sonnet-4-6');
});

test('claude-agent-sdk non-gateway run keeps the OAuth env and bare model', async (t) => {
  const root = workspace(t);
  const seen = {};
  const fakeQuery = (request) => {
    seen.request = request;
    return (async function* messages() {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's1' };
    })();
  };

  await executeAgentRuntime({
    runtime: 'claude-agent-sdk',
    prompt: 'Implement the change',
    rootDir: root,
    backendKind: 'shell',
    llm: { provider: 'claude', model: 'claude-sonnet-4-6', accessToken: 'oauth-secret' },
    loaders: { 'claude-agent-sdk': async () => ({ query: fakeQuery }) },
  });

  const env = seen.request.options.env;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-secret');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(seen.request.options.model, 'claude-sonnet-4-6');
});

test('codex-sdk gateway run targets the gateway base with the openai/ wire model', async (t) => {
  const root = workspace(t);
  const seen = {};
  class FakeCodex {
    constructor(options) { seen.client = options; }
    startThread(options) {
      seen.thread = options;
      return { id: 't1', run: async () => ({ finalResponse: 'done', items: [] }) };
    }
  }

  const execution = await executeAgentRuntime({
    runtime: 'codex-sdk',
    prompt: 'Inspect the repository',
    rootDir: root,
    backendKind: 'shell',
    llm: {
      provider: 'codex',
      backend: 'api',
      gateway: 'langsmith',
      model: 'gpt-5-codex',
      accessToken: 'lsv2_workspace',
      baseUrl: 'https://gateway.smith.langchain.com/v1',
      authTokens: null,
    },
    loaders: { 'codex-sdk': async () => ({ Codex: FakeCodex }) },
  });

  assert.equal(seen.client.apiKey, 'lsv2_workspace');
  assert.equal(seen.client.baseUrl, 'https://gateway.smith.langchain.com/v1');
  // Wire model is prefixed; the reported model stays bare for policy/traces.
  assert.equal(seen.thread.model, 'openai/gpt-5-codex');
  assert.equal(execution.model, 'gpt-5-codex');
});
