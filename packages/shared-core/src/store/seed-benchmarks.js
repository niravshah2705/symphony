import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const catalogPath = path.resolve(__dirname, '../benchmarks-catalog.json');
export const benchmarksCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

export function calculateSimpleScore(item) {
  const swe = item.benchmarks?.swe_bench || 0;
  const mmlu = item.benchmarks?.mmlu_pro || 0;
  const promptCost = item.cost?.prompt_per_1m || 0;

  // Cost score: 100 for free/cheap ($0), scaling down as price reaches $0.50/1M
  const costScore = Math.max(0, 100 - Math.min(100, (promptCost / 0.50) * 100));

  let featureBonus = 0;
  if (item.features?.prompt_cache_supported) featureBonus += 30;
  if (item.features?.auto_fallback_enabled) featureBonus += 30;
  if ((item.features?.rate_limits?.rpm || 0) >= 1000) featureBonus += 20;
  if (item.model_type === 'open_source') featureBonus += 20;

  const score = (0.40 * swe) + (0.25 * mmlu) + (0.20 * costScore) + (0.15 * featureBonus);
  return Number(score.toFixed(1));
}

export async function seedBenchmarksToFirestore(store) {
  if (!store || typeof store.setDoc !== 'function') return false;
  for (const item of benchmarksCatalog) {
    const computedScore = calculateSimpleScore(item);
    const docData = { ...item, simple_score: computedScore };
    await store.setDoc('benchmarks', item.id, docData);
  }
  return true;
}
