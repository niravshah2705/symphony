'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate the store backend to a throwaway data dir before requiring the module
// (the real data/store.json holds live secrets and must never be touched).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'store-byom-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;

const { normalizeStore, DEFAULT_STORE } = require('./store');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test('normalizeStore migrates the legacy localLlm* slot keys into byom*', () => {
  const { settings } = normalizeStore({
    settings: { localLlmProvider: 'lmstudio', localLlmPresetId: 'lmstudio-gpt-oss-20b' },
  });
  // Legacy values are carried over to the new keys...
  assert.equal(settings.byomProvider, 'lmstudio');
  assert.equal(settings.byomPresetId, 'lmstudio-gpt-oss-20b');
  // ...and the stale keys are dropped so the store carries only the new schema.
  assert.equal(Object.prototype.hasOwnProperty.call(settings, 'localLlmProvider'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(settings, 'localLlmPresetId'), false);
});

test('normalizeStore migrates a legacy localActiveModel into byomActiveModel', () => {
  const { settings } = normalizeStore({ settings: { localActiveModel: 'my-local-model' } });
  assert.equal(settings.byomActiveModel, 'my-local-model');
  assert.equal(Object.prototype.hasOwnProperty.call(settings, 'localActiveModel'), false);
});

test('a new byom* value wins over a legacy localLlm* value and the legacy key is dropped', () => {
  const { settings } = normalizeStore({
    settings: { byomProvider: 'omlx', localLlmProvider: 'lmstudio' },
  });
  assert.equal(settings.byomProvider, 'omlx');
  assert.equal(Object.prototype.hasOwnProperty.call(settings, 'localLlmProvider'), false);
});

test('a pre-rename store with only localLlmPresetId keeps that preset (not "custom")', () => {
  const { settings } = normalizeStore({ settings: { localLlmPresetId: 'omlx-gpt-oss-20b' } });
  assert.equal(settings.byomPresetId, 'omlx-gpt-oss-20b');
});

test('a legacy store missing both preset-id keys falls back to the "custom" byom preset', () => {
  const { settings } = normalizeStore({ settings: {} });
  assert.equal(settings.byomPresetId, 'custom');
  // A fresh install still seeds the catalog default byom provider.
  assert.equal(settings.byomProvider, DEFAULT_STORE.settings.byomProvider);
});
