#!/usr/bin/env node
'use strict';

/*
 * Build the harness-agnostic skills/plugins/tools/hooks registry.
 *
 * Reads the repo-pinned source list (packages/shared-core/src/agent/registry/
 * sources.json), shallow-clones each marketplace at its pinned ref, converts the
 * named skills/plugins/hooks into the generic pattern, and writes a DUAL bundle:
 *   <out>/<version>/original/   harness-native payloads (secret-filtered)
 *   <out>/<version>/generic/    normalized tree + registry.json
 *   <out>/registry-manifest.json
 *
 * The weekly GitHub Action calls this, then publishes <out>/<version> to GCS.
 *
 *   node scripts/build-harness-registry.js --dry-run
 *   node scripts/build-harness-registry.js --out ./registry-bundle-out
 *   node scripts/build-harness-registry.js --sources <path> --out <dir> --work <dir>
 *
 * Flags:
 *   --sources <path>   source manifest (default: the vendored sources.json)
 *   --out <dir>        bundle output root (required unless --dry-run)
 *   --work <dir>       clone working dir (default: a fresh temp dir)
 *   --allow-incomplete do not fail when a marketplace/plugin can't be resolved
 *   --refresh-remote   (not implemented) reserved for re-pinning refs from upstream
 *   --dry-run          print the plan (no clone, no write)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../packages/shared-core/src/agent/registry');

const DEFAULT_SOURCES = path.join(
  __dirname, '..', 'packages', 'shared-core', 'src', 'agent', 'registry', 'sources.json'
);

function parseArgs(argv) {
  const args = { sources: DEFAULT_SOURCES, out: null, work: null, dryRun: false, allowIncomplete: false, refreshRemote: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--allow-incomplete') args.allowIncomplete = true;
    else if (a === '--refresh-remote') args.refreshRemote = true;
    else if (a === '--sources') args.sources = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--work') args.work = argv[++i];
    else if (a === '--vendored-skills') args.vendoredSkillsRoot = argv[++i];
    else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.refreshRemote) {
    process.stderr.write('--refresh-remote is not implemented; reading pinned refs from sources.json.\n');
  }

  if (args.dryRun) {
    const plan = registry.planSummary(args.sources);
    process.stdout.write(`Harness registry plan (version ${plan.version})\n`);
    process.stdout.write(`  marketplaces to clone:\n`);
    for (const mp of plan.marketplaces) {
      process.stdout.write(`    - ${mp.name} @ ${mp.ref} (${mp.repo || mp.url})\n`);
    }
    process.stdout.write(`  skills (${plan.skills.length}): ${plan.skills.join(', ')}\n`);
    process.stdout.write(`  plugins (${plan.plugins.length}):\n`);
    for (const p of plan.plugins) process.stdout.write(`    - ${p}\n`);
    if (plan.hooks.length) process.stdout.write(`  hooks: ${plan.hooks.join(', ')}\n`);
    return;
  }

  if (!args.out) {
    process.stderr.write('Missing --out <dir> (required unless --dry-run).\n');
    process.exit(2);
  }

  const work = args.work || fs.mkdtempSync(path.join(os.tmpdir(), 'harness-registry-'));
  fs.mkdirSync(work, { recursive: true });

  const result = registry.buildRegistry({
    sourcesPath: args.sources,
    workRoot: work,
    outDir: args.out,
    vendoredSkillsRoot: args.vendoredSkillsRoot,
    generatedAt: new Date().toISOString(),
  });

  const { entries } = result.registry;
  const counts = entries.reduce((acc, e) => { acc[e.kind] = (acc[e.kind] || 0) + 1; return acc; }, {});
  const incomplete = entries.filter((e) => e.incomplete);

  process.stdout.write(`Built registry ${result.registry.version} -> ${result.versionDir}\n`);
  process.stdout.write(`  entries: ${entries.length} (${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ')})\n`);
  process.stdout.write(`  original: ${result.originalDir}\n  generic:  ${result.genericDir}\n`);

  if (result.warnings.length) {
    process.stdout.write(`  warnings (${result.warnings.length}):\n`);
    for (const w of result.warnings) process.stdout.write(`    - ${w}\n`);
  }
  if (incomplete.length) {
    process.stdout.write(`  incomplete entries (${incomplete.length}): ${incomplete.map((e) => e.id).join(', ')}\n`);
  }

  if (incomplete.length && !args.allowIncomplete) {
    process.stderr.write('Refusing to finish: some resources were incomplete (pass --allow-incomplete to override).\n');
    process.exit(1);
  }
}

main();
