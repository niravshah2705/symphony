import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Running ArchAgentix Benchmarks Static Tests...');

// 1. Verify HTML Structure
const htmlPath = path.join(__dirname, 'index.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');
assert.ok(htmlContent.includes('ArchAgentix'), 'index.html missing ArchAgentix title');
assert.ok(htmlContent.includes('benchmarks-table'), 'index.html missing benchmarks table');
assert.ok(htmlContent.includes('evaluator'), 'index.html missing interactive evaluator section');
assert.ok(htmlContent.includes('slm-chat'), 'index.html missing SLM chat section');

// 2. Verify Static Master JSON Dataset from docs/model-pricing CSVs
const jsonPath = path.join(__dirname, '../data/benchmarks/index.json');
const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
assert.ok(Array.isArray(jsonContent), 'index.json dataset must be an array');
assert.ok(jsonContent.length > 4000, `dataset must contain all model rows from CSVs (found ${jsonContent.length})`);

const firstModel = jsonContent[0];
assert.ok(firstModel.provider, 'model row missing provider');
assert.ok(firstModel.model_name, 'model row missing model_name');
assert.ok(firstModel.model_id, 'model row missing model_id');
assert.ok(firstModel.input_usd_per_1m !== undefined, 'model row missing input_usd_per_1m');
assert.ok(firstModel.output_usd_per_1m !== undefined, 'model row missing output_usd_per_1m');

console.log('✅ All ArchAgentix Static Tests Passed Successfully!');
