'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  routeSkillsForTurn,
  resolveAndRouteSkills,
  extractSkillMetadata,
  measureSkillContextSize,
  computeContextMetrics,
} = require('./index');
const { routeWithLaya } = require('./laya-client');
const { routeWithClm } = require('./clm-client');
const { LangChainSkillRouter, routeWithLangChainRouter } = require('./langchain-adapter');

test('measureSkillContextSize & computeContextMetrics calculate context reduction', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-metrics-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const skill1Dir = path.join(tmpDir, 'skill-one');
  const skill2Dir = path.join(tmpDir, 'skill-two');
  fs.mkdirSync(skill1Dir, { recursive: true });
  fs.mkdirSync(skill2Dir, { recursive: true });

  // 400 characters in skill1
  const content1 = 'A'.repeat(400);
  // 600 characters in skill2
  const content2 = 'B'.repeat(600);

  fs.writeFileSync(path.join(skill1Dir, 'SKILL.md'), content1);
  fs.writeFileSync(path.join(skill2Dir, 'SKILL.md'), content2);

  const measure1 = measureSkillContextSize([skill1Dir], tmpDir);
  assert.equal(measure1.charCount, 400);
  assert.equal(measure1.estimatedTokens, 100);

  const measureAll = measureSkillContextSize([skill1Dir, skill2Dir], tmpDir);
  assert.equal(measureAll.charCount, 1000);
  assert.equal(measureAll.estimatedTokens, 250);

  // When routed down to just skill-one
  const metrics = computeContextMetrics([skill1Dir, skill2Dir], [skill1Dir], {
    backend: 'laya',
    fallbackApplied: false,
    latencyMs: 18,
  }, tmpDir);

  assert.equal(metrics.backend, 'laya');
  assert.equal(metrics.fallbackApplied, false);
  assert.equal(metrics.totalSkills, 2);
  assert.equal(metrics.usedSkills, 1);
  assert.equal(metrics.totalContextSize, 1000);
  assert.equal(metrics.usedContextSize, 400);
  assert.equal(metrics.savedContextSize, 600);
  assert.equal(metrics.contextReductionPercent, 60.0);
  assert.equal(metrics.estimatedTokensTotal, 250);
  assert.equal(metrics.estimatedTokensUsed, 100);
  assert.equal(metrics.estimatedTokensSaved, 150);
  assert.equal(metrics.routingLatencyMs, 18);
});

test('extractSkillMetadata parses skill descriptions from SKILL.md', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-meta-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const planDir = path.join(tmpDir, 'software-planning');
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, 'SKILL.md'),
    `---
description: Comprehensive architecture and task planning
---
# Software Planning
Skill instructions here.`
  );

  const meta = extractSkillMetadata(planDir, tmpDir);
  assert.equal(meta.id, 'software-planning');
  assert.equal(meta.description, 'Comprehensive architecture and task planning');
});

test('routeWithLaya sends candidates to inference service and returns top-K IDs', async () => {
  let receivedBody = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/route' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          selected_skills: ['plan', 'db'],
          latency_ms: 12.5,
          backend: 'laya-modernbert',
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;

  try {
    const candidates = [
      { id: 'plan', description: 'Architecture planner' },
      { id: 'db', description: 'Database schema tools' },
      { id: 'deploy', description: 'Cloud deployment' },
    ];

    const result = await routeWithLaya('Plan the new user database tables', candidates, {
      endpoint,
      topK: 2,
      timeoutMs: 1000,
    });

    assert.deepEqual(result, ['plan', 'db']);
    assert.equal(receivedBody.prompt, 'Plan the new user database tables');
    assert.equal(receivedBody.top_k, 2);
    assert.equal(receivedBody.candidates.length, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('routeSkillsForTurn falls back gracefully to all skills when latency exceeds timeout', async (t) => {
  // Mock server that deliberately hangs past timeout
  const server = http.createServer((req, res) => {
    if (req.url === '/route') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ selected_skills: ['skill-1'] }));
      }, 500); // 500ms delay
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-timeout-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const path1 = path.join(tmpDir, 'skill-1');
  const path2 = path.join(tmpDir, 'skill-2');
  fs.mkdirSync(path1);
  fs.mkdirSync(path2);
  fs.writeFileSync(path.join(path1, 'SKILL.md'), 'Skill 1 doc');
  fs.writeFileSync(path.join(path2, 'SKILL.md'), 'Skill 2 doc');

  // Set timeout to 50ms, which server will breach
  const origEnv = process.env.LAYA_INFERENCE_URL;
  process.env.LAYA_INFERENCE_URL = endpoint;
  t.after(() => { process.env.LAYA_INFERENCE_URL = origEnv; });

  const result = await routeSkillsForTurn('Create feature plan', [path1, path2], {
    backend: 'laya',
    timeoutMs: 50,
    rootDir: tmpDir,
  });

  // Fallback applied: all skills retained
  assert.equal(result.metrics.fallbackApplied, true);
  assert.deepEqual(result.selectedSkillPaths, [path1, path2]);
  assert.equal(result.metrics.totalSkills, 2);
  assert.equal(result.metrics.usedSkills, 2);
  assert.equal(result.metrics.contextReductionPercent, 0.0);
});

test('routeWithClm sends contrastive query to CLM service and returns top-K IDs', async () => {
  let receivedBody = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/route' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          selected_ids: ['audit-trail'],
          backend: 'clm-contrastive',
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;

  try {
    const candidates = [
      { id: 'audit-trail', description: 'Security audit trail logger' },
      { id: 'billing', description: 'Stripe payment processor' },
    ];

    const result = await routeWithClm('Verify compliance logs', candidates, {
      endpoint,
      topK: 1,
      timeoutMs: 1000,
    });

    assert.deepEqual(result, ['audit-trail']);
    assert.equal(receivedBody.query, 'Verify compliance logs');
    assert.equal(receivedBody.top_k, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('routeSkillsForTurn shortlists skills and returns accurate context metrics', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/route') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ selected_ids: ['skill-a'] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-routing-metrics-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const dirA = path.join(tmpDir, 'skill-a');
  const dirB = path.join(tmpDir, 'skill-b');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  fs.writeFileSync(path.join(dirA, 'SKILL.md'), 'A'.repeat(500));
  fs.writeFileSync(path.join(dirB, 'SKILL.md'), 'B'.repeat(1500));

  const origEnv = process.env.LAYA_INFERENCE_URL;
  process.env.LAYA_INFERENCE_URL = endpoint;
  t.after(() => { process.env.LAYA_INFERENCE_URL = origEnv; });

  const result = await routeSkillsForTurn('Run skill A task', [dirA, dirB], {
    backend: 'laya',
    rootDir: tmpDir,
  });

  assert.equal(result.metrics.fallbackApplied, false);
  assert.deepEqual(result.selectedSkillPaths, [dirA]);
  assert.equal(result.metrics.totalSkills, 2);
  assert.equal(result.metrics.usedSkills, 1);
  assert.equal(result.metrics.totalContextSize, 2000);
  assert.equal(result.metrics.usedContextSize, 500);
  assert.equal(result.metrics.savedContextSize, 1500);
  assert.equal(result.metrics.contextReductionPercent, 75.0);
  assert.equal(result.metrics.estimatedTokensTotal, 500);
  assert.equal(result.metrics.estimatedTokensUsed, 125);
  assert.equal(result.metrics.estimatedTokensSaved, 375);
});

test('routeSkillsForTurn passes through candidates when disabled', async () => {
  const result = await routeSkillsForTurn('Any prompt', ['/mock/path/a', '/mock/path/b'], {
    enabled: false,
  });

  assert.deepEqual(result.selectedSkillPaths, ['/mock/path/a', '/mock/path/b']);
  assert.equal(result.metrics.backend, 'none');
  assert.equal(result.metrics.fallbackApplied, false);
});

test('LangChainSkillRouter adapter integrates with LangChain Runnable pattern', async () => {
  const router = new LangChainSkillRouter({
    backend: 'laya',
    topK: 2,
    timeoutMs: 1000,
    fallbackOnTimeout: true,
  });

  // Mock routeWithLaya
  const candidates = [
    { id: 'test-runner', description: 'Run test suites' },
    { id: 'lint-check', description: 'Run linter' },
    { id: 'git-commit', description: 'Commit changes' },
  ];

  // Invoke with prompt and candidates
  const output = await router.invoke({
    prompt: 'Run the unit test suite and report failures',
    candidates,
    routingFn: async (_p, _c, _opts) => ['test-runner'],
  });

  assert.deepEqual(output.selectedSkillIds, ['test-runner']);
  assert.equal(output.fallbackApplied, false);
});

test('resolveAndRouteSkills discovers candidate skills from .agent-skills directory', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-skills-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const agentSkillsDir = path.join(tmpDir, '.agent-skills');
  const skillADir = path.join(agentSkillsDir, 'skill-a');
  const skillBDir = path.join(agentSkillsDir, 'skill-b');
  fs.mkdirSync(skillADir, { recursive: true });
  fs.mkdirSync(skillBDir, { recursive: true });
  fs.writeFileSync(path.join(skillADir, 'SKILL.md'), 'Skill A instructions');
  fs.writeFileSync(path.join(skillBDir, 'SKILL.md'), 'Skill B instructions');

  const resolved = await resolveAndRouteSkills({ rootDir: tmpDir }, 'Run task');
  assert.equal(resolved.candidateSkills.length, 2);
  assert.ok(resolved.selectedSkillPaths.length > 0);
});

test('resolveAndRouteSkills respects pre-computed skillRouterMetrics and short-circuits', async () => {
  const existingMetrics = {
    backend: 'laya',
    totalSkills: 5,
    usedSkills: 2,
    contextReductionPercent: 60.0,
  };
  const preSelectedPaths = ['/skills/alpha', '/skills/beta'];

  const resolved = await resolveAndRouteSkills({
    skillPaths: preSelectedPaths,
    skillRouterMetrics: existingMetrics,
  }, 'Any prompt');

  assert.equal(resolved.routingMetrics, existingMetrics);
  assert.deepEqual(resolved.selectedSkillPaths, preSelectedPaths);
  assert.deepEqual(resolved.candidateSkills, preSelectedPaths);
});

test('resolveAndRouteSkills handles empty or single candidates gracefully without error', async () => {
  const emptyResult = await resolveAndRouteSkills({}, 'Hello world');
  assert.deepEqual(emptyResult.candidateSkills, []);
  assert.deepEqual(emptyResult.selectedSkillPaths, []);
  assert.equal(emptyResult.routingMetrics, null);

  const singleResult = await resolveAndRouteSkills({ skillPaths: ['/skills/one'] }, 'Hello world');
  assert.deepEqual(singleResult.candidateSkills, ['/skills/one']);
  assert.deepEqual(singleResult.selectedSkillPaths, ['/skills/one']);
  assert.equal(singleResult.routingMetrics, null);
});
