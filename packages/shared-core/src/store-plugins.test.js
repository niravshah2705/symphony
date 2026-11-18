'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate the JSON store to a temp dir BEFORE requiring config/store, and never
// touch the real data/store.json. The plugins collection is a mirror of the
// catalogs, so the behaviour worth pinning is that a re-seed is a no-op: boot
// seeds it on every start.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'store-plugins-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;

const store = require('./store');

const STORE_FILE = path.join(TMP_DIR, 'store.json');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

function record(overrides = {}) {
  return {
    id: 'ecc',
    kind: 'plugin',
    label: 'ECC',
    versions: [{ version: '2.2.3', commit: '3f14a103a869'.padEnd(40, '0') }],
    icon: { href: '/icons/plugins/ecc.svg' },
    skills: [{ name: 'tdd-workflow', enabled: true }],
    requirements: { dockerfile: ['RUN pip install --no-cache-dir uv'], appliedTo: 'go/harness/codex/Dockerfile' },
    promptAppend: 'Reach for tdd-workflow before writing an implementation.',
    ...overrides,
  };
}

test('a store written before the plugins collection existed reads as an empty one', () => {
  assert.deepEqual(store.listPlugins(), []);
  const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  delete raw.plugins;
  fs.writeFileSync(STORE_FILE, JSON.stringify(raw));
  assert.deepEqual(store.listPlugins(), []);
  // A mirror is not something to guess at: a non-array is a broken mirror, not data.
  fs.writeFileSync(STORE_FILE, JSON.stringify({ ...raw, plugins: 'ecc' }));
  assert.deepEqual(store.listPlugins(), []);
});

test('upsertPlugin keys the record by id and stamps the bookkeeping nobody else owns', () => {
  const saved = store.upsertPlugin(record());
  assert.equal(saved.id, 'ecc');
  assert.match(saved.createdAt, ISO_DATE);
  assert.match(saved.updatedAt, ISO_DATE);
  assert.equal(saved.revision, 1);
  assert.equal(store.listPlugins().length, 1);
  assert.equal(store.listPlugins()[0].promptAppend, record().promptAppend);

  // A record that arrives already stamped keeps its history: the seed is a
  // mirror, and re-importing one must not rewrite when the pack first landed.
  const restored = store.upsertPlugin(record({ id: 'restored', createdAt: '2026-11-01T00:00:00.000Z', revision: 4 }));
  assert.equal(restored.createdAt, '2026-11-01T00:00:00.000Z');
  assert.equal(restored.revision, 4);
  store.removePlugin('restored');
});

test('re-seeding an unchanged record neither rewrites it nor bumps the revision', () => {
  const before = store.upsertPlugin(record());
  const bytes = fs.readFileSync(STORE_FILE, 'utf8');
  const again = store.upsertPlugin(record({ updatedAt: '2020-01-01T00:00:00.000Z', revision: 7 }));
  assert.deepEqual(again, before);
  assert.equal(fs.readFileSync(STORE_FILE, 'utf8'), bytes, 'an unchanged seed must not write at all');

  const edited = store.upsertPlugin(record({ promptAppend: 'changed' }));
  assert.equal(edited.revision, 2);
  assert.equal(edited.createdAt, before.createdAt, 'createdAt belongs to the first write');
  assert.notEqual(fs.readFileSync(STORE_FILE, 'utf8'), bytes);
});

test('removePlugin reports whether a record went, so a seed can count removals', () => {
  store.upsertPlugin(record({ id: 'graphify', icon: { href: '/icons/plugins/graphify.svg' } }));
  assert.equal(store.listPlugins().length, 2);
  assert.equal(store.removePlugin('graphify'), true);
  assert.deepEqual(store.listPlugins().map((row) => row.id), ['ecc']);
  assert.equal(store.removePlugin('graphify'), false);
  assert.equal(store.removePlugin('never-there'), false);
});
