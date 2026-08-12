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

const REGISTRY_SCHEMA_VERSION = 'registry/v1';

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
};
