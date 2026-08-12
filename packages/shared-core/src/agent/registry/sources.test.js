'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSources } = require('./sources');

function writeTmp(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sources-test-'));
  const file = path.join(dir, 'sources.json');
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}

const VALID = {
  version: 'v1',
  updatedAt: '2026-08-12',
  marketplaces: {
    'uipath-claude-marketplace': { repo: 'uipath/uipath-claude-marketplace', ref: 'abc1234' },
  },
  skills: [{ name: 'web-research', vendored: true }],
  plugins: [{ name: 'security', marketplace: 'uipath-claude-marketplace', version: '1.6.2' }],
  hooks: [{ name: 'pre-commit-scan', marketplace: 'uipath-claude-marketplace', event: 'pre' }],
};

test('loads and normalizes a valid manifest', () => {
  const parsed = loadSources(writeTmp(VALID));
  assert.equal(parsed.version, 'v1');
  assert.equal(parsed.plugins[0].version, '1.6.2');
  assert.equal(parsed.marketplaces['uipath-claude-marketplace'].url, null);
  assert.equal(parsed.hooks[0].event, 'pre');
});

test('rejects an unsafe version (becomes a GCS prefix)', () => {
  assert.throws(() => loadSources(writeTmp({ ...VALID, version: '../evil' })), /Unsafe/);
  assert.throws(() => loadSources(writeTmp({ ...VALID, version: 'a/b' })), /Unsafe/);
});

test('rejects a plugin referencing an unknown marketplace', () => {
  const bad = { ...VALID, plugins: [{ name: 'x', marketplace: 'nope', version: '1.0.0' }] };
  assert.throws(() => loadSources(writeTmp(bad)), /unknown marketplace/);
});

test('rejects a marketplace with no repo or url', () => {
  const bad = { ...VALID, marketplaces: { m: { ref: 'abc' } } };
  assert.throws(() => loadSources(writeTmp(bad)), /needs a "repo"/);
});

test('rejects a marketplace missing a pinned ref', () => {
  const bad = { ...VALID, marketplaces: { m: { repo: 'o/n' } } };
  assert.throws(() => loadSources(writeTmp(bad)), /pinned "ref"/);
});

test('rejects an invalid hook event', () => {
  const bad = { ...VALID, hooks: [{ name: 'h', event: 'sideways' }] };
  assert.throws(() => loadSources(writeTmp(bad)), /must be "pre" or "post"/);
});

test('rejects non-JSON', () => {
  assert.throws(() => loadSources(writeTmp('{not json')), /not valid JSON/);
});
