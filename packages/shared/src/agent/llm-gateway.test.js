'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// config.js reads LLM_GATEWAY_ENABLED / EGRESS_PROXY_URL once at module load,
// so each deployment mode is asserted in its own subprocess (the same pattern
// as egress-wiring.test.js).
function resolveWith(env) {
  const out = execFileSync(process.execPath, ['-e', DUMP], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, EGRESS_PROXY_URL: '', LLM_GATEWAY_ENABLED: '', LANGSMITH_GATEWAY_URL: '', ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

const DUMP = `
const { resolveLlm, wireModelId, claudeClientHeaders } = require('./src/agent/llm');
const capture = (promise) => promise.catch((e) => ({ error: e.message, status: e.status }));
(async () => {
  const base = {
    claudeModel: 'claude-sonnet-4-6',
    codexModel: 'gpt-5-codex',
    ...(process.env.TEST_GW_KEY ? { langsmithGatewayApiKey: process.env.TEST_GW_KEY } : {}),
  };
  const flagged = { ...base, llmGateway: 'langsmith' };
  const out = {
    claudeFlagged: await capture(resolveLlm({ ...flagged, llmProvider: 'claude' })),
    codexFlagged: await capture(resolveLlm({ ...flagged, llmProvider: 'codex' })),
  };
  if (process.env.TEST_RESOLVE_UNFLAGGED === 'true') {
    out.claudeUnflagged = await capture(resolveLlm({ ...base, llmProvider: 'claude' }));
    out.codexUnflagged = await capture(resolveLlm({ ...base, llmProvider: 'codex' }));
  }
  out.wire = {
    claude: wireModelId(out.claudeFlagged),
    codex: wireModelId(out.codexFlagged),
    direct: wireModelId({ provider: 'claude', model: 'claude-sonnet-4-6' }),
  };
  out.headers = {
    flagged: claudeClientHeaders(out.claudeFlagged),
    direct: claudeClientHeaders({ provider: 'claude' }),
  };
  console.log(JSON.stringify(out));
})();
`;

test('flagged + proxied: descriptors route via the sidecar /llmgw prefix with the sentinel', () => {
  const out = resolveWith({
    LLM_GATEWAY_ENABLED: 'true',
    EGRESS_PROXY_URL: 'http://127.0.0.1:4030',
    TEST_RESOLVE_UNFLAGGED: 'true',
  });
  assert.equal(out.claudeFlagged.gateway, 'langsmith');
  assert.equal(out.claudeFlagged.baseUrl, 'http://127.0.0.1:4030/llmgw');
  assert.equal(out.claudeFlagged.accessToken, 'egress-proxy-sentinel');
  // llm.model stays BARE — policy enforcement and admission snapshots see the
  // same name as the direct path; only the wire id is prefixed.
  assert.equal(out.claudeFlagged.model, 'claude-sonnet-4-6');
  assert.equal(out.wire.claude, 'anthropic/claude-sonnet-4-6');

  assert.equal(out.codexFlagged.gateway, 'langsmith');
  assert.equal(out.codexFlagged.backend, 'api');
  assert.equal(out.codexFlagged.baseUrl, 'http://127.0.0.1:4030/llmgw/v1');
  assert.equal(out.codexFlagged.authTokens, null);
  assert.equal(out.wire.codex, 'openai/gpt-5-codex');
  // The flag changes routing only — model selection matches the unflagged path.
  assert.equal(out.codexFlagged.model, out.codexUnflagged.model);

  // Unflagged descriptors keep today's sidecar routes, untouched.
  assert.equal(out.claudeUnflagged.gateway, undefined);
  assert.equal(out.claudeUnflagged.baseUrl, 'http://127.0.0.1:4030/anthropic');
  assert.equal(out.codexUnflagged.gateway, undefined);
});

test('flag without LLM_GATEWAY_ENABLED is inert — descriptors identical to unflagged', () => {
  const out = resolveWith({
    EGRESS_PROXY_URL: 'http://127.0.0.1:4030',
    TEST_RESOLVE_UNFLAGGED: 'true',
  });
  assert.deepEqual(out.claudeFlagged, out.claudeUnflagged);
  assert.deepEqual(out.codexFlagged, out.codexUnflagged);
  assert.equal(out.claudeFlagged.baseUrl, 'http://127.0.0.1:4030/anthropic');
});

test('flagged + non-proxied: descriptors hit the gateway directly with the workspace key', () => {
  const out = resolveWith({ LLM_GATEWAY_ENABLED: 'true', TEST_GW_KEY: 'lsv2_workspace' });
  assert.equal(out.claudeFlagged.baseUrl, 'https://gateway.smith.langchain.com');
  assert.equal(out.claudeFlagged.accessToken, 'lsv2_workspace');
  assert.equal(out.codexFlagged.baseUrl, 'https://gateway.smith.langchain.com/v1');
  assert.equal(out.codexFlagged.accessToken, 'lsv2_workspace');
});

test('flagged + non-proxied without a workspace key fails with 401 (no OAuth fallback)', () => {
  const out = resolveWith({ LLM_GATEWAY_ENABLED: 'true' });
  assert.equal(out.claudeFlagged.status, 401);
  assert.match(out.claudeFlagged.error, /workspace key/);
  assert.equal(out.codexFlagged.status, 401);
});

test('LANGSMITH_GATEWAY_URL retargets the direct gateway base (BYOC)', () => {
  const out = resolveWith({
    LLM_GATEWAY_ENABLED: 'true',
    LANGSMITH_GATEWAY_URL: 'https://dataplane.example/gateway/',
    TEST_GW_KEY: 'lsv2_workspace',
  });
  assert.equal(out.claudeFlagged.baseUrl, 'https://dataplane.example/gateway');
  assert.equal(out.codexFlagged.baseUrl, 'https://dataplane.example/gateway/v1');
});

test('wire id and anthropic-beta header stay untouched for non-gateway descriptors', () => {
  const out = resolveWith({ LLM_GATEWAY_ENABLED: 'true', TEST_GW_KEY: 'lsv2_workspace' });
  assert.equal(out.wire.direct, 'claude-sonnet-4-6');
  // Gateway descriptor: NO oauth beta header. Direct descriptor: keeps it.
  assert.deepEqual(out.headers.flagged, {});
  assert.equal(typeof out.headers.direct['anthropic-beta'], 'string');
  assert.ok(out.headers.direct['anthropic-beta'].length > 0);
});
