'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateCatalog,
  publicCatalog,
  getPreset,
  presetForRole,
  presetForModel,
  modelMatchesPreset,
  settingsPatchForPreset,
  customPresetForSettings,
} = require('./model-presets');
const { createChatModel } = require('./llm');
const { DEFAULT_STORE, settingsForConfiguredModel } = require('../store');

test('LLM preset catalog has valid, unique local and hosted defaults', () => {
  const catalog = publicCatalog();
  assert.equal(validateCatalog(catalog), catalog);
  assert.equal(new Set(catalog.presets.map((preset) => preset.id)).size, catalog.presets.length);
  assert.equal(getPreset(catalog.defaults.local).deployment, 'local');
  assert.equal(getPreset(catalog.defaults.hosted).deployment, 'hosted');
});

test('catalog validation rejects defaults that violate an effective context fraction', () => {
  const invalid = JSON.parse(JSON.stringify(publicCatalog()));
  const lmstudio = invalid.presets.find((preset) => preset.id === 'lmstudio-gpt-oss-20b');
  lmstudio.parameters.maxOutputTokens = 40000;
  assert.throws(() => validateCatalog(invalid), /effective context rule/);
});

test('fresh-store active settings come from the exact catalog defaults', () => {
  const catalog = publicCatalog();
  const local = getPreset(catalog.defaults.local);
  const expectedLocal = settingsPatchForPreset(local);
  assert.equal(DEFAULT_STORE.settings.localLlmPresetId, local.id);
  assert.equal(DEFAULT_STORE.settings.localLlmProvider, local.provider);
  for (const [key, value] of Object.entries(expectedLocal)) {
    assert.deepEqual(DEFAULT_STORE.settings[key], value, key);
  }

  const hosted = getPreset(catalog.defaults.hosted);
  assert.equal(DEFAULT_STORE.settings.llmProvider, hosted.provider);
  if (DEFAULT_STORE.settings.hostedLlmPresetId === hosted.id) {
    const expectedHosted = settingsPatchForPreset(hosted);
    for (const [key, value] of Object.entries(expectedHosted)) {
      assert.deepEqual(DEFAULT_STORE.settings[key], value, key);
    }
  }
});

test('an environment model outside a hosted preset family gets neutral custom parameters', () => {
  const claude = settingsForConfiguredModel(getPreset('claude-opus-4-8'), 'claude-sonnet-custom');
  assert.equal(claude.claudeModel, 'claude-sonnet-custom');
  assert.equal(claude.claudeMaxTokens, 4096);
  assert.equal(claude.claudeReasoningEffort, 'none');
  assert.equal(claude.claudeReasoningAdapter, 'none');

  const codex = settingsForConfiguredModel(getPreset('codex-gpt-5-5'), 'custom-chat-model');
  assert.equal(codex.codexModel, 'custom-chat-model');
  assert.equal(codex.codexTemperature, null);
  assert.equal(codex.codexReasoningEffort, 'none');
  assert.equal(codex.codexReasoningAdapter, 'none');
});

test('presetForRole prevents a local preset from entering the hosted slot and vice versa', () => {
  assert.equal(presetForRole('ollama-gpt-oss-20b', 'local').provider, 'ollama');
  assert.equal(presetForRole('ollama-gpt-oss-20b', 'global'), null);
  assert.equal(presetForRole('claude-opus-4-8', 'global').provider, 'claude');
  assert.equal(presetForRole('claude-opus-4-8', 'local'), null);
  assert.equal(presetForRole('does-not-exist', 'local'), null);
});

test('named presets accept compatible local aliases but reject cross-model overrides', () => {
  const local = getPreset('ollama-gpt-oss-20b');
  const hosted = getPreset('claude-opus-4-8');
  assert.equal(modelMatchesPreset(local, 'hf.co/openai/gpt-oss-20b-Q4_K_M'), true);
  assert.equal(modelMatchesPreset(local, 'qwen3-coder:30b'), false);
  assert.equal(modelMatchesPreset(hosted, 'claude-opus-4-8'), true);
  assert.equal(modelMatchesPreset(hosted, 'claude-opus-4-8-custom'), false);
  assert.equal(presetForModel('ollama', 'qwen3-coder:30b').id, 'ollama-qwen3-coder-30b');
  assert.equal(presetForModel('claude', 'some-custom-model'), null);
});

test('Ollama preset materializes model, token, temperature, JSON, and reasoning fields', () => {
  const patch = settingsPatchForPreset(getPreset('ollama-gpt-oss-20b'));
  assert.deepEqual(patch, {
    ollamaModel: 'gpt-oss:20b',
    ollamaContextWindow: 65536,
    ollamaNumTokens: 16384,
    ollamaTemperature: 1,
    ollamaTopP: 1,
    ollamaTopK: null,
    ollamaRepeatPenalty: null,
    ollamaReasoningEffort: 'medium',
    ollamaReasoningAdapter: 'ollama-think-effort',
    ollamaJsonMode: 'json',
  });
});

test('Qwen coder presets carry the model-card sampling defaults', () => {
  const ollama = settingsPatchForPreset(getPreset('ollama-qwen3-coder-30b'));
  assert.equal(ollama.ollamaContextWindow, 131072);
  assert.equal(ollama.ollamaNumTokens, 65536);
  assert.equal(ollama.ollamaTemperature, 0.7);
  assert.equal(ollama.ollamaTopP, 0.8);
  assert.equal(ollama.ollamaTopK, 20);
  assert.equal(ollama.ollamaRepeatPenalty, 1.05);
  assert.equal(ollama.ollamaReasoningAdapter, 'none');
});

test('Ollama output overrides cannot exceed the configured context', () => {
  const patch = settingsPatchForPreset(getPreset('ollama-qwen3-coder-30b'), {
    contextWindow: 32768,
    maxOutputTokens: 65536,
  });
  assert.equal(patch.ollamaContextWindow, 32768);
  assert.equal(patch.ollamaNumTokens, 32768);
});

test('preset overrides are allowlisted and clamped to model capabilities', () => {
  const patch = settingsPatchForPreset(getPreset('claude-opus-4-8'), {
    model: 'claude-opus-4-8-custom',
    contextWindow: 512,
    maxOutputTokens: 999999,
    temperature: 1,
    reasoningEffort: 'invalid',
    arbitraryRequestField: 'must not escape',
  });
  assert.equal(patch.claudeModel, 'claude-opus-4-8', 'named presets reject incompatible model-specific adapters');
  assert.equal(patch.claudeContextWindow, 1000000, 'hosted context is informational, not request-configurable');
  assert.equal(patch.claudeMaxTokens, 128000);
  assert.equal(patch.claudeTemperature, null, 'unsupported sampling parameters are omitted');
  assert.equal(patch.claudeReasoningEffort, 'xhigh');
  assert.ok(!Object.values(patch).includes('must not escape'));
});

test('LM Studio reasoning adapter is opt-in per preset', () => {
  const reasoning = settingsPatchForPreset(getPreset('lmstudio-gpt-oss-20b'), { reasoningEffort: 'high' });
  const noReasoning = settingsPatchForPreset(getPreset('lmstudio-qwen3-coder-30b'), { reasoningEffort: 'high' });
  assert.equal(reasoning.lmstudioReasoningAdapter, 'openai-compatible');
  assert.equal(reasoning.lmstudioReasoningEffort, 'high');
  assert.equal(noReasoning.lmstudioReasoningAdapter, 'none');
  assert.equal(noReasoning.lmstudioReasoningEffort, 'none');
});

test('LM Studio preset overrides keep output within half the loaded context', () => {
  const patch = settingsPatchForPreset(getPreset('lmstudio-qwen3-coder-30b'), {
    contextWindow: 32768,
    maxOutputTokens: 65536,
  });
  assert.equal(patch.lmstudioContextWindow, 32768);
  assert.equal(patch.lmstudioNumTokens, 16384);
});

test('legacy custom settings remain editable without selecting a preset first', () => {
  const custom = customPresetForSettings('lmstudio', {
    lmstudioModel: 'my-local-model',
    lmstudioContextWindow: 32768,
    lmstudioNumTokens: 8000,
    lmstudioTemperature: 0.2,
    lmstudioReasoningEffort: null,
    lmstudioReasoningAdapter: 'none',
    lmstudioJsonMode: 'text',
    lmstudioContextMode: 'trim',
  });
  const patch = settingsPatchForPreset(custom, { model: 'my-local-model-v2', maxOutputTokens: 9000 });
  assert.equal(custom.id, 'custom');
  assert.equal(patch.lmstudioModel, 'my-local-model-v2');
  assert.equal(patch.lmstudioContextWindow, 32768);
  assert.equal(patch.lmstudioNumTokens, 9000);
  assert.equal(patch.lmstudioReasoningAdapter, 'none');
});

test('provider clients receive native reasoning parameters and safe temperatures', () => {
  const ollama = createChatModel({
    provider: 'ollama', host: 'http://localhost:11434', model: 'gpt-oss:20b',
    contextWindow: 65536, numTokens: 16384, temperature: 1, topP: 1,
    reasoningEffort: 'medium', reasoningAdapter: 'ollama-think-effort', jsonMode: 'json',
  });
  assert.equal(ollama.think, 'medium');
  assert.equal(ollama.temperature, 1);
  assert.equal(ollama.topP, 1);

  const lmstudio = createChatModel({
    provider: 'lmstudio', baseUrl: 'http://localhost:1234/v1', model: 'gpt-oss-20b',
    contextWindow: 65536, numTokens: 16384, temperature: 0.7, topP: 0.8, topK: 20, repeatPenalty: 1.05,
    reasoningEffort: 'high', reasoningAdapter: 'openai-compatible', jsonMode: 'text', contextMode: 'summarize',
  });
  assert.deepEqual(lmstudio.modelKwargs, { top_k: 20, repeat_penalty: 1.05, reasoning_effort: 'high' });
  assert.equal(lmstudio.temperature, 0.7);
  assert.equal(lmstudio.topP, 0.8);

  const codex = createChatModel({
    provider: 'codex', backend: 'api', baseUrl: 'http://localhost/v1', model: 'gpt-5.5',
    accessToken: 'test', numTokens: 65536, temperature: null, reasoningEffort: 'high', reasoningAdapter: 'openai',
  });
  assert.deepEqual(codex.reasoning, { effort: 'high' });
  assert.equal(codex.temperature, undefined);

  const claude = createChatModel({
    provider: 'claude', baseUrl: 'http://localhost', model: 'claude-opus-4-8',
    accessToken: 'test', numTokens: 65536, temperature: null, reasoningEffort: 'xhigh', reasoningAdapter: 'anthropic-adaptive',
  });
  assert.deepEqual(claude.thinking, { type: 'adaptive' });
  assert.deepEqual(claude.outputConfig, { effort: 'xhigh' });
  assert.equal(claude.temperature, undefined);
});
