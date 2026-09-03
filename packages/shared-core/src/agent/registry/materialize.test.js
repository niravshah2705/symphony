'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveHarnessArtifactRoot } = require('../../config');
const { ensureHarnessArtifact } = require('./materialize');
const { createDeterministicTarGz, sha256File } = require('./archive');
const { ECC_SOURCE } = require('./index');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Build a real rootfs.tar.gz for `deepseek` plus its valid descriptor. */
function buildBundle(t, harnessId) {
  const stage = tmp(t, `${harnessId}-stage-`);
  const skill = path.join(stage, 'home', '.dsh', 'skills', 'demo');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: demo\n---\nhi\n');

  const gcs = tmp(t, `${harnessId}-gcs-`);
  const rootfs = path.join(gcs, 'rootfs.tar.gz');
  const built = createDeterministicTarGz(stage, rootfs);
  const descriptor = {
    schemaVersion: 'harness-registry/v2',
    harnessId,
    strategy: 'dsh-skills',
    source: {
      id: ECC_SOURCE.id,
      repository: ECC_SOURCE.repository,
      url: ECC_SOURCE.url,
      versionRange: ECC_SOURCE.versionRange,
      trackRef: ECC_SOURCE.trackRef,
      resolvedCommit: 'a'.repeat(40),
      version: '2.2.0',
    },
    artifact: {
      path: `harnesses/${harnessId}/rootfs.tar.gz`,
      sha256: built.sha256,
      sizeBytes: built.sizeBytes,
      fileCount: built.fileCount,
    },
    target: {
      platform: 'linux',
      arch: 'x64',
      mountPath: `/opt/ai-fleet/harnesses/${harnessId}`,
      copyRoots: ['home'],
    },
    installer: { name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' },
    compatibility: 'native-skills',
    capabilities: { native: ['skills'], companion: [] },
    limitations: ['DeepSeek Harness is a developer preview.'],
  };
  fs.writeFileSync(path.join(gcs, 'artifact.json'), JSON.stringify(descriptor));
  return { rootfs, descriptorPath: path.join(gcs, 'artifact.json'), sha: built.sha256 };
}

/** A fake GCS download that copies from a local `gs://bucket/<object>` layout. */
function fakeDownloader(gcsRoot, counter) {
  return async (bucket, objectPath, destFile) => {
    counter.count += 1;
    const src = path.join(gcsRoot, objectPath);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(src, destFile);
  };
}

test('resolveHarnessArtifactRoot is off by default and canonical when enabled', () => {
  assert.equal(resolveHarnessArtifactRoot('deepseek', {}), null);
  assert.equal(
    resolveHarnessArtifactRoot('deepseek', { HARNESS_REGISTRY_ROOT: '/opt/ai-fleet/harnesses' }),
    '/opt/ai-fleet/harnesses/deepseek'
  );
  assert.throws(() => resolveHarnessArtifactRoot('../evil', { HARNESS_REGISTRY_ROOT: '/opt/ai-fleet/harnesses' }));
});

test('ensureHarnessArtifact is a no-op when the mount is disabled', async () => {
  const result = await ensureHarnessArtifact('deepseek', { config: { enabled: false }, env: {} });
  assert.equal(result, null);
});

test('ensureHarnessArtifact downloads, verifies, extracts, and is idempotent', async (t) => {
  const harnessId = 'deepseek';
  const bundle = buildBundle(t, harnessId);
  // Lay the bundle out under a fake GCS root at <version>/harnesses/<id>/...
  const gcsRoot = tmp(t, 'gcs-root-');
  const objDir = path.join(gcsRoot, 'v1', 'harnesses', harnessId);
  fs.mkdirSync(objDir, { recursive: true });
  fs.copyFileSync(bundle.rootfs, path.join(objDir, 'rootfs.tar.gz'));
  fs.copyFileSync(bundle.descriptorPath, path.join(objDir, 'artifact.json'));

  const mountRoot = tmp(t, 'mount-root-');
  const env = { HARNESS_REGISTRY_ROOT: mountRoot };
  const cfg = { enabled: true, root: mountRoot, version: 'v1', bucket: 'test-bucket' };
  const counter = { count: 0 };
  const deps = { download: fakeDownloader(gcsRoot, counter) };

  const dest = await ensureHarnessArtifact(harnessId, { config: cfg, env, deps });
  assert.equal(dest, path.join(mountRoot, harnessId));
  assert.ok(fs.existsSync(path.join(dest, 'home', '.dsh', 'skills', 'demo', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(dest, '.materialized')));
  const firstDownloads = counter.count;
  assert.equal(firstDownloads, 2); // descriptor + rootfs

  // Second call short-circuits on the marker — no further downloads.
  const again = await ensureHarnessArtifact(harnessId, { config: cfg, env, deps });
  assert.equal(again, dest);
  assert.equal(counter.count, firstDownloads);
});

test('ensureHarnessArtifact rejects a tampered rootfs (sha mismatch)', async (t) => {
  const harnessId = 'deepseek';
  const bundle = buildBundle(t, harnessId);
  const gcsRoot = tmp(t, 'gcs-bad-');
  const objDir = path.join(gcsRoot, 'v1', 'harnesses', harnessId);
  fs.mkdirSync(objDir, { recursive: true });
  // Corrupt the rootfs so its sha256 no longer matches the descriptor.
  const corrupt = Buffer.concat([fs.readFileSync(bundle.rootfs), Buffer.from([0])]);
  fs.writeFileSync(path.join(objDir, 'rootfs.tar.gz'), corrupt);
  fs.copyFileSync(bundle.descriptorPath, path.join(objDir, 'artifact.json'));

  const mountRoot = tmp(t, 'mount-bad-');
  await assert.rejects(
    ensureHarnessArtifact(harnessId, {
      config: { enabled: true, root: mountRoot, version: 'v1', bucket: 'b' },
      env: { HARNESS_REGISTRY_ROOT: mountRoot },
      deps: { download: fakeDownloader(gcsRoot, { count: 0 }) },
    }),
    /sha256 mismatch/
  );
  assert.equal(fs.existsSync(path.join(mountRoot, harnessId, '.materialized')), false);
});
