'use strict';

// Isolate the store on a throwaway data dir BEFORE requiring it: the backend is
// bound at module load from CONFIG (file backend + AI_FLEET_DATA_DIR).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.STORE_BACKEND = 'file';
process.env.AI_FLEET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eula-store-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('./store');

test('normalizeStore seeds an empty eula section', () => {
  const normalized = store.normalizeStore({});
  assert.deepEqual(normalized.eula, { users: {}, orgs: {} });
});

test('normalizeStore coerces malformed eula shapes and preserves records', () => {
  assert.deepEqual(store.normalizeStore({ eula: 'nope' }).eula, { users: {}, orgs: {} });
  assert.deepEqual(store.normalizeStore({ eula: { users: [], orgs: null } }).eula, { users: {}, orgs: {} });
  const kept = store.normalizeStore({ eula: { users: { 'user:a': { status: 'accepted', version: '1.0.0' } }, orgs: {} } });
  assert.equal(kept.eula.users['user:a'].status, 'accepted');
});

test('getEulaUser is null before any decision', () => {
  assert.equal(store.getEulaUser('user:none'), null);
});

test('recordEulaDecision persists an accepted record and stamps a timestamp', () => {
  const entry = store.recordEulaDecision('user:alice', { status: 'accepted', version: '1.0.0' });
  assert.equal(entry.status, 'accepted');
  assert.equal(entry.version, '1.0.0');
  assert.equal(entry.via, 'user');
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
  const read = store.getEulaUser('user:alice');
  assert.equal(read.status, 'accepted');
  assert.equal(read.version, '1.0.0');
});

test('a later decision overwrites the earlier one for the same key', () => {
  store.recordEulaDecision('user:bob', { status: 'accepted', version: '1.0.0' });
  store.recordEulaDecision('user:bob', { status: 'rejected', version: '1.0.0' });
  assert.equal(store.getEulaUser('user:bob').status, 'rejected');
});

test('per-user records are independent', () => {
  store.recordEulaDecision('user:carol', { status: 'accepted', version: '1.0.0' });
  store.recordEulaDecision('user:dave', { status: 'rejected', version: '1.0.0' });
  assert.equal(store.getEulaUser('user:carol').status, 'accepted');
  assert.equal(store.getEulaUser('user:dave').status, 'rejected');
});

test('organisation-scope decisions are recorded separately from user scope', () => {
  assert.equal(store.getEulaOrg('org:acme'), null);
  const entry = store.recordEulaOrgDecision('org:acme', { status: 'accepted', version: '1.0.0' });
  assert.equal(entry.via, 'org');
  assert.equal(store.getEulaOrg('org:acme').status, 'accepted');
  // Writing an org record does not leak into the user map.
  assert.equal(store.getEulaUser('org:acme'), null);
});

test('eula records survive a normalize round-trip (persistence shape is stable)', () => {
  store.recordEulaDecision('user:erin', { status: 'accepted', version: '1.0.0' });
  const round = store.normalizeStore(store.readStore());
  assert.equal(round.eula.users['user:erin'].status, 'accepted');
});
