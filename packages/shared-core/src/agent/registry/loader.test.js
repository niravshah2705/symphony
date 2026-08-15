'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveRegistrySrc,
  resolveHarnessRegistryDir,
  registrySkillsDir,
  loadRegistryManifest,
  selectForRuntime,
  loadHarnessRegistry,
  selectArtifactDescriptor,
  loadArtifactDescriptor,
} = require('./loader');
const {
  HARNESS_REGISTRY_SCHEMA_VERSION,
  HARNESS_IDS,
  HARNESS_STRATEGIES,
  expectedArtifactPath,
  expectedDescriptorPath,
} = require('./schema');
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

const RESOLVED_SOURCE = Object.freeze({
  id: 'ecc',
  repository: 'affaan-m/ECC',
  url: 'https://github.com/affaan-m/ECC.git',
  trackRef: 'main',
  versionRange: '2.2.x',
  resolvedCommit: 'a'.repeat(40),
  version: '2.2.0',
});

function buildArtifactRegistry() {
  const versionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-loader-')));
  const rows = HARNESS_IDS.map((id) => ({
    id,
    strategy: HARNESS_STRATEGIES[id],
    descriptorPath: expectedDescriptorPath(id),
    artifactPath: expectedArtifactPath(id),
    sha256: 'b'.repeat(64),
    sizeBytes: 123,
  }));
  const index = {
    schemaVersion: HARNESS_REGISTRY_SCHEMA_VERSION,
    version: 'v1',
    source: RESOLVED_SOURCE,
    harnesses: rows,
    inert: [],
  };
  fs.writeFileSync(path.join(versionDir, 'registry.json'), JSON.stringify(index));

  const descriptorDir = path.join(versionDir, 'harnesses', 'deepagent');
  fs.mkdirSync(descriptorDir, { recursive: true });
  fs.writeFileSync(path.join(descriptorDir, 'artifact.json'), JSON.stringify({
    schemaVersion: HARNESS_REGISTRY_SCHEMA_VERSION,
    harnessId: 'deepagent',
    strategy: 'dcode-plugin',
    source: RESOLVED_SOURCE,
    artifact: {
      path: 'harnesses/deepagent/rootfs.tar.gz',
      sha256: 'b'.repeat(64),
      sizeBytes: 123,
      fileCount: 7,
    },
    target: {
      platform: 'linux',
      arch: 'x64',
      mountPath: '/opt/ai-fleet/harnesses/deepagent',
      copyRoots: ['home', 'project'],
    },
    installer: { name: 'deepagents-code', version: '0.1.55' },
    compatibility: 'native-with-adapter',
    capabilities: {
      native: ['skills', 'mcp', 'hooks'],
      companion: ['commands-as-skills', 'subagents', 'instructions'],
    },
    limitations: ['DCode ignores native command and agent plugin directories.'],
  }));
  return { versionDir, index, descriptorDir };
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

test('resolveHarnessRegistryDir selects the v2 version root without activating it', () => {
  assert.equal(resolveHarnessRegistryDir({}), null);
  assert.equal(
    resolveHarnessRegistryDir({ REGISTRY_ROOT: '/registry', REGISTRY_VERSION: 'v1' }),
    path.join('/registry', 'v1')
  );
  assert.throws(
    () => resolveHarnessRegistryDir({ REGISTRY_ROOT: '/registry', REGISTRY_VERSION: '../evil' }),
    /Unsafe/
  );
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

test('v2 loader selects and validates the DCode artifact descriptor without reading its archive', () => {
  const { versionDir } = buildArtifactRegistry();
  const index = loadHarnessRegistry(versionDir);
  const selected = selectArtifactDescriptor(index, 'deepagent');
  assert.equal(selected.strategy, 'dcode-plugin');
  assert.equal(selected.artifactPath, 'harnesses/deepagent/rootfs.tar.gz');

  // No rootfs.tar.gz is created. Descriptor selection must not extract, mount,
  // execute, or even require access to the archive.
  const descriptor = loadArtifactDescriptor(versionDir, index, 'deepagent');
  assert.equal(descriptor.installer.name, 'deepagents-code');
  assert.deepEqual(descriptor.capabilities.companion,
    ['commands-as-skills', 'subagents', 'instructions']);
  assert.equal(selectArtifactDescriptor(index, 'unknown-harness'), null);
});

test('v2 loader rejects descriptor metadata that diverges from the published index', () => {
  const { versionDir, descriptorDir } = buildArtifactRegistry();
  const index = loadHarnessRegistry(versionDir);
  const file = path.join(descriptorDir, 'artifact.json');
  const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
  descriptor.artifact.sha256 = 'c'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(descriptor));
  assert.throws(
    () => loadArtifactDescriptor(versionDir, index, 'deepagent'),
    /archive metadata does not match/
  );
});
