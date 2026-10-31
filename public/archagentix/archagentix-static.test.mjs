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

// 2. Verify Static JSON Dataset for Grok, DeepSeek, MiniMax, Moonshot, Qwen, GLM, OpenAI, Meta, Mistral
const jsonPath = path.join(__dirname, '../data/benchmarks/index.json');
const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
assert.ok(Array.isArray(jsonContent), 'index.json dataset must be an array');
assert.ok(jsonContent.length >= 9, 'dataset must contain at least 9 models (Grok, DeepSeek, MiniMax, Moonshot, Qwen, GLM, OpenAI, Meta, Mistral)');

const providers = jsonContent.map(m => m.provider.toLowerCase());
['xai', 'deepseek', 'minimax', 'moonshot ai', 'alibaba cloud', 'zhipu ai', 'openai', 'meta', 'mistral ai'].forEach(p => {
  assert.ok(providers.some(pr => pr.includes(p.split(' ')[0])), `Missing model provider: ${p}`);
});

const firstModel = jsonContent[0];
assert.ok(firstModel.id, 'model missing id');
assert.ok(firstModel.name, 'model missing name');
assert.ok(firstModel.cost_options.standard.prompt_cost_per_1m >= 0, 'missing standard prompt cost');
assert.ok(firstModel.cost_options.batch.discount_pct >= 0, 'missing batch discount pct');
assert.ok(firstModel.cost_options.cached.discount_pct >= 0, 'missing cache discount pct');
assert.ok(Array.isArray(firstModel.supported_regions), 'missing supported regions array');

// 3. Verify Sharded File
const costingFile = path.join(__dirname, '../data/benchmarks/providers/costing_and_regions.json');
assert.ok(fs.existsSync(costingFile), 'missing costing_and_regions.json shard');

console.log('✅ All ArchAgentix Static Tests Passed Successfully!');
