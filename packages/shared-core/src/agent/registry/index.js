'use strict';

const path = require('path');
const { KINDS } = require('./schema');
const { loadSources } = require('./sources');
const { fetchMarketplace } = require('./source-fetcher');
const { readVendoredSkill, readPlugin } = require('./native-reader');
const { normalize } = require('./normalizer');
const { writeBundle } = require('./bundle-writer');
const {
  HARNESS_REGISTRY_SCHEMA_VERSION,
  HARNESS_ARTIFACT_MOUNT_ROOT,
  ECC_SOURCE,
  HARNESS_IDS,
  HARNESS_STRATEGIES,
  validateHarnessStrategyMap,
  validateEccSource,
  validateArtifactDescriptor,
  validateHarnessRegistryIndex,
  expectedArtifactPath,
  expectedDescriptorPath,
} = require('./schema');

/**
 * Public entry point for the harness-registry converter.
 *
 *   buildRegistry() — read sources.json → clone marketplaces at pinned refs →
 *   read native resources → normalize → write the dual original/generic bundle.
 *   planSummary()  — a no-clone, no-write preview for `--dry-run`.
 *
 * All I/O is injectable (git, roots) so the pipeline is testable offline.
 */

// The repo-vendored core skills the framework already ships.
const DEFAULT_VENDORED_SKILLS_ROOT = path.join(__dirname, '..', 'skills');

function incompletePlugin(p) {
  return {
    kind: KINDS.PLUGIN,
    name: p.name,
    marketplace: p.marketplace,
    version: p.version || 'unknown',
    ref: null,
    sourceRepo: null,
    sourceUrl: null,
    sourceDir: null,
    description: '',
    provides: { skills: [], hooks: [], mcpServers: [], agents: [], commands: [] },
    incomplete: true,
  };
}

/** Read every selected resource into raw records, collecting non-fatal warnings. */
function readRawRecords(sources, opts = {}) {
  const {
    workRoot,
    vendoredSkillsRoot = DEFAULT_VENDORED_SKILLS_ROOT,
    git,
  } = opts;
  const warnings = [];
  const raw = [];

  for (const s of sources.skills) {
    if (!s.vendored) continue; // non-vendored marketplace skills come via their plugin
    const rec = readVendoredSkill(vendoredSkillsRoot, s.name);
    if (rec.incomplete) warnings.push(`vendored skill not found: ${s.name}`);
    raw.push(rec);
  }

  const clones = {};
  for (const [name, mp] of Object.entries(sources.marketplaces)) {
    try {
      clones[name] = fetchMarketplace(mp, { workRoot, git, name });
    } catch (error) {
      warnings.push(`clone failed for marketplace ${name}: ${error.message}`);
    }
  }

  for (const p of sources.plugins) {
    const clone = clones[p.marketplace];
    const mp = sources.marketplaces[p.marketplace];
    if (!clone) {
      warnings.push(`plugin ${p.name}: marketplace ${p.marketplace} unavailable`);
      raw.push(incompletePlugin(p));
      continue;
    }
    const rec = readPlugin(clone.path, {
      name: p.name,
      marketplace: p.marketplace,
      version: p.version,
      ref: clone.sha || clone.ref,
      sourceRepo: mp.repo,
      sourceUrl: mp.url,
    });
    if (rec.incomplete) warnings.push(`plugin ${p.name}: payload not found in ${p.marketplace}`);
    raw.push(rec);
  }

  return { raw, warnings };
}

/**
 * @param {{ sourcesPath:string, workRoot:string, outDir:string,
 *           vendoredSkillsRoot?:string, git?:Function, generatedAt?:string }} opts
 */
function buildRegistry(opts) {
  const { sourcesPath, workRoot, outDir, vendoredSkillsRoot, git, generatedAt } = opts;
  const sources = loadSources(sourcesPath);
  const { raw, warnings: readWarnings } = readRawRecords(sources, { workRoot, vendoredSkillsRoot, git });
  const registry = normalize(raw, { version: sources.version });
  const sourceSummary = [{
    harness: 'claude-code+codex',
    marketplaces: Object.keys(sources.marketplaces),
  }];
  const write = writeBundle(registry, outDir, { generatedAt, sources: sourceSummary });
  return {
    registry,
    sources,
    warnings: [...readWarnings, ...write.warnings],
    versionDir: write.versionDir,
    genericDir: write.genericDir,
    originalDir: write.originalDir,
  };
}

/** No-clone, no-write preview of what a run would publish. */
function planSummary(sourcesPath) {
  const sources = loadSources(sourcesPath);
  return {
    schemaVersion: sources.schemaVersion,
    version: sources.version,
    marketplaces: Object.entries(sources.marketplaces).map(([name, mp]) => ({
      name, ref: mp.ref || mp.trackRef, tracked: Boolean(mp.trackRef), repo: mp.repo, url: mp.url,
    })),
    source: sources.source,
    harnessStrategies: sources.harnessStrategies,
    skills: sources.skills.map((s) => s.name),
    plugins: sources.plugins.map((p) => `${p.name}@${p.marketplace} (${p.version})`),
    hooks: sources.hooks.map((h) => `${h.name}${h.event ? ` (${h.event})` : ''}`),
  };
}

module.exports = {
  buildRegistry,
  planSummary,
  readRawRecords,
  DEFAULT_VENDORED_SKILLS_ROOT,
  loadSources,
  HARNESS_REGISTRY_SCHEMA_VERSION,
  HARNESS_ARTIFACT_MOUNT_ROOT,
  ECC_SOURCE,
  HARNESS_IDS,
  HARNESS_STRATEGIES,
  validateHarnessStrategyMap,
  validateEccSource,
  validateArtifactDescriptor,
  validateHarnessRegistryIndex,
  expectedArtifactPath,
  expectedDescriptorPath,
};
