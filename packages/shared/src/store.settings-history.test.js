'use strict';

// Isolate the file backend to a temp dir BEFORE requiring the store, so these
// tests never read or write the real data/store.json.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.AI_FLEET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aifleet-store-'));
process.env.STORE_BACKEND = 'file';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_STORE,
  normalizeStore,
  addSettingsHistory,
  listSettingsHistory,
  MAX_SETTINGS_HISTORY,
} = require('./store');

test('DEFAULT_STORE seeds a custom complexity tier and empty history', () => {
  assert.equal(DEFAULT_STORE.settings.complexityTier, 'custom');
  assert.deepEqual(DEFAULT_STORE.settingsHistory, []);
});

test('normalizeStore migrates a legacy store: custom tier + empty history', () => {
  const normalized = normalizeStore({ settings: { llmProvider: 'claude' } });
  assert.equal(normalized.settings.complexityTier, 'custom');
  assert.deepEqual(normalized.settingsHistory, []);
});

test('normalizeStore preserves an explicitly stored tier and history', () => {
  const normalized = normalizeStore({
    settings: { complexityTier: 'balanced' },
    settingsHistory: [{ id: 'sh_1', ts: '2026-08-10T00:00:00.000Z', complexityTier: 'balanced' }],
  });
  assert.equal(normalized.settings.complexityTier, 'balanced');
  assert.equal(normalized.settingsHistory.length, 1);
});

test('addSettingsHistory appends newest-first with a generated id + ts', () => {
  const record = addSettingsHistory({ orgId: 'default', complexityTier: 'balanced', estMonthlyCostUsd: 12.5 });
  assert.match(record.id, /^sh_/);
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(record.complexityTier, 'balanced');
  const second = addSettingsHistory({ orgId: 'default', complexityTier: 'quick' });
  const history = listSettingsHistory();
  assert.equal(history[0].id, second.id, 'newest first');
  assert.equal(history[1].id, record.id);
});

test('addSettingsHistory caps the trail at MAX_SETTINGS_HISTORY', () => {
  for (let i = 0; i < MAX_SETTINGS_HISTORY + 5; i += 1) {
    addSettingsHistory({ orgId: 'default', complexityTier: 'quick', n: i });
  }
  assert.equal(listSettingsHistory().length, MAX_SETTINGS_HISTORY);
});
