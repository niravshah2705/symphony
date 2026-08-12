'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveRegistrySrc,
  registrySkillsDir,
  loadRegistryManifest,
  selectForRuntime,
} = require('./loader');
const { writeBundle } = require('./bundle-writer');
const { normalize } = require('./normalizer');
const { readPlugin, readVendoredSkill } = require('./native-reader');

const FIXTURE_MP = path.join(__dirname, '__fixtures__', 'marketplace');
const VENDORED = path.join(__dirname, '__fixtures__', 'vendored-skills');

function buildBundle() {
  const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loader-')));
  const registry = normalize([
    readVendoredSkill(VENDORED, 'web-research'),
    readPlugin(FIXTURE_MP, {
      name: 'security', marketplace: 'test-marketplace', version: '1.6.2',
      ref: 'abc1234', sourceRepo: 'test/marketplace', sourceUrl: null,
    }),
  ], { version: 'v1' });
  writeBundle(registry, out, { generatedAt: 'x' });
  return path.join(out, 'v1', 'generic');
}

test('resolveRegistrySrc is null when REGISTRY_ROOT is unset', () => {
  assert.equal(resolveRegistrySrc({}), null);
});

test('resolveRegistrySrc joins root + version + generic and validates version', () => {
  assert.equal(resolveRegistrySrc({ REGISTRY_ROOT: '/registry' }), path.join('/registry', 'generic'));
  assert.equal(
    resolveRegistrySrc({ REGISTRY_ROOT: '/registry', REGISTRY_VERSION: 'v2' }),
    path.join('/registry', 'v2', 'generic')
  );
  assert.throws(() => resolveRegistrySrc({ REGISTRY_ROOT: '/r', REGISTRY_VERSION: '../evil' }), /Unsafe/);
});

test('loadRegistryManifest reads and validates registry.json', () => {
  const generic = buildBundle();
  const manifest = loadRegistryManifest(generic);
  assert.equal(manifest.schemaVersion, 'registry/v1');
  assert.ok(manifest.entries.length >= 5);
  assert.ok(fs.existsSync(path.join(registrySkillsDir(generic), 'web-research', 'SKILL.md')));
});

test('loadRegistryManifest rejects a wrong schema version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-bad-'));
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ schemaVersion: 'nope', entries: [] }));
  assert.throws(() => loadRegistryManifest(dir), /Unsupported registry schemaVersion/);
});

test('selectForRuntime resolves vendored + namespaced skills by name and adapter alias', () => {
  const manifest = loadRegistryManifest(buildBundle());

  // deepagent uses the generic (namespaced) name
  const dv = selectForRuntime(manifest, 'deepagent', { skills: ['web-research', 'security__raven'] });
  assert.deepEqual(dv.skills.map((s) => s.name).sort(), ['security__raven', 'web-research']);
  assert.deepEqual(dv.missing.skills, []);
  const raven = dv.skills.find((s) => s.name === 'security__raven');
  assert.equal(raven.path, 'skills/security__raven');

  // claudecode can ask by the plugin:skill alias
  const cc = selectForRuntime(manifest, 'claude-code', { skills: ['security:raven'] });
  assert.equal(cc.skills.length, 1);
  assert.equal(cc.skills[0].name, 'security__raven');
});

test('selectForRuntime resolves MCP servers and reports misses', () => {
  const manifest = loadRegistryManifest(buildBundle());
  const sel = selectForRuntime(manifest, 'deepagent', { skills: ['nope'], mcp: ['security-scanner', 'ghost'] });
  assert.equal(sel.mcp.length, 1);
  assert.equal(sel.mcp[0].name, 'security-scanner');
  assert.equal('env' in sel.mcp[0].descriptor, false);
  assert.deepEqual(sel.missing.skills, ['nope']);
  assert.deepEqual(sel.missing.mcp, ['ghost']);
});
