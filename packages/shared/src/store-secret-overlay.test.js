'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'store-secret-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;

const store = require('./store');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test('environment secrets override stored settings (Secret Manager precedence)', () => {
  store.setApiKey('stored-linear');
  assert.equal(store.getApiKey(), 'stored-linear');

  process.env.LINEAR_API_KEY = 'env-linear';
  try {
    assert.equal(store.getApiKey(), 'env-linear');
    assert.equal(store.getSettings().linearApiKey, 'env-linear');
  } finally {
    delete process.env.LINEAR_API_KEY;
  }
  // Falls back to the stored value once the env secret is gone.
  assert.equal(store.getApiKey(), 'stored-linear');
});

test('GitHub token prefers the environment secret over the stored one', () => {
  store.setGithubToken('stored-gh');
  process.env.GITHUB_TOKEN = 'env-gh';
  try {
    assert.equal(store.getGithubToken(), 'env-gh');
    assert.equal(store.getRepositoryToken('github'), 'env-gh');
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
  assert.equal(store.getGithubToken(), 'stored-gh');
});
