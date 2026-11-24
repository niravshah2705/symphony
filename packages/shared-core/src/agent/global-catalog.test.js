'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRuntimeCsv, currentRuntimes, packSource, globalCatalog } = require('./global-catalog');

const CSV = [
  'runtime,dockerfile,image,version,amd64_sha256,arm64_sha256,current',
  'claude,go/harness/claude/Dockerfile,ghcr.io/x/claude-runtime,2.1.326,,,true',
  'claude,go/harness/claude/Dockerfile,ghcr.io/x/claude-runtime,2.1.325,,,false',
  'goose,go/harness/goose/Dockerfile,ghcr.io/x/goose-runtime,1.60.1,,,true',
  '',
].join('\n');

test('only the current row per runtime survives the CSV parse', () => {
  const rows = parseRuntimeCsv(CSV);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.filter((row) => row.current).map((row) => row.runtime), ['claude', 'goose']);
});

test('a missing runtime CSV degrades to an empty list, not a crash', () => {
  assert.deepEqual(currentRuntimes('/nonexistent/runtime-images.csv'), []);
});

test('packSource pins only published digests', () => {
  const digest = 'a'.repeat(64);
  assert.deepEqual(packSource({ image: 'ghcr.io/x/ecc-plugin', digest }), { oci: `ghcr.io/x/ecc-plugin@sha256:${digest}` });
  assert.deepEqual(packSource({ image: `ghcr.io/x/ecc-plugin@sha256:${digest}`, digest: null }), { oci: `ghcr.io/x/ecc-plugin@sha256:${digest}` });
  assert.equal(packSource({ image: 'ghcr.io/x/ecc-plugin', digest: null }), null);
  assert.equal(packSource({ image: 'ghcr.io/x/ecc-plugin', digest: 'not-a-digest' }), null);
});

test('the catalog serves the model-family registry to the designer', () => {
  const catalog = globalCatalog();
  assert.deepEqual(catalog.modelFamilyProblems, [], 'the family registry has record problems');
  const orders = catalog.modelFamilies.map((family) => family.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'the designer lists families in file order');
  const anthropic = catalog.modelFamilies.find((family) => family.id === 'anthropic');
  assert.deepEqual(anthropic.providers, ['claude'], 'the provider list is what filters the Model dropdown');
  assert.equal(anthropic.icon, 'anthropic', 'the card icon travels with the record, not a browser map');
  for (const family of catalog.modelFamilies) {
    assert.equal(typeof family.enabled, 'boolean', `${family.id} must say whether it is selectable`);
  }
});

test('the shipped catalogs carry AgentCard tags through', () => {
  const catalog = globalCatalog();
  assert.ok(catalog.harnesses.length >= 10);
  const ecc = catalog.plugins.find((row) => row.id === 'ecc');
  assert.ok(ecc && ecc.tags.includes('coding'));
  const audit = catalog.skills.find((row) => row.id === 'security-audit');
  assert.ok(audit && audit.tags.includes('security'));
  assert.ok(audit.source.oci.startsWith('ghcr.io/'));
});
