'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  KINDS,
  assertSafePathSegment,
  isSafePathSegment,
  dedupeKey,
  normalizeVersion,
  reconcileVersions,
  makeEntry,
} = require('./schema');

test('assertSafePathSegment rejects traversal and separators', () => {
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../x', 'a b', 'foo$bar']) {
    assert.throws(() => assertSafePathSegment(bad), /Unsafe/, `should reject ${JSON.stringify(bad)}`);
    assert.equal(isSafePathSegment(bad), false);
  }
  for (const ok of ['web-research', 'security', '1.6.2', 'v1', 'a_b.c-1']) {
    assert.equal(assertSafePathSegment(ok), ok);
    assert.equal(isSafePathSegment(ok), true);
  }
});

test('dedupeKey keys plugins by name@marketplace and others by name', () => {
  assert.equal(dedupeKey(KINDS.SKILL, 'web-research'), 'skill:web-research');
  assert.equal(dedupeKey(KINDS.HOOK, 'pre-commit'), 'hook:pre-commit');
  assert.equal(dedupeKey(KINDS.MCP_SERVER, 'playwright'), 'mcpServer:playwright');
  assert.equal(dedupeKey(KINDS.PLUGIN, 'security', 'uipath-claude-marketplace'),
    'plugin:security@uipath-claude-marketplace');
  assert.throws(() => dedupeKey(KINDS.PLUGIN, 'security'), /needs a marketplace/);
  assert.throws(() => dedupeKey('bogus', 'x'), /Unknown kind/);
});

test('normalizeVersion classifies semver / gitsha / integer / unknown', () => {
  assert.deepEqual(normalizeVersion('1.6.2'), { normalized: '1.6.2', scheme: 'semver', raw: '1.6.2' });
  assert.deepEqual(normalizeVersion('v2.0.0-rc.1'),
    { normalized: '2.0.0-rc.1', scheme: 'semver', raw: 'v2.0.0-rc.1' });
  assert.equal(normalizeVersion('2593e3cb90719bcc7cf8ddeb557b01fe95a92dfc').scheme, 'gitsha');
  assert.equal(normalizeVersion('2593e3cb90719bcc7cf8ddeb557b01fe95a92dfc').normalized, '0.0.0-git.2593e3c');
  assert.deepEqual(normalizeVersion(1), { normalized: '0.0.0-int.1', scheme: 'integer', raw: '1' });
  for (const unk of ['latest', 'unknown', '', null, undefined, 'local']) {
    assert.equal(normalizeVersion(unk).scheme, 'unknown');
  }
});

test('reconcileVersions picks the highest-rank scheme and flags conflicts', () => {
  const picked = reconcileVersions([
    normalizeVersion('unknown'),
    normalizeVersion('1.6.2'),
  ]);
  assert.equal(picked.scheme, 'semver');
  assert.equal(picked.normalized, '1.6.2');
  assert.equal(picked.conflict, true);

  const same = reconcileVersions([normalizeVersion('1.0.0'), normalizeVersion('1.0.0')]);
  assert.equal(same.conflict, false);

  const empty = reconcileVersions([]);
  assert.equal(empty.scheme, 'unknown');
  assert.equal(empty.conflict, false);

  const twoSemver = reconcileVersions([normalizeVersion('1.2.0'), normalizeVersion('1.10.0')]);
  assert.equal(twoSemver.normalized, '1.10.0'); // numeric-aware compare, not lexical
});

test('makeEntry builds an immutable-friendly entry with derived id', () => {
  const before = { name: 'security', extra: 1 };
  const entry = makeEntry({
    kind: KINDS.PLUGIN,
    name: 'security',
    marketplace: 'uipath-claude-marketplace',
    description: 'RAVEN',
    version: normalizeVersion('1.6.2'),
    provenance: [{ marketplace: 'uipath-claude-marketplace', rawVersion: '1.6.2' }],
    payload: { path: 'plugins/x' },
  });
  assert.equal(entry.id, 'plugin:security@uipath-claude-marketplace');
  assert.equal(entry.dedupeKey, entry.id);
  assert.equal(entry.version.normalized, '1.6.2');
  assert.equal(entry.version.conflict, false);
  assert.equal(entry.incomplete, false);
  assert.equal(before.extra, 1); // inputs not mutated
  assert.throws(() => makeEntry({ kind: KINDS.SKILL, name: '../evil' }), /Unsafe/);
});
