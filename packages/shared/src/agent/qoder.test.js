'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('node:child_process');

const llm = require('./llm');
const mp = require('./model-presets');
const availability = require('./availability');
const { CONFIG } = require('../config');

const SETTINGS = {
  thinkingLlmProvider: 'qoder',
  qoderAccessToken: 'qoder_pat_secret',
  qoderModel: 'performance',
  qoderContextWindow: 200000,
  qoderMaxTokens: 32768,
};

// config.js reads EGRESS_PROXY_URL once at module load, so the proxied deployment
// mode is asserted in its own subprocess (the pattern used by egress-wiring.test.js).
function resolveProxied(settings) {
  const script = `
    const { resolveLlm, llmReady, notReadyReason } = require('./src/agent/llm');
    const settings = ${JSON.stringify(settings)};
    (async () => {
      const d = await resolveLlm(settings, 'thinking');
      console.log(JSON.stringify({
        accessToken: d.accessToken,
        ready: llmReady(settings, 'thinking'),
        reason: notReadyReason(settings, 'thinking'),
      }));
    })();
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, EGRESS_PROXY_URL: 'http://127.0.0.1:4030' },
    encoding: 'utf8',
  }).trim());
}

test('config exposes qoder as a hosted harness-only provider', () => {
  assert.equal(CONFIG.LLM_PROVIDERS.includes('qoder'), true);
  assert.equal(mp.PROVIDER_DEPLOYMENT.qoder, 'hosted');
  assert.equal(CONFIG.QODER.defaultModel, process.env.QODER_MODEL || 'auto');
  assert.equal(CONFIG.QODER.accessTokenEnvVar, 'QODER_PERSONAL_ACCESS_TOKEN');
});

test('resolveLlm builds a credential-carrying Qoder descriptor with no endpoint', async () => {
  const d = await llm.resolveLlm(SETTINGS, 'thinking');
  assert.equal(d.provider, 'qoder');
  assert.equal(d.accessToken, 'qoder_pat_secret');
  assert.equal(d.model, 'performance');
  assert.equal(d.baseUrl, undefined);
  assert.equal(d.host, undefined);
  assert.equal(d.cliPath, CONFIG.QODER.cliPath);
  assert.equal(d.contextWindow, 200000);
  assert.equal(d.numTokens, 32768);
});

test('resolveLlm falls back to the config-driven Qoder model default', async () => {
  const d = await llm.resolveLlm({ ...SETTINGS, qoderModel: '' }, 'thinking');
  assert.equal(d.model, CONFIG.QODER.defaultModel);
});

test('llmReady needs the personal access token; DeepAgent rejects the Qoder slot', async () => {
  assert.equal(llm.llmReady(SETTINGS, 'thinking'), true);
  assert.equal(llm.llmReady({ ...SETTINGS, qoderAccessToken: '' }, 'thinking'), false);
  assert.match(llm.notReadyReason({ thinkingLlmProvider: 'qoder' }, 'thinking'), /Personal Access Token/);
  const d = await llm.resolveLlm(SETTINGS, 'thinking');
  assert.throws(() => llm.createChatModel(d, {}), /harness-only/);
});

test('the Qoder harness fails closed when the egress sidecar is armed', () => {
  const out = resolveProxied(SETTINGS);
  // The sidecar cannot broker qodercli, so the descriptor stays credential-free.
  assert.equal(out.accessToken, '');
  assert.equal(out.ready, false);
  assert.match(out.reason, /egress sidecar|proxy mode/i);
});

test('catalog exposes hosted Qoder presets and maps params to qoder* settings', () => {
  mp.validateCatalog(mp.publicCatalog());
  const presets = mp.publicCatalog().presets.filter((p) => p.provider === 'qoder');
  assert.ok(presets.length >= 1);
  assert.equal(presets.filter((p) => p.recommended).length, 1);
  const patch = mp.settingsPatchForPreset(presets.find((p) => p.recommended));
  assert.equal(patch.qoderModel, 'auto');
  assert.ok(Number.isInteger(patch.qoderMaxTokens));
  assert.equal(Object.hasOwn(patch, 'qoderTemperature'), false);
  const custom = mp.customPresetForSettings('qoder', { qoderModel: 'performance' });
  assert.equal(custom.deployment, 'hosted');
  assert.equal(custom.model, 'performance');
});

test('availability reports the harness run instead of probing an endpoint', async () => {
  const d = await llm.resolveLlm(SETTINGS, 'thinking');
  const probe = await availability.probeModelAvailability(d, {
    fetchImpl: async () => {
      throw new Error('the Qoder provider must not issue an HTTP probe');
    },
  });
  assert.deepEqual(probe, { available: true, provider: 'qoder', model: 'performance' });
  const missing = await llm.resolveLlm({ ...SETTINGS, qoderAccessToken: '' }, 'thinking');
  await assert.rejects(
    () => availability.probeModelAvailability(missing, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }),
    (error) => error.name === 'AgentAvailabilityError' && error.code === 'model_not_configured'
  );
});
