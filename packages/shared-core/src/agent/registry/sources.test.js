'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSources } = require('./sources');
const { HARNESS_STRATEGIES } = require('./schema');

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

const VALID_V2 = {
  schemaVersion: 'harness-registry/v2',
  version: 'v1',
  marketplaces: {
    ecc: {
      url: 'https://github.com/affaan-m/ECC.git',
      trackRef: 'main',
      versionRange: '2.2.x',
    },
  },
  harnessStrategies: HARNESS_STRATEGIES,
  skills: [],
  plugins: [{ name: 'ecc', marketplace: 'ecc', version: '2.2.x' }],
  hooks: [],
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

test('loads v2 canonical ECC tracking metadata and complete harness strategies', () => {
  const parsed = loadSources(writeTmp(VALID_V2));
  assert.equal(parsed.schemaVersion, 'harness-registry/v2');
  assert.deepEqual(parsed.source, {
    id: 'ecc',
    repository: 'affaan-m/ECC',
    url: 'https://github.com/affaan-m/ECC.git',
    trackRef: 'main',
    versionRange: '2.2.x',
  });
  assert.deepEqual(parsed.harnessStrategies, HARNESS_STRATEGIES);
  assert.equal(parsed.marketplaces.ecc.ref, null);
});

test('v2 rejects incomplete strategy coverage and non-canonical ECC sources', () => {
  const missing = { ...HARNESS_STRATEGIES };
  delete missing.deepseek;
  assert.throws(
    () => loadSources(writeTmp({ ...VALID_V2, harnessStrategies: missing })),
    /missing: deepseek/
  );

  const oldRepo = {
    ...VALID_V2,
    marketplaces: {
      ecc: {
        url: 'https://github.com/affaan-m/everything-claude-code.git',
        trackRef: 'main',
        versionRange: '2.2.x',
      },
    },
  };
  assert.throws(() => loadSources(writeTmp(oldRepo)), /source.url/);
});

test('repository sources.json uses the v2 ECC contract', () => {
  const parsed = loadSources(path.join(__dirname, 'sources.json'));
  assert.equal(parsed.schemaVersion, 'harness-registry/v2');
  assert.equal(parsed.source.repository, 'affaan-m/ECC');
  assert.equal(parsed.source.versionRange, '2.2.x');
  assert.deepEqual(parsed.harnessStrategies, HARNESS_STRATEGIES);
});
