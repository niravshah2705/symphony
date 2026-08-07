'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate the JSON store to a temp dir BEFORE requiring config/store — DATA_DIR is
// resolved from this env var at module load. Never touch the real data/store.json
// (it holds live secrets).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'store-stack-links-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;

const store = require('./store');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

test('a fresh store has an empty stackLinks collection', () => {
  assert.deepEqual(store.DEFAULT_STORE.stackLinks, []);
  assert.deepEqual(store.listStackLinks(), []);
});

test('addStackLink stamps a stk_ id + createdAt and persists the record', () => {
  const rec = store.addStackLink({
    projectId: 'proj_1',
    provider: 'github',
    repoFullName: 'acme/app',
    dependentBranch: 'eng-2',
    blockerBranch: 'eng-1',
    blockerIdentifier: 'ENG-1',
    defaultBase: 'main',
  });
  assert.match(rec.id, /^stk_[0-9a-f-]{36}$/);
  assert.ok(rec.createdAt);
  assert.equal(rec.resolvedAt, null);
  assert.equal(store.listStackLinks().find((l) => l.id === rec.id).blockerBranch, 'eng-1');
});

test('updateStackLink patches immutably and returns null for a missing id', () => {
  const rec = store.addStackLink({ dependentBranch: 'eng-3', blockerBranch: 'eng-1', defaultBase: 'main' });
  const updated = store.updateStackLink(rec.id, { dependentReviewId: 42, dependentReviewUrl: 'https://x/42' });
  assert.equal(updated.id, rec.id);
  assert.equal(updated.dependentReviewId, 42);
  assert.equal(updated.dependentReviewUrl, 'https://x/42');
  assert.equal(store.updateStackLink('stk_missing', { dependentReviewId: 1 }), null);
});

test('removeStackLink drops the link and reports whether one was removed', () => {
  const rec = store.addStackLink({ dependentBranch: 'eng-4', blockerBranch: 'eng-1', defaultBase: 'main' });
  assert.equal(store.removeStackLink(rec.id), true);
  assert.equal(store.listStackLinks().some((l) => l.id === rec.id), false);
  assert.equal(store.removeStackLink(rec.id), false);
});
