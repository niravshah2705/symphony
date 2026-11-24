'use strict';

// Isolate the store on a throwaway data dir BEFORE requiring it: the backend is
// bound at module load from CONFIG (file backend + SOFTWARE_FACTORY_DATA_DIR).
const os = require('node:os');
const fs = require('node:fs');

process.env.STORE_BACKEND = 'file';
process.env.SOFTWARE_FACTORY_DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/workflow-store-');

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('./store.js');

test('normalizeStore seeds the workflow designer v2 collections', () => {
  const normalized = store.normalizeStore({});
  assert.deepEqual(normalized.workflows, []);
  assert.deepEqual(normalized.agents, []);
  assert.deepEqual(normalized.personaGrants, []);
  assert.deepEqual(normalized.userProfiles, {});
  assert.equal(normalized.workflowGraphsSeededAt, null);
});

test('normalizeStore keeps stored workflow records and coerces junk to safe shapes', () => {
  const normalized = store.normalizeStore({
    workflows: [{ id: 'w1', name: 'Flow' }],
    agents: 'not-an-array',
    personaGrants: [{ id: 'grant-builder', persona: 'builder', allowedCategories: ['Coding'] }],
    userProfiles: {
      'uid-1': { persona: 'builder', displayName: 'Nirav', extra: 'dropped?' },
      'uid-2': 'junk',
      '': { persona: 'sre' },
    },
  });
  assert.deepEqual(normalized.workflows, [{ id: 'w1', name: 'Flow' }]);
  assert.deepEqual(normalized.agents, []);
  assert.equal(normalized.personaGrants.length, 1);
  assert.deepEqual(normalized.userProfiles, { 'uid-1': { persona: 'builder', displayName: 'Nirav' } });
});

test('workflow collections shard per-record like the other collection keys', () => {
  for (const key of ['workflows', 'agents', 'personaGrants']) {
    assert.ok(store.STORE_COLLECTION_KEYS.includes(key), `${key} must be a collection key`);
  }
  assert.ok(store.STORE_MAIN_KEYS.includes('userProfiles'));
  // The seed marker lives in the main document: a key the backend does not
  // list is a key that silently never persists, and every tenant would
  // re-seed on the next deploy.
  assert.ok(store.STORE_MAIN_KEYS.includes('workflowGraphsSeededAt'));
});

test('the seed marker survives a round trip and junk reads as never-seeded', () => {
  const stamp = '2026-11-18T00:00:00.000Z';
  assert.equal(store.normalizeStore({ workflowGraphsSeededAt: stamp }).workflowGraphsSeededAt, stamp);
  assert.equal(store.normalizeStore({ workflowGraphsSeededAt: 1731859200000 }).workflowGraphsSeededAt, null);
  assert.equal(store.normalizeStore({ workflowGraphsSeededAt: {} }).workflowGraphsSeededAt, null);
});
