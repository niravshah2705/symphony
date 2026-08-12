'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { normalize } = require('./normalizer');
const { readPlugin, readVendoredSkill } = require('./native-reader');

const FIXTURE_MP = path.join(__dirname, '__fixtures__', 'marketplace');
const VENDORED = path.join(__dirname, '__fixtures__', 'vendored-skills');

function build() {
  const raw = [
    readVendoredSkill(VENDORED, 'web-research'),
    readPlugin(FIXTURE_MP, {
      name: 'security', marketplace: 'test-marketplace', version: '1.6.2',
      ref: 'abc1234', sourceRepo: 'test/marketplace', sourceUrl: null,
    }),
  ];
  return normalize(raw, { version: 'v1' });
}

test('normalize emits schema header and sorted entries', () => {
  const reg = build();
  assert.equal(reg.schemaVersion, 'registry/v1');
  assert.equal(reg.version, 'v1');
  const ids = reg.entries.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b, 'en')));
});

test('promotes plugin-provided skills to namespaced entries linked from the plugin', () => {
  const reg = build();
  const ids = new Set(reg.entries.map((e) => e.id));
  assert.ok(ids.has('skill:web-research'));            // vendored, bare name
  assert.ok(ids.has('skill:security__raven'));         // plugin-provided, namespaced
  assert.ok(ids.has('skill:security__tribal-knowledge'));
  assert.ok(ids.has('plugin:security@test-marketplace'));
  assert.ok(ids.has('mcpServer:security-scanner'));

  const plugin = reg.entries.find((e) => e.id === 'plugin:security@test-marketplace');
  assert.deepEqual(plugin.payload.provides.skills.sort(),
    ['skill:security__raven', 'skill:security__tribal-knowledge']);
  assert.ok(plugin.payload.provides.mcpServers.includes('mcpServer:security-scanner'));
  assert.equal(plugin.version.normalized, '1.6.2');
  assert.equal(plugin.version.scheme, 'semver');
  assert.deepEqual(plugin.adapters['claude-code'], { pluginKey: 'security@test-marketplace' });
});

test('a plugin-provided skill records its harness invocation namespace + source dir', () => {
  const reg = build();
  const raven = reg.entries.find((e) => e.id === 'skill:security__raven');
  assert.equal(raven.adapters['claude-code'].skill, 'security:raven'); // <plugin>:<skill>
  assert.equal(raven.adapters.deepagent.name, 'security__raven');
  assert.deepEqual(raven.capabilities.allowedTools, ['Bash', 'Read', 'Grep']);
  assert.ok(raven.payload.sourceDir.endsWith(path.join('skills', 'raven')));
  assert.equal(raven.payload.path, 'skills/security__raven');
});

test('captures pre and post hooks from the plugin', () => {
  const reg = build();
  const hooks = reg.entries.filter((e) => e.kind === 'hook');
  const events = hooks.map((h) => h.payload.event).sort();
  assert.ok(events.includes('pre'));
  assert.ok(events.includes('post'));
  for (const h of hooks) assert.equal(h.payload.providedByPlugin, 'plugin:security@test-marketplace');
});

test('merges two provenance records for the same plugin and flags version conflict', () => {
  const a = readPlugin(FIXTURE_MP, { name: 'security', marketplace: 'test-marketplace', version: '1.6.2', ref: 'r1', sourceRepo: 'test/marketplace' });
  const b = readPlugin(FIXTURE_MP, { name: 'security', marketplace: 'test-marketplace', version: '1.6.2', ref: 'r2', sourceRepo: 'test/marketplace' });
  // Force a differing raw version on b to exercise conflict detection.
  b.version = 'unknown';
  const reg = normalize([a, b], { version: 'v1' });
  const plugin = reg.entries.find((e) => e.id === 'plugin:security@test-marketplace');
  assert.equal(plugin.provenance.length, 2);
  assert.equal(plugin.version.normalized, '1.6.2'); // semver beats unknown
  assert.equal(plugin.version.conflict, true);
});
