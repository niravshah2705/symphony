'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const llm = require('./llm');
const mp = require('./model-presets');
const availability = require('./availability');

const SETTINGS = {
  thinkingLlmProvider: 'huggingface',
  huggingfaceHost: 'https://router.huggingface.co',
  huggingfaceApiKey: 'hf_test_token',
  huggingfaceModel: 'meta-llama/Llama-3.3-70B-Instruct',
  huggingfaceMaxTokens: 8192,
  huggingfaceTemperature: 0.7,
  huggingfaceReasoningEffort: 'none',
  huggingfaceReasoningAdapter: 'none',
};

test('resolveLlm builds a hosted OpenAI-compatible descriptor for huggingface', async () => {
  const d = await llm.resolveLlm(SETTINGS, 'thinking');
  assert.equal(d.provider, 'huggingface');
  assert.equal(d.baseUrl, 'https://router.huggingface.co/v1'); // apiPath appended
  assert.equal(d.apiKey, 'hf_test_token');
  assert.equal(d.model, 'meta-llama/Llama-3.3-70B-Instruct');
  assert.equal(d.numTokens, 8192);
});

test('resolveLlm strips a trailing /v1 from the configured host before re-appending', async () => {
  const d = await llm.resolveLlm({ ...SETTINGS, huggingfaceHost: 'https://router.huggingface.co/v1/' }, 'thinking');
  assert.equal(d.baseUrl, 'https://router.huggingface.co/v1');
});

test('llmReady requires both the token and a model; notReadyReason names Hugging Face', () => {
  assert.equal(llm.llmReady(SETTINGS, 'thinking'), true);
  assert.equal(llm.llmReady({ ...SETTINGS, huggingfaceApiKey: '' }, 'thinking'), false); // token is mandatory
  assert.equal(llm.llmReady({ ...SETTINGS, huggingfaceModel: '' }, 'thinking'), false);
  assert.match(llm.notReadyReason({ thinkingLlmProvider: 'huggingface' }, 'thinking'), /Hugging Face/);
});

test('createChatModel returns a ChatOpenAI targeting the router', async () => {
  const { ChatOpenAI } = require('@langchain/openai');
  const d = await llm.resolveLlm(SETTINGS, 'thinking');
  const model = llm.createChatModel(d, { json: true });
  // Wrapped in the shared managed base (adds stream retry) — still a ChatOpenAI.
  assert.ok(model instanceof ChatOpenAI);
  assert.equal(model.model || model.modelName, 'meta-llama/Llama-3.3-70B-Instruct');
});

test('catalog exposes byom huggingface presets and maps params to huggingface* settings', () => {
  mp.validateCatalog(mp.publicCatalog());
  const presets = mp.publicCatalog().presets.filter((p) => p.provider === 'huggingface');
  assert.ok(presets.length >= 1);
  assert.equal(presets.filter((p) => p.recommended).length, 1); // exactly one recommended
  // Hugging Face is folded into the BYoM deployment tier (hosted router, but the
  // operator brings the model), while still forbidding local-only preset fields.
  assert.equal(mp.PROVIDER_DEPLOYMENT.huggingface, 'byom');
  assert.equal(presets.find((p) => p.recommended).deployment, 'byom');
  const patch = mp.settingsPatchForPreset(presets.find((p) => p.recommended));
  assert.equal(patch.huggingfaceModel, 'meta-llama/Llama-3.3-70B-Instruct');
  assert.ok(Number.isInteger(patch.huggingfaceMaxTokens));
  const custom = mp.customPresetForSettings('huggingface', { huggingfaceModel: 'Qwen/Qwen2.5-7B-Instruct' });
  assert.equal(custom.deployment, 'byom');
  assert.equal(custom.model, 'Qwen/Qwen2.5-7B-Instruct');
});

test('normalizeEvaluation-style signal clamp is not relevant here; readiness probe validates the token', async () => {
  const d = await llm.resolveLlm(SETTINGS, 'thinking');
  // A 200 from /v1/models means the token + connectivity are good.
  const okProbe = await availability.probeModelAvailability(d, {
    fetchImpl: async (url) => {
      assert.match(url, /\/v1\/models$/);
      return { ok: true, json: async () => ({ data: [] }) };
    },
  });
  assert.equal(okProbe.available, true);
  // A 401 surfaces as an availability error (bad/missing token).
  await assert.rejects(
    () => availability.probeModelAvailability(d, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }),
    (e) => e.name === 'AgentAvailabilityError'
  );
});

test('probe fails fast when the token is missing', async () => {
  const d = await llm.resolveLlm({ ...SETTINGS, huggingfaceApiKey: '' }, 'thinking');
  await assert.rejects(
    () => availability.probeModelAvailability(d, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }),
    (e) => e.name === 'AgentAvailabilityError' && e.code === 'model_not_configured'
  );
});
