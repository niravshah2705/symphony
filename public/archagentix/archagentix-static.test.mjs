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

// 2. Verify Static JSON Dataset
const jsonPath = path.join(__dirname, '../data/benchmarks/index.json');
const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
assert.ok(Array.isArray(jsonContent), 'index.json dataset must be an array');
assert.ok(jsonContent.length >= 4, 'dataset must contain at least 4 models');

const firstModel = jsonContent[0];
assert.ok(firstModel.id, 'model missing id');
assert.ok(firstModel.name, 'model missing name');
assert.ok(firstModel.agentic_features.supports_agentic_development === true, 'model must support agentic development');
assert.ok(firstModel.cloud_inference_metrics.aws_bedrock !== undefined, 'missing AWS Bedrock inference metrics');
assert.ok(firstModel.cloud_inference_metrics.gcp_vertex_ai !== undefined, 'missing GCP Vertex AI inference metrics');
assert.ok(firstModel.cloud_inference_metrics.digital_ocean_gradient !== undefined, 'missing Digital Ocean Gradient inference metrics');
assert.ok(firstModel.cloud_inference_metrics.alibaba_dashscope !== undefined, 'missing Alibaba DashScope inference metrics');
assert.ok(firstModel.simple_score > 0, 'model missing simple_score');
assert.ok(firstModel.rank > 0, 'model missing rank');

// 3. Verify Sharded Provider Files
const providersDir = path.join(__dirname, '../data/benchmarks/providers');
assert.ok(fs.existsSync(path.join(providersDir, 'aws_bedrock.json')), 'missing aws_bedrock.json shard');
assert.ok(fs.existsSync(path.join(providersDir, 'gcp_vertex_ai.json')), 'missing gcp_vertex_ai.json shard');
assert.ok(fs.existsSync(path.join(providersDir, 'digital_ocean_gradient.json')), 'missing digital_ocean_gradient.json shard');
assert.ok(fs.existsSync(path.join(providersDir, 'alibaba_dashscope.json')), 'missing alibaba_dashscope.json shard');

console.log('✅ All ArchAgentix Static Tests Passed Successfully!');
