'use strict';

/**
 * Runtime materializer for the harness-native artifact registry.
 *
 * Downloads a harness's published, "ready-to-copy" rootfs bundle
 * (gs://<bucket>/<version>/harnesses/<id>/rootfs.tar.gz) plus its descriptor,
 * verifies integrity (sha256 + size against the signed descriptor), and extracts
 * it to the canonical on-disk mount `/opt/ai-fleet/harnesses/<id>` — the exact
 * path the bundle's internal references are baked to, so no rewriting is needed.
 *
 * COPY-IN, not gcsfuse: this adds no Cloud Run template volume, so it never
 * blocks a container's startup probe (the reason the skills gcsfuse mount stays
 * gated off). Call it EAGERLY on the coder-worker Job (no startup probe) and
 * LAZILY on first harness use in the planner/coder-control services.
 *
 * Idempotent: a `.materialized` marker short-circuits repeat calls; concurrent
 * calls in one process share a single in-flight promise. Placement is atomic
 * (extract to a same-filesystem temp dir, then rename onto the canonical path).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CONFIG, resolveHarnessArtifactRoot } = require('../../config');
const { extractTarGz, sha256File } = require('./archive');
const {
  validateArtifactDescriptor,
  expectedArtifactPath,
  expectedDescriptorPath,
} = require('./schema');

const MARKER_NAME = '.materialized';
const inflight = new Map();

function versionPrefix(version) {
  return version ? `${version}/` : '';
}

/** Real GCS fetch of a single object to a local file (lazy-required client). */
async function defaultDownloadObject(bucket, objectPath, destFile) {
  const { Storage } = require('@google-cloud/storage');
  await new Storage().bucket(bucket).file(objectPath).download({ destination: destFile });
}

async function materialize(harnessId, cfg, deps, env) {
  const dest = resolveHarnessArtifactRoot(harnessId, env);
  if (!dest) return null; // resolver returns null only when the mount is disabled
  const marker = path.join(dest, MARKER_NAME);
  if (fs.existsSync(marker)) return dest;

  const download = deps.download || defaultDownloadObject;
  const prefix = versionPrefix(cfg.version);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `harness-artifact-${harnessId}-`));
  // Extract onto the SAME filesystem as `dest` so the final placement is an
  // atomic rename (a cross-device rename would EXDEV).
  const stagingParent = path.dirname(dest);
  fs.mkdirSync(stagingParent, { recursive: true });
  const staged = fs.mkdtempSync(path.join(stagingParent, `.${harnessId}.tmp-`));

  try {
    const descriptorFile = path.join(work, 'artifact.json');
    const rootfsFile = path.join(work, 'rootfs.tar.gz');
    await download(cfg.bucket, `${prefix}${expectedDescriptorPath(harnessId)}`, descriptorFile);
    await download(cfg.bucket, `${prefix}${expectedArtifactPath(harnessId)}`, rootfsFile);

    const descriptor = validateArtifactDescriptor(JSON.parse(fs.readFileSync(descriptorFile, 'utf8')));
    if (descriptor.harnessId !== harnessId) {
      throw new Error(`Descriptor is for ${descriptor.harnessId}, expected ${harnessId}.`);
    }
    const actualSha = sha256File(rootfsFile);
    if (actualSha !== descriptor.artifact.sha256) {
      throw new Error(`rootfs sha256 mismatch for ${harnessId} (${actualSha} != ${descriptor.artifact.sha256}).`);
    }
    const actualSize = fs.statSync(rootfsFile).size;
    if (actualSize !== descriptor.artifact.sizeBytes) {
      throw new Error(`rootfs size mismatch for ${harnessId} (${actualSize} != ${descriptor.artifact.sizeBytes}).`);
    }

    // extractTarGz requires an empty destination; the mkdtemp dir is empty.
    fs.rmSync(staged, { recursive: true, force: true });
    extractTarGz(rootfsFile, staged);
    fs.writeFileSync(path.join(staged, MARKER_NAME), `${descriptor.artifact.sha256}\n`);

    // Atomic swap into place: clear any partial prior extraction, then rename.
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staged, dest);
    return dest;
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Ensure a harness's registry artifact is materialized at its canonical path,
 * returning that path (or null when the registry mount is disabled). Safe to
 * call on every run — it is a no-op once materialized.
 *
 * @param {string} harnessId canonical harness id (e.g. 'deepseek').
 * @param {object} [options]
 * @param {object} [options.config] override for CONFIG.HARNESS_REGISTRY (tests).
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {{download?: (bucket:string, objectPath:string, destFile:string)=>Promise<void>}} [options.deps]
 * @returns {Promise<string|null>}
 */
async function ensureHarnessArtifact(harnessId, options = {}) {
  const cfg = options.config || CONFIG.HARNESS_REGISTRY;
  if (!cfg || !cfg.enabled) return null;
  if (!cfg.bucket) {
    throw new Error('HARNESS_REGISTRY_BUCKET is required when the harness registry mount is enabled.');
  }
  const env = options.env || process.env;
  const key = `${cfg.root}|${cfg.version}|${harnessId}`;
  if (inflight.has(key)) return inflight.get(key);
  const promise = materialize(harnessId, cfg, options.deps || {}, env)
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

module.exports = { ensureHarnessArtifact };
