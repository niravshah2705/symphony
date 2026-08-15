'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ECC_SOURCE,
  HARNESS_ARTIFACT_MOUNT_ROOT,
  HARNESS_IDS,
  HARNESS_REGISTRY_SCHEMA_VERSION,
  HARNESS_STRATEGIES,
} = require('../../packages/shared-core/src/agent/registry/schema');
const {
  HARNESS_INSTALLERS,
  STRATEGY_METADATA,
  TOOL_VERSIONS,
  assembleRegistry,
  installDeepseek,
  readResolvedSource,
  scanTreeForLeaks,
  stageDshSkills,
  validateCodexConfig,
  validateResolvedSource,
  verifyRegistry,
} = require('./artifact-builder');
const { createDeterministicTarGz } = require('./archive');

const SOURCE_SCHEMA_VERSION = 'harness-registry/source-v1';
const COMMIT = 'a'.repeat(40);

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolvedSource(archive) {
  return {
    schemaVersion: SOURCE_SCHEMA_VERSION,
    ...ECC_SOURCE,
    commit: COMMIT,
    version: '2.2.0',
    archiveSha256: archive.sha256,
    archiveSizeBytes: archive.sizeBytes,
    archiveFileCount: archive.fileCount,
  };
}

function descriptor(harnessId, archive, source, overrides = {}) {
  return {
    schemaVersion: HARNESS_REGISTRY_SCHEMA_VERSION,
    harnessId,
    strategy: HARNESS_STRATEGIES[harnessId],
    source: {
      ...ECC_SOURCE,
      resolvedCommit: source.commit,
      version: source.version,
    },
    artifact: {
      path: `harnesses/${harnessId}/rootfs.tar.gz`,
      sha256: archive.sha256,
      sizeBytes: archive.sizeBytes,
      fileCount: archive.fileCount,
    },
    target: {
      platform: 'linux',
      arch: 'x64',
      mountPath: `${HARNESS_ARTIFACT_MOUNT_ROOT}/${harnessId}`,
      copyRoots: ['home', 'project'],
    },
    installer: { name: 'offline-fixture', version: '1.0.0' },
    compatibility: 'native',
    capabilities: { native: ['skills'], companion: [] },
    limitations: [],
    ...overrides,
  };
}

function createInputs(root, options = {}) {
  const inputsDir = path.join(root, 'inputs');
  const resolveDir = path.join(inputsDir, 'resolve');
  const sourceTree = path.join(root, 'source-tree');
  writeJson(path.join(sourceTree, 'package.json'), { name: 'ecc', version: '2.2.0' });
  writeFile(path.join(sourceTree, 'skills', 'fixture', 'SKILL.md'), '# Fixture\n');
  const sourceArchive = createDeterministicTarGz(sourceTree, path.join(resolveDir, 'source.tar.gz'));
  const source = resolvedSource(sourceArchive);
  writeJson(path.join(resolveDir, 'source.json'), source);
  writeJson(path.join(resolveDir, 'inert', 'manifest.json'), {
    schemaVersion: 'harness-registry/inert-v1',
    plugins: [],
  });

  for (const harnessId of HARNESS_IDS) {
    if (harnessId === options.omitHarness) continue;
    const legDir = path.join(inputsDir, 'harnesses', `harness-${harnessId}`);
    const rootfs = path.join(root, 'rootfs', harnessId);
    writeFile(path.join(rootfs, 'home', '.ecc-installed'), `${harnessId}\n`);
    writeFile(path.join(rootfs, 'project', 'AGENTS.md'), `# ${harnessId}\n`);
    if (harnessId === options.secretHarness) {
      writeJson(path.join(rootfs, 'home', '.codex', 'auth.json'), { token: 'must-not-publish' });
    }
    const archive = createDeterministicTarGz(rootfs, path.join(legDir, 'rootfs.tar.gz'));
    writeJson(path.join(legDir, 'artifact.json'), descriptor(harnessId, archive, source));
  }

  return { inputsDir, source };
}

test('resolved source metadata is strict, immutable, and readable from disk', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-source-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceTree = path.join(root, 'source');
  writeFile(path.join(sourceTree, 'package.json'), '{}\n');
  const archive = createDeterministicTarGz(sourceTree, path.join(root, 'source.tar.gz'));
  const valid = resolvedSource(archive);
  const sourceFile = path.join(root, 'source.json');
  writeJson(sourceFile, valid);

  assert.deepEqual(validateResolvedSource(valid), valid);
  assert.deepEqual(readResolvedSource(sourceFile), valid);
  assert.throws(
    () => validateResolvedSource({ ...valid, commit: 'ABC' }),
    /commit.*40|40.*commit/i
  );
  assert.throws(
    () => validateResolvedSource({ ...valid, version: '2.3.0' }),
    /2\.2\.x|version/i
  );
  assert.throws(
    () => validateResolvedSource({ ...valid, url: 'https://example.invalid/ecc.git' }),
    /canonical|source\.url|affaan-m/i
  );
  assert.throws(
    () => validateResolvedSource({ ...valid, archiveSha256: '0'.repeat(63) }),
    /sha-?256|digest|64/i
  );
});

test('Codex state retains the canonical immutable marketplace and enabled plugin', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-codex-config-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.toml');
  const source = {
    ...ECC_SOURCE,
    commit: COMMIT,
    version: '2.2.0',
  };
  writeFile(config, [
    '[marketplaces.ecc]',
    'source_type = "git"',
    `source = "${ECC_SOURCE.url}"`,
    `ref = "${COMMIT}"`,
    '',
    '[plugins."ecc@ecc"]',
    'enabled = true',
    '',
  ].join('\n'));

  assert.doesNotThrow(() => validateCodexConfig(config, source));
  assert.throws(
    () => validateCodexConfig(config, { ...source, commit: 'b'.repeat(40) }),
    /immutable ECC marketplace source/i
  );
  writeFile(config, fs.readFileSync(config, 'utf8').replace('enabled = true', 'enabled = false'));
  assert.throws(() => validateCodexConfig(config, source), /enable ecc@ecc/i);
});

test('DeepSeek stages ECC skills through the pinned first-party dsh contract', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-deepseek-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const homeRoot = path.join(root, 'home');
  const toolsRoot = path.join(root, 'tools');
  fs.mkdirSync(homeRoot);
  writeFile(path.join(sourceRoot, 'skills', 'token-review-code-source', 'SKILL.md'), [
    '---',
    'name: token-review-code',
    'description: Review a change safely.',
    '---',
    '# Review code',
    '',
  ].join('\n'));
  writeFile(path.join(sourceRoot, 'skills', 'token-review-code-source', 'references', 'checklist.md'), '# Checklist\n');
  writeFile(path.join(sourceRoot, 'skills', 'token-review-code-source', '.credentials.yaml'), 'api_key: never-copy\n');

  const calls = [];
  const result = installDeepseek({
    sourceRoot,
    homeRoot,
    toolsRoot,
    env: { CI: 'true' },
  }, {
    installCli(options) {
      calls.push({ type: 'install', options });
      return '/tools/dsh';
    },
    runCommand(executable, args, options) {
      calls.push({ type: 'run', executable, args, options });
      return `${TOOL_VERSIONS.deepseek}\n`;
    },
  });

  assert.deepEqual(result.stagedSkills, ['token-review-code']);
  assert.deepEqual(Object.keys(HARNESS_INSTALLERS), HARNESS_IDS);
  assert.deepEqual(Object.keys(STRATEGY_METADATA), HARNESS_IDS);
  assert.deepEqual(calls[0].options, {
    name: '@deepseek-ai/dsh',
    version: '0.1.0-rc.6',
    binary: 'dsh',
    toolsRoot,
    env: { CI: 'true', DSH_HOME: fs.realpathSync(path.join(homeRoot, '.dsh')) },
  });
  assert.deepEqual(calls[1].args, ['--version']);
  assert.equal(calls[1].options.env.DSH_HOME, fs.realpathSync(path.join(homeRoot, '.dsh')));
  assert.ok(fs.existsSync(path.join(homeRoot, '.dsh', 'skills', 'token-review-code', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(homeRoot, '.dsh', 'skills', 'token-review-code', 'references', 'checklist.md')));
  assert.equal(fs.existsSync(path.join(homeRoot, '.dsh', 'skills', 'token-review-code', '.credentials.yaml')), false);
  for (const privatePath of ['.credentials.yaml', 'settings.yaml', 'profiles', 'sessions', 'node_modules']) {
    assert.equal(fs.existsSync(path.join(homeRoot, '.dsh', privatePath)), false);
  }
});

test('DeepSeek skill staging rejects malformed and duplicate Agent Skills metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-deepseek-invalid-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFile(path.join(root, 'source', 'skills', 'review-code', 'SKILL.md'), [
    '---',
    'name: Wrong Name',
    'description: Review a change safely.',
    '---',
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'home'));
  assert.throws(
    () => stageDshSkills({ sourceRoot: path.join(root, 'source'), homeRoot: path.join(root, 'home') }),
    /kebab-case name and description frontmatter/i
  );

  writeFile(path.join(root, 'duplicate-source', 'skills', 'first', 'SKILL.md'), [
    '---',
    'name: same-name',
    'description: First skill.',
    '---',
    '',
  ].join('\n'));
  writeFile(path.join(root, 'duplicate-source', 'skills', 'second', 'SKILL.md'), [
    '---',
    'name: same-name',
    'description: Second skill.',
    '---',
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'duplicate-home'));
  assert.throws(
    () => stageDshSkills({
      sourceRoot: path.join(root, 'duplicate-source'),
      homeRoot: path.join(root, 'duplicate-home'),
    }),
    /skill name is duplicated: same-name/i
  );
});

test('DeepSeek staging rejects a destination symlink before writing outside the artifact', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-deepseek-symlink-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const homeRoot = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  writeFile(path.join(sourceRoot, 'skills', 'safe-skill', 'SKILL.md'), [
    '---',
    'name: safe-skill',
    'description: A safe test skill.',
    '---',
    '',
  ].join('\n'));
  fs.mkdirSync(homeRoot);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(homeRoot, '.dsh'), 'dir');

  assert.throws(
    () => stageDshSkills({ sourceRoot, homeRoot }),
    /DeepSeek home must be a real directory/i
  );
  assert.equal(fs.existsSync(path.join(outside, 'skills', 'safe-skill', 'SKILL.md')), false);
});

test('assembles and verifies exactly the eight catalog harness artifacts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-assemble-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { inputsDir } = createInputs(root);
  const outDir = path.join(root, 'registry');

  assembleRegistry({ inputsDir, outDir });
  assert.doesNotThrow(() => verifyRegistry({ registryDir: outDir }));

  const index = JSON.parse(fs.readFileSync(path.join(outDir, 'v1', 'registry.json'), 'utf8'));
  assert.equal(index.schemaVersion, HARNESS_REGISTRY_SCHEMA_VERSION);
  assert.deepEqual(index.harnesses.map((entry) => entry.id), HARNESS_IDS);
  assert.equal(index.harnesses.length, HARNESS_IDS.length);
  for (const harnessId of HARNESS_IDS) {
    assert.ok(fs.existsSync(path.join(outDir, 'v1', 'harnesses', harnessId, 'artifact.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'v1', 'harnesses', harnessId, 'rootfs.tar.gz')));
  }
  assert.ok(fs.existsSync(path.join(outDir, 'v1', 'inert', 'manifest.json')));

  fs.appendFileSync(
    path.join(outDir, 'v1', 'harnesses', HARNESS_IDS[0], 'rootfs.tar.gz'),
    'tampered'
  );
  assert.throws(
    () => verifyRegistry({ registryDir: outDir }),
    /checksum|sha-?256|size/i
  );
});

test('assembly fails closed when any catalog harness is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-missing-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const omitted = HARNESS_IDS.at(-1);
  const { inputsDir } = createInputs(root, { omitHarness: omitted });

  assert.throws(
    () => assembleRegistry({ inputsDir, outDir: path.join(root, 'registry') }),
    new RegExp(`missing|${omitted}|expected ${HARNESS_IDS.length}.*found ${HARNESS_IDS.length - 1}`, 'i')
  );
});

test('assembly inspects rootfs contents and rejects private harness state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-private-state-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { inputsDir } = createInputs(root, { secretHarness: 'codex-sdk' });

  assert.throws(
    () => assembleRegistry({ inputsDir, outDir: path.join(root, 'registry') }),
    /auth\.json|private state|secret/i
  );
});

test('secret-like state and temporary build paths are rejected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-leak-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tree = path.join(root, 'tree');
  writeFile(path.join(tree, 'home', '.config', 'safe.json'), '{"enabled":true}\n');
  assert.doesNotThrow(() => scanTreeForLeaks(tree));

  writeJson(path.join(tree, 'home', '.codex', 'auth.json'), { token: 'must-not-publish' });
  assert.throws(() => scanTreeForLeaks(tree), /auth\.json|secret|credential/i);
  fs.rmSync(path.join(tree, 'home', '.codex'), { recursive: true, force: true });

  const temporaryInstall = path.join(root, 'harness-work', 'plugin');
  writeJson(path.join(tree, 'home', '.config', 'state.json'), { install_location: temporaryInstall });
  assert.throws(
    () => scanTreeForLeaks(tree, { forbiddenPrefixes: [path.join(root, 'harness-work')] }),
    /temporary|forbidden|harness-work/i
  );

  fs.rmSync(path.join(tree, 'home', '.config', 'state.json'));
  const syntheticToken = `sk-${'a'.repeat(32)}`;
  writeJson(path.join(tree, 'home', '.opencode', 'ecc-install-state.json'), {
    schemaVersion: 'ecc.install.v1',
    credential: syntheticToken,
  });
  assert.throws(() => scanTreeForLeaks(tree), /credential-like content/i);

  fs.rmSync(path.join(tree, 'home', '.opencode', 'ecc-install-state.json'));
  writeJson(path.join(tree, 'home', '.opencode', 'docs', 'synthetic-security-fixture.json'), {
    syntheticToken,
  });
  assert.doesNotThrow(() => scanTreeForLeaks(tree));
});
