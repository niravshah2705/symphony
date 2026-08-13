'use strict';

// Point the store at a scratch data dir BEFORE requiring config/store so this
// test never reads or writes the real data/store.json (which holds secrets).
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fleet-store-'));
process.env.AI_FLEET_DATA_DIR = tmpDir;

const { CONFIG } = require('../config');
const { readStore } = require('../store');
const { MODEL_ROLES } = require('./model-presets');

// Hard guard: refuse to run if the store did not resolve into the scratch dir
// (e.g. config was already cached), so we can never clobber the real store.
assert.ok(CONFIG.STORE_FILE.startsWith(tmpDir), 'store must resolve inside the scratch dir');

function writeLegacyStore(settings) {
  fs.writeFileSync(CONFIG.STORE_FILE, JSON.stringify({ settings }), 'utf8');
}

test('readStore seeds purpose model roles from a legacy store that predates them', () => {
  writeLegacyStore({ llmProvider: 'claude', hostedLlmPresetId: 'claude-opus-4-8', claudeModel: 'claude-opus-4-8' });
  const store = readStore();
  for (const role of MODEL_ROLES) {
    assert.equal(store.settings[`${role}LlmProvider`], 'claude', `${role} provider`);
    assert.equal(store.settings[`${role}LlmPresetId`], 'claude-opus-4-8', `${role} preset`);
  }
});

test('readStore preserves explicitly-configured purpose roles', () => {
  writeLegacyStore({
    llmProvider: 'claude',
    hostedLlmPresetId: 'claude-opus-4-8',
    thinkingLlmProvider: 'codex',
    thinkingLlmPresetId: 'codex-gpt-5-6-sol',
    executionLlmProvider: 'ollama',
    executionLlmPresetId: 'ollama-qwen3-coder-30b',
    testingLlmProvider: 'lmstudio',
    testingLlmPresetId: 'custom',
    deploymentLlmProvider: 'claude',
    deploymentLlmPresetId: 'claude-haiku-4-5',
  });
  const store = readStore();
  assert.equal(store.settings.thinkingLlmProvider, 'codex');
  assert.equal(store.settings.thinkingLlmPresetId, 'codex-gpt-5-6-sol');
  assert.equal(store.settings.executionLlmProvider, 'ollama');
  assert.equal(store.settings.executionLlmPresetId, 'ollama-qwen3-coder-30b');
  assert.equal(store.settings.testingLlmProvider, 'lmstudio');
  assert.equal(store.settings.deploymentLlmProvider, 'claude');
  assert.equal(store.settings.deploymentLlmPresetId, 'claude-haiku-4-5');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
