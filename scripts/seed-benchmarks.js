#!/usr/bin/env node
'use strict';

// Regenerates the scored benchmark catalog the ArchAgentix panel serves.
//
//   node scripts/seed-benchmarks.js          # rewrite public/data/benchmarks/catalog-scored.json
//   node scripts/seed-benchmarks.js --check  # fail if the shipped file drifts (CI gate)
//
// This replaces packages/shared-core/src/store/seed-benchmarks.js (PR #200), which
// never worked: it called store.setDoc(), an API the store does not have.

const fs = require('node:fs');
const path = require('node:path');

const CATALOG_PATH = path.resolve(__dirname, '../public/data/benchmarks/catalog.json');
const OUT_PATH = path.resolve(__dirname, '../public/data/benchmarks/catalog-scored.json');

function supportedClouds(item) {
  return Object.entries(item.cloud_inference_metrics || {}).filter(
    ([, cloud]) => cloud && typeof cloud.prompt_cost_per_1m === 'number',
  );
}

// Same shape as the original scorer (0.40 capability + 0.25 breadth + 0.20 cost +
// 0.15 features), wired to the fields the catalog actually carries.
function calculateSimpleScore(item) {
  const swe = item.benchmarks?.swe_bench_verified || 0;
  const mmlu = item.benchmarks?.mmlu_pro || 0;

  const clouds = supportedClouds(item);
  const minCost = clouds.length ? Math.min(...clouds.map(([, c]) => c.prompt_cost_per_1m)) : 0.5;
  const costScore = Math.max(0, 100 - Math.min(100, (minCost / 0.50) * 100));

  let featureBonus = 0;
  if (clouds.some(([, c]) => typeof c.cached_prompt_cost_per_1m === 'number')) featureBonus += 30;
  if (item.agentic_features?.computer_use) featureBonus += 30;
  if (clouds.some(([, c]) => (c.rate_limits?.rpm || 0) >= 1000)) featureBonus += 20;
  if (item.model_type === 'open_source') featureBonus += 20;

  const score = 0.40 * swe + 0.25 * mmlu + 0.20 * costScore + 0.15 * featureBonus;
  return Number(score.toFixed(1));
}

function bestCloud(item) {
  const clouds = supportedClouds(item);
  if (!clouds.length) return null;
  const [key, cloud] = clouds.reduce((best, cur) => (cur[1].prompt_cost_per_1m < best[1].prompt_cost_per_1m ? cur : best));
  return { provider: key, prompt_cost_per_1m: cloud.prompt_cost_per_1m };
}

function buildScoredCatalog(catalog) {
  return catalog
    .slice()
    .sort((a, b) => (a.rank || 0) - (b.rank || 0))
    .map((item) => ({ ...item, simple_score: calculateSimpleScore(item), best_cloud: bestCloud(item) }));
}

function serialize(rows) {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const output = serialize(buildScoredCatalog(catalog));

  if (check) {
    const shipped = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : '';
    if (shipped !== output) {
      console.error(`catalog-scored.json is stale — run: npm run benchmarks:seed (${OUT_PATH})`);
      process.exit(1);
    }
    console.log('catalog-scored.json matches the catalog.');
    return;
  }

  fs.writeFileSync(OUT_PATH, output);
  console.log(`Wrote ${OUT_PATH} (${catalog.length} rows, scores recomputed from ${CATALOG_PATH}).`);
}

if (require.main === module) main();

module.exports = { calculateSimpleScore, buildScoredCatalog, bestCloud };
