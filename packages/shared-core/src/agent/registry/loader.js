'use strict';

const fs = require('fs');
const path = require('path');
const {
  REGISTRY_SCHEMA_VERSION,
  KINDS,
  assertSafePathSegment,
  validateArtifactDescriptor,
  validateHarnessRegistryIndex,
} = require('./schema');

/**
 * Runtime consumption of a published harness registry.
 *
 * The weekly Action publishes a versioned bundle to GCS; the planner/coder may
 * mount it read-only at REGISTRY_ROOT and pin REGISTRY_VERSION. V2 indexes
 * ready-to-copy trees per harness. The original generic-resource helpers remain
 * below for compatibility with the previous registry/v1 bundle.
 *
 * Nothing here is wired into the live agent path yet. The v2 APIs only resolve,
 * validate, and select descriptors; they never extract archives or execute
 * installers. Keeping this module pure lets the publishing contract land before
 * a separate, main-checkout-validated runtime activation change.
 */

/**
 * Resolve the `generic/` directory of a published registry bundle from the
 * environment. Returns null when REGISTRY_ROOT is unset (feature off — there is no
 * vendored registry bundle, so callers fall back to today's behavior).
 *
 * Layout mounted at REGISTRY_ROOT: `<version>/generic/…`. REGISTRY_VERSION pins
 * the version subdir (validated to a single safe path segment — it forms a path,
 * defense-in-depth even though it is trusted server config).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} absolute path to the bundle's generic dir, or null
 */
function resolveRegistrySrc(env = process.env) {
  const root = String((env && env.REGISTRY_ROOT) || '').trim();
  if (!root) return null;
  const version = String((env && env.REGISTRY_VERSION) || '').trim();
  if (version) assertSafePathSegment(version, 'REGISTRY_VERSION');
  const base = version ? path.join(root, version) : root;
  return path.join(base, 'generic');
}

/**
 * Resolve the directory containing the v2 `registry.json` artifact index.
 * This selects a mounted version only; it does not extract or activate a
 * harness tree.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
function resolveHarnessRegistryDir(env = process.env) {
  const root = String((env && env.REGISTRY_ROOT) || '').trim();
  if (!root) return null;
  const version = String((env && env.REGISTRY_VERSION) || '').trim();
  if (version) assertSafePathSegment(version, 'REGISTRY_VERSION');
  return version ? path.join(root, version) : root;
}

/** The skills subdirectory of a resolved generic dir (what installSkills reads). */
function registrySkillsDir(genericDir) {
  return path.join(genericDir, 'skills');
}

/**
 * Load + validate `registry.json` from a generic bundle dir.
 * @param {string} genericDir
 * @returns {{ schemaVersion:string, version:string, entries:object[] }}
 */
function loadRegistryManifest(genericDir) {
  const file = path.join(genericDir, 'registry.json');
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read registry manifest at ${file}: ${error.message}`);
  }
  if (!doc || typeof doc !== 'object') throw new Error(`Malformed registry manifest: ${file}`);
  if (doc.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported registry schemaVersion ${JSON.stringify(doc.schemaVersion)} (expected ${REGISTRY_SCHEMA_VERSION})`);
  }
  if (!Array.isArray(doc.entries)) throw new Error(`Registry manifest has no entries array: ${file}`);
  return doc;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${file}: ${error.message}`);
  }
}

/** Load and validate the v2 ready-to-copy harness artifact index. */
function loadHarnessRegistry(registryDir) {
  if (typeof registryDir !== 'string' || !registryDir.trim()) {
    throw new Error('loadHarnessRegistry requires a registry directory');
  }
  const file = path.join(registryDir, 'registry.json');
  return validateHarnessRegistryIndex(readJson(file, 'harness registry index'));
}

/** Select one catalog harness's immutable artifact reference from a v2 index. */
function selectArtifactDescriptor(manifest, harnessId) {
  const index = validateHarnessRegistryIndex(manifest);
  return index.harnesses.find((entry) => entry.id === harnessId) || null;
}

/**
 * Load the selected `artifact.json` and prove it matches its index row. This is
 * intentionally the end of the loader's responsibility: callers receive a
 * descriptor, never an extracted or executed harness.
 */
function loadArtifactDescriptor(registryDir, manifest, harnessId) {
  const selected = selectArtifactDescriptor(manifest, harnessId);
  if (!selected) return null;
  const descriptorFile = path.join(registryDir, ...selected.descriptorPath.split('/'));
  const descriptor = validateArtifactDescriptor(readJson(descriptorFile, `${harnessId} artifact descriptor`));
  if (descriptor.harnessId !== selected.id || descriptor.strategy !== selected.strategy) {
    throw new Error(`Artifact descriptor identity does not match registry index for ${harnessId}`);
  }
  if (
    descriptor.artifact.path !== selected.artifactPath
    || descriptor.artifact.sha256 !== selected.sha256
    || descriptor.artifact.sizeBytes !== selected.sizeBytes
  ) {
    throw new Error(`Artifact descriptor archive metadata does not match registry index for ${harnessId}`);
  }
  const indexSource = validateHarnessRegistryIndex(manifest).source;
  if (JSON.stringify(descriptor.source) !== JSON.stringify(indexSource)) {
    throw new Error(`Artifact descriptor source does not match registry index for ${harnessId}`);
  }
  return descriptor;
}

/** Index entries by kind → Map(name/id → entry) for O(1) lookup. */
function indexEntries(entries) {
  const byKind = { skill: new Map(), plugin: new Map(), mcpServer: new Map(), hook: new Map() };
  for (const entry of entries) {
    const bucket = byKind[entry.kind];
    if (bucket) bucket.set(entry.name, entry);
  }
  return byKind;
}

/**
 * Does a skill entry answer to `wanted` under this harness? Matches the generic
 * name, or the per-harness adapter alias (e.g. `security:raven`, or the deepagent
 * install name), so a workflow can declare either form.
 */
function skillMatches(entry, wanted, harnessLabel) {
  if (entry.name === wanted) return true;
  const adapter = entry.adapters && entry.adapters[harnessLabel];
  if (adapter && (adapter.skill === wanted || adapter.name === wanted)) return true;
  return false;
}

/**
 * Select the concrete resources a runtime needs for a workflow declaration.
 *
 * @param {{ entries:object[] }} manifest
 * @param {string} harnessLabel one of HARNESS_LABELS (deepagent|codex|claudecode|antigravity)
 * @param {{ skills?:string[], mcp?:string[] }} want declared skill / mcp names
 * @returns {{
 *   skills: Array<{ id:string, name:string, path:string }>,
 *   mcp: Array<{ id:string, name:string, descriptor:object }>,
 *   missing: { skills:string[], mcp:string[] }
 * }} `path` is relative to the bundle's generic dir (e.g. `skills/web-research`).
 */
function selectForRuntime(manifest, harnessLabel, want = {}) {
  const entries = (manifest && manifest.entries) || [];
  const byKind = indexEntries(entries);
  const wantSkills = Array.isArray(want.skills) ? want.skills : [];
  const wantMcp = Array.isArray(want.mcp) ? want.mcp : [];

  const skills = [];
  const missingSkills = [];
  for (const name of wantSkills) {
    const entry = byKind.skill.get(name)
      || entries.find((e) => e.kind === KINDS.SKILL && skillMatches(e, name, harnessLabel));
    if (entry) skills.push({ id: entry.id, name: entry.name, path: entry.payload.path });
    else missingSkills.push(name);
  }

  const mcp = [];
  const missingMcp = [];
  for (const name of wantMcp) {
    const entry = byKind.mcpServer.get(name);
    if (entry) mcp.push({ id: entry.id, name: entry.name, descriptor: entry.payload.descriptor || {} });
    else missingMcp.push(name);
  }

  return { skills, mcp, missing: { skills: missingSkills, mcp: missingMcp } };
}

module.exports = {
  resolveRegistrySrc,
  resolveHarnessRegistryDir,
  registrySkillsDir,
  loadRegistryManifest,
  selectForRuntime,
  loadHarnessRegistry,
  selectArtifactDescriptor,
  loadArtifactDescriptor,
};
