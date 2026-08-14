'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HARNESS_REGISTRY_SCHEMA_VERSION,
  HARNESS_IDS,
  HARNESS_STRATEGIES,
  KINDS,
  assertSafePathSegment,
  isSafePathSegment,
  dedupeKey,
  normalizeVersion,
  reconcileVersions,
  makeEntry,
  validateHarnessStrategyMap,
  validateEccSource,
  validateArtifactDescriptor,
  validateHarnessRegistryIndex,
  expectedArtifactPath,
  expectedDescriptorPath,
} = require('./schema');

const RESOLVED_SOURCE = Object.freeze({
  id: 'ecc',
  repository: 'affaan-m/ECC',
  url: 'https://github.com/affaan-m/ECC.git',
  trackRef: 'main',
  versionRange: '2.2.x',
  resolvedCommit: 'a'.repeat(40),
  version: '2.2.0',
});

function artifactDescriptor(harnessId = 'deepagent') {
  return {
    schemaVersion: HARNESS_REGISTRY_SCHEMA_VERSION,
    harnessId,
    strategy: HARNESS_STRATEGIES[harnessId],
    source: RESOLVED_SOURCE,
    artifact: {
      path: expectedArtifactPath(harnessId),
      sha256: 'b'.repeat(64),
      sizeBytes: 123,
      fileCount: 7,
    },
    target: {
      platform: 'linux',
      arch: 'x64',
      mountPath: `/opt/ai-fleet/harnesses/${harnessId}`,
      copyRoots: ['home', 'project'],
    },
    installer: { name: harnessId === 'deepagent' ? 'deepagents-code' : 'ecc', version: '2.2.0' },
    compatibility: harnessId === 'deepagent' ? 'native-with-adapter' : 'native',
    capabilities: {
      native: ['skills', 'mcp', 'hooks'],
      companion: harnessId === 'deepagent'
        ? ['commands-as-skills', 'subagents', 'instructions']
        : [],
    },
    limitations: [],
  };
}

function harnessIndex() {
  return {
    schemaVersion: HARNESS_REGISTRY_SCHEMA_VERSION,
    version: 'v1',
    generatedAt: '2026-08-13T00:00:00Z',
    source: RESOLVED_SOURCE,
    harnesses: HARNESS_IDS.map((id) => ({
      id,
      strategy: HARNESS_STRATEGIES[id],
      descriptorPath: expectedDescriptorPath(id),
      artifactPath: expectedArtifactPath(id),
      sha256: 'b'.repeat(64),
      sizeBytes: 123,
    })),
    inert: [{ name: 'playwright', reason: 'not selected for activation' }],
  };
}

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

test('v2 strategy map covers every harness catalog id with an explicit strategy', () => {
  assert.deepEqual(validateHarnessStrategyMap(HARNESS_STRATEGIES), HARNESS_STRATEGIES);
  const missing = { ...HARNESS_STRATEGIES };
  delete missing.deepagent;
  assert.throws(() => validateHarnessStrategyMap(missing), /missing: deepagent/);
  assert.throws(
    () => validateHarnessStrategyMap({ ...HARNESS_STRATEGIES, deepagent: 'skills-only' }),
    /dcode-plugin/
  );
});

test('v2 source provenance requires canonical ECC and an immutable 2.2.x resolution', () => {
  assert.deepEqual(validateEccSource(RESOLVED_SOURCE, { resolved: true }), RESOLVED_SOURCE);
  assert.throws(
    () => validateEccSource({ ...RESOLVED_SOURCE, url: 'https://github.com/affaan-m/everything-claude-code.git' }, { resolved: true }),
    /source.url/
  );
  assert.throws(
    () => validateEccSource({ ...RESOLVED_SOURCE, trackRef: 'develop' }, { resolved: true }),
    /source.trackRef/
  );
  assert.throws(
    () => validateEccSource({ ...RESOLVED_SOURCE, resolvedCommit: 'main' }, { resolved: true }),
    /40-character Git SHA/
  );
  assert.throws(
    () => validateEccSource({ ...RESOLVED_SOURCE, version: '2.3.0' }, { resolved: true }),
    /2\.2\.x/
  );
});

test('v2 artifact descriptors capture ready-to-copy DCode plugin state', () => {
  const descriptor = validateArtifactDescriptor(artifactDescriptor());
  assert.equal(descriptor.strategy, 'dcode-plugin');
  assert.equal(descriptor.target.mountPath, '/opt/ai-fleet/harnesses/deepagent');
  assert.deepEqual(descriptor.capabilities.companion,
    ['commands-as-skills', 'subagents', 'instructions']);

  assert.throws(
    () => validateArtifactDescriptor({ ...artifactDescriptor(), strategy: 'skills-only' }),
    /dcode-plugin/
  );
  const unsafePath = artifactDescriptor();
  unsafePath.artifact = { ...unsafePath.artifact, path: '../rootfs.tar.gz' };
  assert.throws(() => validateArtifactDescriptor(unsafePath), /artifact\.path/);
});

test('v2 registry index requires exactly one artifact for all seven catalog harnesses', () => {
  const reversed = harnessIndex();
  reversed.harnesses = [...reversed.harnesses].reverse();
  const validated = validateHarnessRegistryIndex(reversed);
  assert.deepEqual(validated.harnesses.map((entry) => entry.id), HARNESS_IDS);

  const incomplete = harnessIndex();
  incomplete.harnesses = incomplete.harnesses.slice(1);
  assert.throws(() => validateHarnessRegistryIndex(incomplete), /missing: deepagent/);

  const duplicate = harnessIndex();
  duplicate.harnesses[1] = { ...duplicate.harnesses[0] };
  assert.throws(() => validateHarnessRegistryIndex(duplicate), /duplicate ids/);
});
