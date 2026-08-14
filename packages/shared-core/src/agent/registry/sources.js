'use strict';

const fs = require('fs');
const {
  HARNESS_REGISTRY_SCHEMA_VERSION,
  ECC_SOURCE,
  assertSafePathSegment,
  validateEccSource,
  validateHarnessStrategyMap,
} = require('./schema');

/**
 * Load + validate the repository source manifest (`sources.json`) — the single
 * source of truth for WHAT to publish and at WHICH version. In v2, ECC alone is
 * followed at `trackRef`, resolved once to an immutable commit, and installed by
 * the explicit strategy for every catalog harness. Other selected plugins stay
 * inert and retain immutable marketplace refs.
 *
 * Shape (validated here, fail-fast at the system boundary):
 *   {
 *     "version": "v1",                       // safe path segment → GCS prefix
 *     "updatedAt": "2026-08-12",
 *     "marketplaces": {
 *       "ecc": { "url": "https://github.com/affaan-m/ECC.git",
 *                "trackRef": "main", "versionRange": "2.2.x" },
 *       "<inert-name>": { "repo": "owner/name" | null, "url": "https://…" | null, "ref": "<sha|tag>" }
 *     },
 *     "harnessStrategies": { "<catalog-id>": "<strategy>" },
 *     "skills":  [ { "name": "web-research", "vendored": true } ],
 *     "plugins": [ { "name": "security", "marketplace": "<mp>", "version": "1.6.2" } ],
 *     "hooks":   [ { "name": "…", "marketplace": "<mp>", "event": "pre"|"post" } ]  // optional
 *   }
 *
 * `version` is validated to a single safe path segment because it becomes a GCS
 * object prefix — defends against a poisoned manifest value (see publish-skills.yml).
 */

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HOOK_EVENTS = new Set(['pre', 'post']);

function fail(msg) {
  throw new Error(`Invalid sources.json: ${msg}`);
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate a marketplace source pointer. */
function validateMarketplace(name, mp) {
  assertSafePathSegment(name, 'marketplace name');
  if (!isPlainObject(mp)) fail(`marketplace ${name} must be an object`);
  const hasRepo = typeof mp.repo === 'string' && mp.repo !== '';
  const hasUrl = typeof mp.url === 'string' && mp.url !== '';
  if (!hasRepo && !hasUrl) fail(`marketplace ${name} needs a "repo" (owner/name) or "url"`);
  if (hasRepo && !REPO_RE.test(mp.repo)) fail(`marketplace ${name} repo must be "owner/name" (got ${mp.repo})`);

  const isTracked = mp.trackRef != null || mp.versionRange != null;
  if (isTracked) {
    if (name !== ECC_SOURCE.id) fail(`only marketplace ${ECC_SOURCE.id} may use a tracked ref`);
    if (mp.ref != null) fail(`marketplace ${name} must not combine "ref" with "trackRef"`);
    if (hasRepo) fail(`marketplace ${name} must use the canonical ECC "url", not "repo"`);
    const source = validateEccSource({
      ...ECC_SOURCE,
      url: mp.url,
      trackRef: mp.trackRef,
      versionRange: mp.versionRange,
    });
    return {
      repo: null,
      url: source.url,
      ref: null,
      trackRef: source.trackRef,
      versionRange: source.versionRange,
    };
  }

  if (typeof mp.ref !== 'string' || mp.ref === '') fail(`marketplace ${name} needs a pinned "ref"`);
  return {
    repo: hasRepo ? mp.repo : null,
    url: hasUrl ? mp.url : null,
    ref: mp.ref,
    trackRef: null,
    versionRange: null,
  };
}

/**
 * @param {string} filePath absolute path to sources.json
 * @returns {{ version:string, updatedAt:(string|null), marketplaces:object,
 *             skills:object[], plugins:object[], hooks:object[] }}
 */
function loadSources(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read sources manifest at ${filePath}: ${error.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    fail(`not valid JSON (${error.message})`);
  }
  if (!isPlainObject(doc)) fail('top level must be an object');

  const schemaVersion = doc.schemaVersion == null ? null : String(doc.schemaVersion);
  if (schemaVersion != null && schemaVersion !== HARNESS_REGISTRY_SCHEMA_VERSION) {
    fail(`unsupported schemaVersion ${JSON.stringify(schemaVersion)}`);
  }

  if (typeof doc.version !== 'string') fail('missing string "version"');
  assertSafePathSegment(doc.version, 'sources version');

  const marketplaces = {};
  if (doc.marketplaces != null) {
    if (!isPlainObject(doc.marketplaces)) fail('"marketplaces" must be an object');
    for (const [name, mp] of Object.entries(doc.marketplaces)) {
      marketplaces[name] = validateMarketplace(name, mp);
    }
  }

  let source = null;
  let harnessStrategies = null;
  if (schemaVersion === HARNESS_REGISTRY_SCHEMA_VERSION) {
    const ecc = marketplaces[ECC_SOURCE.id];
    if (!ecc || !ecc.trackRef) {
      fail(`marketplaces.${ECC_SOURCE.id} must declare the canonical tracked ECC source`);
    }
    source = validateEccSource({
      ...ECC_SOURCE,
      url: ecc.url,
      trackRef: ecc.trackRef,
      versionRange: ecc.versionRange,
    });
    harnessStrategies = validateHarnessStrategyMap(doc.harnessStrategies);
  }

  const skills = [];
  if (doc.skills != null) {
    if (!Array.isArray(doc.skills)) fail('"skills" must be an array');
    for (const s of doc.skills) {
      if (!isPlainObject(s) || typeof s.name !== 'string') fail('each skill needs a string "name"');
      assertSafePathSegment(s.name, 'skill name');
      skills.push({ name: s.name, vendored: Boolean(s.vendored), marketplace: s.marketplace || null });
    }
  }

  const plugins = [];
  if (doc.plugins != null) {
    if (!Array.isArray(doc.plugins)) fail('"plugins" must be an array');
    for (const p of doc.plugins) {
      if (!isPlainObject(p) || typeof p.name !== 'string') fail('each plugin needs a string "name"');
      assertSafePathSegment(p.name, 'plugin name');
      if (typeof p.marketplace !== 'string' || p.marketplace === '') {
        fail(`plugin ${p.name} needs a "marketplace"`);
      }
      if (!marketplaces[p.marketplace]) {
        fail(`plugin ${p.name} references unknown marketplace "${p.marketplace}"`);
      }
      plugins.push({
        name: p.name,
        marketplace: p.marketplace,
        version: p.version != null ? String(p.version) : 'unknown',
      });
    }
  }

  const hooks = [];
  if (doc.hooks != null) {
    if (!Array.isArray(doc.hooks)) fail('"hooks" must be an array');
    for (const h of doc.hooks) {
      if (!isPlainObject(h) || typeof h.name !== 'string') fail('each hook needs a string "name"');
      assertSafePathSegment(h.name, 'hook name');
      if (h.event != null && !HOOK_EVENTS.has(String(h.event))) {
        fail(`hook ${h.name} event must be "pre" or "post" (got ${h.event})`);
      }
      if (h.marketplace != null && !marketplaces[h.marketplace]) {
        fail(`hook ${h.name} references unknown marketplace "${h.marketplace}"`);
      }
      hooks.push({
        name: h.name,
        marketplace: h.marketplace || null,
        event: h.event != null ? String(h.event) : null,
      });
    }
  }

  return {
    schemaVersion,
    version: doc.version,
    updatedAt: doc.updatedAt != null ? String(doc.updatedAt) : null,
    source,
    harnessStrategies,
    marketplaces,
    skills,
    plugins,
    hooks,
  };
}

module.exports = { loadSources };
