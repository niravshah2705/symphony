'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const llm = require('./llm');
const mp = require('./model-presets');
const availability = require('./availability');
const { CONFIG } = require('../config');

const SETTINGS = {
  thinkingLlmProvider: 'antigravity',
  antigravityApiKey: 'gemini_test_token',
  antigravityModel: 'gemini-2.5-flash',
  antigravityAgentId: '',
  antigravityMaxTokens: 8192,
  antigravityTemperature: 0.7,
  antigravityReasoningEffort: 'none',
  antigravityReasoningAdapter: 'none',
};

test('config exposes antigravity as a hosted Gemini-backed provider', () => {
  assert.equal(CONFIG.LLM_PROVIDERS.includes('antigravity'), true);
  assert.equal(mp.PROVIDER_DEPLOYMENT.antigravity, 'hosted');
  assert.equal(CONFIG.ANTIGRAVITY.defaultModel, 'gemini-2.5-flash');
});

test('resolveLlm builds a Gemini-key descriptor carrying the OpenAI-compatible endpoint', async () => {
  const d = await llm.resolveLlm(SETTINGS, 'thinking');
  assert.equal(d.provider, 'antigravity');
  assert.equal(d.apiKey, 'gemini_test_token');
  // The key is also the harness credential (auth guard reads accessToken).
  assert.equal(d.accessToken, 'gemini_test_token');
  assert.equal(d.model, 'gemini-2.5-flash');
  assert.equal(d.baseUrl, CONFIG.ANTIGRAVITY.openaiBaseUrl);
  assert.equal(d.numTokens, 8192);
});

test('resolveLlm applies the config-driven agent-id override and model default', async () => {
  const withAgent = await llm.resolveLlm({ ...SETTINGS, antigravityAgentId: 'antigravity-preview-agent' }, 'thinking');
  assert.equal(withAgent.agentId, 'antigravity-preview-agent');
  const noModel = await llm.resolveLlm({ ...SETTINGS, antigravityModel: '' }, 'thinking');
  assert.equal(noModel.model, CONFIG.ANTIGRAVITY.defaultModel);
});

test('llmReady requires the Gemini key; notReadyReason names the Gemini API key', () => {
  assert.equal(llm.llmReady(SETTINGS, 'thinking'), true);
  assert.equal(llm.llmReady({ ...SETTINGS, antigravityApiKey: '' }, 'thinking'), false);
  assert.match(llm.notReadyReason({ thinkingLlmProvider: 'antigravity' }, 'thinking'), /Gemini API key/);
});

test('createChatModel maps antigravity to a ChatOpenAI targeting the Gemini endpoint', async () => {
  const { ChatOpenAI } = require('@langchain/openai');
  const d = await llm.resolveLlm(SETTINGS, 'thinking');
  const model = llm.createChatModel(d, { json: true });
  assert.ok(model instanceof ChatOpenAI);
  assert.equal(model.model || model.modelName, 'gemini-2.5-flash');
});

test('catalog exposes hosted antigravity presets and maps params to antigravity* settings', () => {
  mp.validateCatalog(mp.publicCatalog());
  const presets = mp.publicCatalog().presets.filter((p) => p.provider === 'antigravity');
  assert.ok(presets.length >= 1);
  assert.equal(presets.filter((p) => p.recommended).length, 1);
  const patch = mp.settingsPatchForPreset(presets.find((p) => p.recommended));
  assert.equal(patch.antigravityModel, 'gemini-2.5-flash');
  assert.ok(Number.isInteger(patch.antigravityMaxTokens));
  const custom = mp.customPresetForSettings('antigravity', { antigravityModel: 'gemini-2.5-pro' });
  assert.equal(custom.deployment, 'hosted');
  assert.equal(custom.model, 'gemini-2.5-pro');
});

test('availability probes the Gemini key against the OpenAI-compatible endpoint', async () => {
  const d = await llm.resolveLlm(SETTINGS, 'thinking');
  const okProbe = await availability.probeModelAvailability(d, {
    fetchImpl: async (url) => {
      assert.match(url, /\/models$/);
      return { ok: true, json: async () => ({ data: [] }) };
    },
  });
  assert.equal(okProbe.available, true);
  await assert.rejects(
    () => availability.probeModelAvailability(d, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }),
    (e) => e.name === 'AgentAvailabilityError'
  );
});

test('availability fails fast when the Gemini key is missing', async () => {
  const d = await llm.resolveLlm({ ...SETTINGS, antigravityApiKey: '' }, 'thinking');
  await assert.rejects(
    () => availability.probeModelAvailability(d, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }),
    (e) => e.name === 'AgentAvailabilityError' && e.code === 'model_not_configured'
  );
});
