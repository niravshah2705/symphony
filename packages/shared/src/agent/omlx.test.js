'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG } = require('../config');
const { DEFAULT_STORE } = require('../store');
const {
  PROVIDER_DEPLOYMENT,
  validateCatalog,
  publicCatalog,
  getPreset,
  presetForRole,
  settingsPatchForPreset,
  neutralLocalPreset,
} = require('./model-presets');
const {
  createChatModel,
  providerForRole,
  resolveLlm,
  llmReady,
  notReadyReason,
} = require('./llm');
const { probeModelAvailability } = require('./availability');
const { runDiagnostics } = require('./diagnostics');
const { LIMITS, resolveLocalLlm } = require('./local-intelligence');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    body: { async cancel() {} },
  };
}

function settings(overrides = {}) {
  return {
    llmProvider: 'codex',
    localLlmProvider: 'omlx',
    omlxHost: 'http://127.0.0.1:8000',
    omlxModel: 'gpt-oss-20b',
    omlxApiKey: 'local-secret',
    omlxContextWindow: 65536,
    omlxNumTokens: 16384,
    omlxTemperature: 1,
    omlxTopP: 1,
    omlxTopK: null,
    omlxRepeatPenalty: null,
    omlxReasoningEffort: 'medium',
    omlxReasoningAdapter: 'omlx-template-effort',
    omlxJsonMode: 'json_schema',
    omlxContextMode: 'summarize',
    ...overrides,
  };
}

test('OMLX is a validated local preset provider with one reviewed recommendation', () => {
  const catalog = publicCatalog();
  assert.equal(validateCatalog(catalog), catalog);
  assert.equal(CONFIG.LLM_PROVIDERS.includes('omlx'), true);
  assert.equal(PROVIDER_DEPLOYMENT.omlx, 'local');

  const presets = catalog.presets.filter((preset) => preset.provider === 'omlx');
  assert.equal(presets.filter((preset) => preset.recommended).length, 1);
  assert.equal(presets.find((preset) => preset.recommended).id, 'omlx-gpt-oss-20b');
  assert.equal(getPreset('omlx-qwen3-coder-next').deployment, 'local');
  assert.equal(presetForRole('omlx-gpt-oss-20b', 'local').provider, 'omlx');
  assert.equal(presetForRole('omlx-gpt-oss-20b', 'global'), null);
});

test('OMLX preset materialization uses the complete omlx prefix and enforces its half-context budget', () => {
  const preset = getPreset('omlx-gpt-oss-20b');
  const patch = settingsPatchForPreset(preset, {
    contextWindow: 32768,
    maxOutputTokens: 65536,
    reasoningEffort: 'high',
    jsonMode: 'json_object',
    contextMode: 'trim',
  });

  assert.deepEqual(patch, {
    omlxModel: preset.model,
    omlxContextWindow: 32768,
    omlxNumTokens: 16384,
    omlxTemperature: 1,
    omlxTopP: 1,
    omlxTopK: null,
    omlxRepeatPenalty: null,
    omlxReasoningEffort: 'high',
    omlxReasoningAdapter: 'omlx-template-effort',
    omlxJsonMode: 'json_object',
    omlxContextMode: 'trim',
  });

  const neutral = settingsPatchForPreset(neutralLocalPreset('omlx', 'mlx-community/custom-model'));
  assert.equal(neutral.omlxModel, 'mlx-community/custom-model');
  assert.equal(neutral.omlxReasoningAdapter, 'none');
  assert.equal(neutral.omlxJsonMode, 'text');
  assert.equal(neutral.omlxContextMode, 'summarize');
});

test('fresh stores include an isolated OMLX endpoint, optional key, and preset defaults', () => {
  assert.equal(CONFIG.OMLX.defaultHost, 'http://127.0.0.1:8000');
  assert.equal(DEFAULT_STORE.settings.omlxHost, 'http://127.0.0.1:8000');
  assert.equal(DEFAULT_STORE.settings.omlxApiKey, '');

  const defaults = settingsPatchForPreset(getPreset('omlx-gpt-oss-20b'));
  for (const [key, value] of Object.entries(defaults)) {
    assert.deepEqual(DEFAULT_STORE.settings[key], value, key);
  }
});

test('OMLX routes through the local slot and resolves as a ready OpenAI-compatible local model', async () => {
  const configured = settings({ omlxHost: 'http://127.0.0.1:8000/' });
  assert.equal(providerForRole(configured, 'local'), 'omlx');
  assert.equal(providerForRole(configured, 'global'), 'codex');

  const llm = await resolveLlm(configured, 'local');
  assert.equal(llm.provider, 'omlx');
  assert.equal(llm.host, 'http://127.0.0.1:8000');
  assert.equal(llm.baseUrl, 'http://127.0.0.1:8000/v1');
  assert.equal(llm.model, 'gpt-oss-20b');
  assert.equal(llm.apiKey, 'local-secret');
  assert.equal(llm.contextWindow, 65536);
  assert.equal(llm.numTokens, 16384);

  const client = createChatModel(llm, { json: true });
  assert.equal(client.apiKey, 'local-secret');
  assert.equal(client.clientConfig.baseURL, 'http://127.0.0.1:8000/v1');
  assert.deepEqual(client.modelKwargs.chat_template_kwargs, { reasoning_effort: 'medium' });
  assert.equal(client.modelKwargs.response_format.type, 'json_schema');

  assert.equal(llmReady(settings({ llmProvider: 'omlx' })), true);
  assert.equal(llmReady(settings({ llmProvider: 'omlx', omlxModel: '' })), false);
  assert.match(notReadyReason({ llmProvider: 'omlx' }), /OMLX.*host and model/i);
});

test('OMLX availability discovers /v1/models with optional Bearer authentication', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return jsonResponse({ data: [{ id: 'gpt-oss-20b' }] });
  };

  const authenticated = await probeModelAvailability(
    { provider: 'omlx', host: 'http://127.0.0.1:8000/', model: 'gpt-oss-20b', apiKey: 'local-secret' },
    { fetchImpl }
  );
  const anonymous = await probeModelAvailability(
    { provider: 'omlx', host: 'http://127.0.0.1:8000', model: 'gpt-oss-20b', apiKey: '' },
    { fetchImpl }
  );

  assert.deepEqual(authenticated, { available: true, provider: 'omlx', model: 'gpt-oss-20b' });
  assert.deepEqual(anonymous, authenticated);
  assert.equal(requests[0].url, 'http://127.0.0.1:8000/v1/models');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer local-secret');
  assert.equal(Object.prototype.hasOwnProperty.call(requests[1].options.headers, 'Authorization'), false);
});

test('OMLX diagnostics probe the configured endpoint without exposing its API key', async () => {
  const requests = [];
  const report = await runDiagnostics(settings({
    planningProvider: 'linear',
    repositoryProvider: 'github',
  }), {
    services: { plannerUrl: 'http://planner.internal:4010', coderUrl: 'http://coder.internal:4020' },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({});
    },
    resolvePackage: () => '/installed/package.js',
  });

  const modelRequest = requests.find((request) => request.url === 'http://127.0.0.1:8000/v1/models');
  assert.ok(modelRequest);
  assert.equal(
    modelRequest.options.headers.Authorization || modelRequest.options.headers.authorization,
    'Bearer local-secret'
  );
  const modelCheck = report.checks.find((check) => check.id === 'local-model');
  assert.equal(modelCheck.status, 'healthy');
  assert.equal(modelCheck.details.provider, 'omlx');
  assert.equal(JSON.stringify(report).includes('local-secret'), false);
});

test('local intelligence admits OMLX and preserves the private local output cap', async () => {
  const llm = await resolveLocalLlm(settings({ omlxNumTokens: 99999 }));
  assert.equal(llm.provider, 'omlx');
  assert.equal(llm.model, 'gpt-oss-20b');
  assert.equal(llm.host, 'http://127.0.0.1:8000');
  assert.equal(llm.numTokens, LIMITS.modelOutputTokens);
});
