'use strict';

/**
 * Harness-agnostic resource registry — schema primitives.
 *
 * Pure, zero-dependency helpers (only Node built-ins) shared by the reader,
 * normalizer, and bundle-writer. This is the lowest layer of the registry: it
 * defines the generic entry shape, the dedupe identity, and how a raw upstream
 * version string (semver / git sha / integer / "latest") is normalized into a
 * single sortable value while preserving the raw for provenance.
 *
 * A generic entry (one per logical resource) looks like:
 *   {
 *     id, dedupeKey, kind,               // identity
 *     name, description,
 *     version: { normalized, scheme, raw, conflict? },
 *     provenance: [ { marketplace, sourceRepo, sourceUrl, ref, rawVersion, harness, scope } ],
 *     payload: { ...kind-specific... },
 *     capabilities?: { ... },            // skills only
 *     adapters: { <harnessLabel>: { ... } },
 *     incomplete: boolean,
 *   }
 */

const HARNESS_CATALOG = require('../harness-catalog.json');

// `registry/v1` is the legacy, harness-agnostic resource bundle. Keep it
// readable while the runtime migration is intentionally out of scope. New
// ready-to-copy harness artifacts use the v2 contract below.
const REGISTRY_SCHEMA_VERSION = 'registry/v1';
const HARNESS_REGISTRY_SCHEMA_VERSION = 'harness-registry/v2';
const HARNESS_ARTIFACT_MOUNT_ROOT = '/opt/ai-fleet/harnesses';
const ECC_SOURCE = Object.freeze({
  id: 'ecc',
  repository: 'affaan-m/ECC',
  url: 'https://github.com/affaan-m/ECC.git',
  trackRef: 'main',
  versionRange: '2.2.x',
});

const HARNESS_IDS = Object.freeze(
  (HARNESS_CATALOG.harnesses || []).map((harness) => harness.id)
);
const HARNESS_STRATEGIES = Object.freeze({
  deepagent: 'dcode-plugin',
  'codex-sdk': 'codex-marketplace',
  'claude-agent-sdk': 'claude-marketplace',
  'antigravity-sdk': 'antigravity-profile',
  opencode: 'opencode-profile',
  pi: 'pi-package',
  'oh-my-pi': 'oh-my-pi-marketplace',
});

const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ECC_VERSION_RE = /^2\.2\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The kinds of resource the generic registry models. */
const KINDS = Object.freeze({
  SKILL: 'skill',
  PLUGIN: 'plugin',
  MCP_SERVER: 'mcpServer',
  HOOK: 'hook',
});

const KIND_VALUES = Object.freeze(Object.values(KINDS));

/** Hook events we recognize (pre/post are what the request calls out). */
const HOOK_EVENTS = Object.freeze(['pre', 'post']);

// --- Path-segment safety ----------------------------------------------------
// Every derived filesystem segment (skill/marketplace/plugin/version/hook name)
// must be a single safe component before it is joined into a bundle path or a
// GCS prefix. This is the string-level guard; fs-guards.js adds the on-disk
// containment/symlink checks. Kept here (pure, no fs) so readers/normalizer can
// validate names before any I/O.
const UNSAFE_SEGMENT = /[^A-Za-z0-9._-]/;

/**
 * Assert `segment` is a single safe path component. Throws on empty, ".", "..",
 * anything containing a path separator, or any char outside [A-Za-z0-9._-].
 * @param {string} segment
 * @param {string} [label] human context for the error message
 * @returns {string} the segment (for chaining)
 */
function assertSafePathSegment(segment, label = 'path segment') {
  if (
    typeof segment !== 'string'
    || segment === ''
    || segment === '.'
    || segment === '..'
    || UNSAFE_SEGMENT.test(segment)
  ) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(segment)}`);
  }
  return segment;
}

/** True when `segment` is a safe single path component (non-throwing variant). */
function isSafePathSegment(segment) {
  try {
    assertSafePathSegment(segment);
    return true;
  } catch (_) {
    return false;
  }
}

// --- Harness artifact registry v2 ------------------------------------------

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function artifactSchemaError(message) {
  return new Error(`Invalid ${HARNESS_REGISTRY_SCHEMA_VERSION}: ${message}`);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    throw artifactSchemaError(`${label} must be a non-empty, trimmed string`);
  }
  return value;
}

function requireInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw artifactSchemaError(`${label} must be a ${positive ? 'positive' : 'non-negative'} safe integer`);
  }
  return value;
}

function requireStringList(value, label) {
  if (!Array.isArray(value)) throw artifactSchemaError(`${label} must be an array`);
  const normalized = value.map((item, index) => requireNonEmptyString(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw artifactSchemaError(`${label} must not contain duplicates`);
  }
  return normalized;
}

/**
 * Validate the explicit catalog-id -> installer-strategy map. The exact key set
 * is enforced so adding a catalog harness fails the registry build until its ECC
 * installation behavior is deliberately specified.
 */
function validateHarnessStrategyMap(value) {
  if (!isPlainObject(value)) throw artifactSchemaError('harnessStrategies must be an object');
  const suppliedIds = Object.keys(value);
  const missing = HARNESS_IDS.filter((id) => !Object.prototype.hasOwnProperty.call(value, id));
  const unexpected = suppliedIds.filter((id) => !HARNESS_IDS.includes(id));
  if (missing.length) throw artifactSchemaError(`harnessStrategies is missing: ${missing.join(', ')}`);
  if (unexpected.length) throw artifactSchemaError(`harnessStrategies has unknown ids: ${unexpected.join(', ')}`);

  const normalized = {};
  for (const id of HARNESS_IDS) {
    const strategy = requireNonEmptyString(value[id], `harnessStrategies.${id}`);
    const expected = HARNESS_STRATEGIES[id];
    if (strategy !== expected) {
      throw artifactSchemaError(`harnessStrategies.${id} must be ${JSON.stringify(expected)} (got ${JSON.stringify(strategy)})`);
    }
    normalized[id] = strategy;
  }
  return normalized;
}

/** Validate canonical ECC tracking or resolved-source provenance. */
function validateEccSource(value, { resolved = false } = {}) {
  if (!isPlainObject(value)) throw artifactSchemaError('source must be an object');
  for (const key of ['id', 'repository', 'url', 'versionRange']) {
    if (value[key] !== ECC_SOURCE[key]) {
      throw artifactSchemaError(`source.${key} must be ${JSON.stringify(ECC_SOURCE[key])}`);
    }
  }
  const trackRef = requireNonEmptyString(value.trackRef, 'source.trackRef');
  if (trackRef !== ECC_SOURCE.trackRef) {
    throw artifactSchemaError(`source.trackRef must be ${JSON.stringify(ECC_SOURCE.trackRef)}`);
  }
  if (
    trackRef.startsWith('-')
    || trackRef.includes('..')
    || trackRef.includes('@{')
    || /[\s\\~^:?*[\]]/.test(trackRef)
  ) {
    throw artifactSchemaError(`source.trackRef is not a safe Git ref: ${JSON.stringify(trackRef)}`);
  }

  const resolvedCommit = value.resolvedCommit == null
    ? null
    : requireNonEmptyString(value.resolvedCommit, 'source.resolvedCommit');
  const version = value.version == null
    ? null
    : requireNonEmptyString(value.version, 'source.version');
  if (resolved || resolvedCommit != null) {
    if (!FULL_GIT_SHA_RE.test(resolvedCommit || '')) {
      throw artifactSchemaError('source.resolvedCommit must be a lowercase 40-character Git SHA');
    }
  }
  if (resolved || version != null) {
    if (!ECC_VERSION_RE.test(version || '')) {
      throw artifactSchemaError('source.version must resolve inside the required 2.2.x range');
    }
  }

  return {
    id: ECC_SOURCE.id,
    repository: ECC_SOURCE.repository,
    url: ECC_SOURCE.url,
    trackRef,
    versionRange: ECC_SOURCE.versionRange,
    ...(resolvedCommit == null ? {} : { resolvedCommit }),
    ...(version == null ? {} : { version }),
  };
}

function validateHarnessId(value, label = 'harnessId') {
  const id = requireNonEmptyString(value, label);
  if (!HARNESS_IDS.includes(id)) throw artifactSchemaError(`${label} is not in the harness catalog: ${id}`);
  return id;
}

function validateChecksum(value, label) {
  const checksum = requireNonEmptyString(value, label);
  if (!SHA256_RE.test(checksum)) {
    throw artifactSchemaError(`${label} must be a lowercase SHA-256 digest`);
  }
  return checksum;
}

function expectedArtifactPath(harnessId) {
  return `harnesses/${harnessId}/rootfs.tar.gz`;
}

function expectedDescriptorPath(harnessId) {
  return `harnesses/${harnessId}/artifact.json`;
}

/** Validate one ready-to-copy harness artifact descriptor. */
function validateArtifactDescriptor(value) {
  if (!isPlainObject(value)) throw artifactSchemaError('artifact descriptor must be an object');
  if (value.schemaVersion !== HARNESS_REGISTRY_SCHEMA_VERSION) {
    throw artifactSchemaError(`artifact schemaVersion must be ${HARNESS_REGISTRY_SCHEMA_VERSION}`);
  }
  const harnessId = validateHarnessId(value.harnessId);
  const strategy = requireNonEmptyString(value.strategy, 'strategy');
  if (strategy !== HARNESS_STRATEGIES[harnessId]) {
    throw artifactSchemaError(`strategy for ${harnessId} must be ${HARNESS_STRATEGIES[harnessId]}`);
  }
  const source = validateEccSource(value.source, { resolved: true });

  if (!isPlainObject(value.artifact)) throw artifactSchemaError('artifact must be an object');
  const artifactPath = requireNonEmptyString(value.artifact.path, 'artifact.path');
  if (artifactPath !== expectedArtifactPath(harnessId)) {
    throw artifactSchemaError(`artifact.path for ${harnessId} must be ${expectedArtifactPath(harnessId)}`);
  }
  const artifact = {
    ...value.artifact,
    path: artifactPath,
    sha256: validateChecksum(value.artifact.sha256, 'artifact.sha256'),
    sizeBytes: requireInteger(value.artifact.sizeBytes, 'artifact.sizeBytes', { positive: true }),
    fileCount: requireInteger(value.artifact.fileCount, 'artifact.fileCount', { positive: true }),
  };

  if (!isPlainObject(value.target)) throw artifactSchemaError('target must be an object');
  if (value.target.platform !== 'linux') throw artifactSchemaError('target.platform must be "linux"');
  if (value.target.arch !== 'x64') throw artifactSchemaError('target.arch must be "x64"');
  const expectedMountPath = `${HARNESS_ARTIFACT_MOUNT_ROOT}/${harnessId}`;
  if (value.target.mountPath !== expectedMountPath) {
    throw artifactSchemaError(`target.mountPath for ${harnessId} must be ${expectedMountPath}`);
  }
  const copyRoots = requireStringList(value.target.copyRoots, 'target.copyRoots');
  if (!copyRoots.length || copyRoots.some((root) => root !== 'home' && root !== 'project')) {
    throw artifactSchemaError('target.copyRoots must contain only home and/or project');
  }
  const target = { ...value.target, copyRoots };

  if (!isPlainObject(value.installer)) throw artifactSchemaError('installer must be an object');
  const installer = {
    ...value.installer,
    name: requireNonEmptyString(value.installer.name, 'installer.name'),
    version: requireNonEmptyString(value.installer.version, 'installer.version'),
  };
  const compatibility = requireNonEmptyString(value.compatibility, 'compatibility');
  if (!isPlainObject(value.capabilities)) throw artifactSchemaError('capabilities must be an object');
  const capabilities = {
    native: requireStringList(value.capabilities.native, 'capabilities.native'),
    companion: requireStringList(value.capabilities.companion, 'capabilities.companion'),
  };
  const limitations = requireStringList(value.limitations, 'limitations');

  return {
    ...value,
    schemaVersion: HARNESS_REGISTRY_SCHEMA_VERSION,
    harnessId,
    strategy,
    source,
    artifact,
    target,
    installer,
    compatibility,
    capabilities,
    limitations,
  };
}

function validateHarnessIndexEntry(value) {
  if (!isPlainObject(value)) throw artifactSchemaError('each harness index entry must be an object');
  const id = validateHarnessId(value.id, 'harness index id');
  const strategy = requireNonEmptyString(value.strategy, `harnesses.${id}.strategy`);
  if (strategy !== HARNESS_STRATEGIES[id]) {
    throw artifactSchemaError(`strategy for ${id} must be ${HARNESS_STRATEGIES[id]}`);
  }
  const descriptorPath = requireNonEmptyString(value.descriptorPath, `harnesses.${id}.descriptorPath`);
  const artifactPath = requireNonEmptyString(value.artifactPath, `harnesses.${id}.artifactPath`);
  if (descriptorPath !== expectedDescriptorPath(id)) {
    throw artifactSchemaError(`descriptorPath for ${id} must be ${expectedDescriptorPath(id)}`);
  }
  if (artifactPath !== expectedArtifactPath(id)) {
    throw artifactSchemaError(`artifactPath for ${id} must be ${expectedArtifactPath(id)}`);
  }
  return {
    ...value,
    id,
    strategy,
    descriptorPath,
    artifactPath,
    sha256: validateChecksum(value.sha256, `harnesses.${id}.sha256`),
    sizeBytes: requireInteger(value.sizeBytes, `harnesses.${id}.sizeBytes`, { positive: true }),
  };
}

/** Validate the assembled `v1/registry.json` artifact index. */
function validateHarnessRegistryIndex(value) {
  if (!isPlainObject(value)) throw artifactSchemaError('registry index must be an object');
  if (value.schemaVersion !== HARNESS_REGISTRY_SCHEMA_VERSION) {
    throw artifactSchemaError(`index schemaVersion must be ${HARNESS_REGISTRY_SCHEMA_VERSION}`);
  }
  const version = assertSafePathSegment(value.version, 'harness registry version');
  const source = validateEccSource(value.source, { resolved: true });
  if (!Array.isArray(value.harnesses)) throw artifactSchemaError('harnesses must be an array');
  const harnesses = value.harnesses.map(validateHarnessIndexEntry);
  const seen = new Set(harnesses.map((entry) => entry.id));
  const missing = HARNESS_IDS.filter((id) => !seen.has(id));
  if (seen.size !== harnesses.length) throw artifactSchemaError('harnesses must not contain duplicate ids');
  if (missing.length || harnesses.length !== HARNESS_IDS.length) {
    throw artifactSchemaError(`harnesses must cover the catalog exactly${missing.length ? `; missing: ${missing.join(', ')}` : ''}`);
  }
  const byId = new Map(harnesses.map((entry) => [entry.id, entry]));
  const orderedHarnesses = HARNESS_IDS.map((id) => byId.get(id));
  const inert = value.inert == null ? [] : value.inert;
  if (!Array.isArray(inert)) throw artifactSchemaError('inert must be an array');
  if (value.generatedAt != null) requireNonEmptyString(value.generatedAt, 'generatedAt');

  return {
    ...value,
    schemaVersion: HARNESS_REGISTRY_SCHEMA_VERSION,
    version,
    source,
    harnesses: orderedHarnesses,
    inert: inert.map((entry) => (isPlainObject(entry) ? { ...entry } : entry)),
  };
}

// --- Dedupe identity --------------------------------------------------------

/**
 * Stable identity for a logical resource. The SAME plugin installed from the
 * same marketplace in two harnesses collapses to one key (so their provenance
 * merges); a skill/hook/mcp server is keyed by name alone.
 * @param {string} kind one of KINDS
 * @param {string} name resource name
 * @param {string} [marketplace] required for plugins
 * @returns {string}
 */
function dedupeKey(kind, name, marketplace) {
  if (!KIND_VALUES.includes(kind)) throw new Error(`Unknown kind: ${JSON.stringify(kind)}`);
  if (typeof name !== 'string' || !name) throw new Error('dedupeKey needs a non-empty name');
  if (kind === KINDS.PLUGIN) {
    if (typeof marketplace !== 'string' || !marketplace) {
      throw new Error(`Plugin dedupeKey needs a marketplace (name=${name})`);
    }
    return `${kind}:${name}@${marketplace}`;
  }
  return `${kind}:${name}`;
}

// --- Version normalization --------------------------------------------------
// Precedence when reconciling multiple sources for one entry.
const SCHEME_RANK = Object.freeze({ semver: 3, gitsha: 2, integer: 1, unknown: 0 });
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const GITSHA_RE = /^[0-9a-f]{7,40}$/i;
const INT_RE = /^\d+$/;

/**
 * Normalize a raw upstream version into a sortable value plus a scheme tag,
 * keeping the raw. `latest`/`unknown`/empty → the `unknown` scheme.
 *
 * Ordering note: semver is checked first, then git sha (7–40 hex), then a bare
 * integer (the existing skills-manifest `version:<int>`). A short integer (< 7
 * digits) never matches the sha pattern, so core skill versions stay `integer`.
 * @param {unknown} raw
 * @returns {{ normalized: string, scheme: 'semver'|'gitsha'|'integer'|'unknown', raw: string|null }}
 */
function normalizeVersion(raw) {
  const rawStr = raw == null ? null : String(raw);
  const value = (rawStr == null ? '' : rawStr).trim();
  const lower = value.toLowerCase();
  if (value === '' || lower === 'unknown' || lower === 'latest') {
    return { normalized: '0.0.0-unknown', scheme: 'unknown', raw: rawStr };
  }
  const semver = value.replace(/^v/, '');
  if (SEMVER_RE.test(semver)) {
    return { normalized: semver, scheme: 'semver', raw: rawStr };
  }
  if (GITSHA_RE.test(value)) {
    return { normalized: `0.0.0-git.${value.slice(0, 7).toLowerCase()}`, scheme: 'gitsha', raw: rawStr };
  }
  if (INT_RE.test(value)) {
    return { normalized: `0.0.0-int.${value}`, scheme: 'integer', raw: rawStr };
  }
  return { normalized: '0.0.0-unknown', scheme: 'unknown', raw: rawStr };
}

/**
 * Reconcile several normalized versions (one per provenance source) into a
 * single winner. Higher scheme rank wins; within a scheme the higher value
 * wins (numeric-aware compare). `conflict:true` when the raws are not identical.
 * @param {Array<{ normalized:string, scheme:string, raw:(string|null) }>} versions
 * @returns {{ normalized:string, scheme:string, raw:(string|null), conflict:boolean }}
 */
function reconcileVersions(versions) {
  const list = Array.isArray(versions) ? versions.filter(Boolean) : [];
  if (!list.length) return { ...normalizeVersion(null), conflict: false };
  const rawSet = new Set(list.map((v) => (v.raw == null ? '' : String(v.raw))));
  const conflict = rawSet.size > 1;
  const winner = list.slice().sort((a, b) => {
    const rank = (SCHEME_RANK[b.scheme] || 0) - (SCHEME_RANK[a.scheme] || 0);
    if (rank) return rank;
    return String(b.normalized).localeCompare(String(a.normalized), 'en', { numeric: true });
  })[0];
  return { normalized: winner.normalized, scheme: winner.scheme, raw: winner.raw, conflict };
}

// --- Entry construction -----------------------------------------------------

/**
 * Build a generic registry entry. Never mutates its inputs; returns a fresh
 * object with normalized fields and sensible defaults. `marketplace` is only
 * used to form the dedupe key for plugins.
 * @param {object} input
 * @returns {object}
 */
function makeEntry(input) {
  const {
    kind,
    name,
    marketplace = null,
    description = '',
    version,
    provenance = [],
    payload = {},
    capabilities,
    adapters = {},
    incomplete = false,
  } = input || {};
  if (!KIND_VALUES.includes(kind)) throw new Error(`makeEntry: unknown kind ${JSON.stringify(kind)}`);
  assertSafePathSegment(name, `${kind} name`);
  const key = dedupeKey(kind, name, marketplace);
  const entry = {
    id: key,
    dedupeKey: key,
    kind,
    name,
    description: typeof description === 'string' ? description : '',
    version: version && version.normalized
      ? { conflict: false, ...version }
      : reconcileVersions([]),
    provenance: Array.isArray(provenance) ? provenance.slice() : [],
    payload: { ...payload },
    adapters: { ...adapters },
    incomplete: Boolean(incomplete),
  };
  if (capabilities && typeof capabilities === 'object') entry.capabilities = { ...capabilities };
  return entry;
}

module.exports = {
  REGISTRY_SCHEMA_VERSION,
  HARNESS_REGISTRY_SCHEMA_VERSION,
  HARNESS_ARTIFACT_MOUNT_ROOT,
  ECC_SOURCE,
  HARNESS_IDS,
  HARNESS_STRATEGIES,
  KINDS,
  KIND_VALUES,
  HOOK_EVENTS,
  SCHEME_RANK,
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
};
