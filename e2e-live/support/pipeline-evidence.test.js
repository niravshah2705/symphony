'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  boundedSafeText,
  jsonRequest,
  latestStageRuns,
  mergeEvidence,
  stageSummary,
} = require('./pipeline-evidence');

test('boundedSafeText redacts bearer-shaped credentials and control characters', () => {
  const jwt = `eyJ${'a'.repeat(40)}.${'b'.repeat(30)}.${'c'.repeat(30)}`;
  const value = boundedSafeText(`failure\nBearer ${jwt}\tcontinued`);
  assert.equal(value, 'failure [redacted] continued');
});

test('latestStageRuns and stageSummary select the newest attempt in canonical order', () => {
  const status = {
    stages: [
      { stage: 'code', attempt: 1, status: 'failed' },
      { stage: 'plan', attempt: 1, status: 'succeeded' },
      { stage: 'code', attempt: 2, status: 'waiting' },
    ],
  };
  assert.equal(latestStageRuns(status).get('code').attempt, 2);
  assert.deepEqual(stageSummary(status), [
    'plan: succeeded',
    'code: waiting',
    'test: pending',
    'deploy: pending',
  ]);
});

test('jsonRequest owns auth and tenant context headers without leaking them in errors', async () => {
  let observed;
  const response = await jsonRequest('https://qa.example.test/', '/api/example', {
    method: 'POST',
    token: 'secret-browser-token',
    organizationId: 'org-a',
    projectId: 'project-a',
    body: { ok: true },
    expectedStatuses: [202],
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(response.status, 202);
  assert.equal(observed.url, 'https://qa.example.test/api/example');
  assert.equal(observed.init.headers.authorization, 'Bearer secret-browser-token');
  assert.equal(observed.init.headers['x-ai-fleet-organization-id'], 'org-a');
  assert.equal(observed.init.headers['x-ai-fleet-project-id'], 'project-a');
  assert.equal(observed.init.body, '{"ok":true}');
});

test('jsonRequest rejects off-origin and non-API targets before fetch', async () => {
  let called = false;
  const options = {
    token: 'token',
    organizationId: 'org-a',
    projectId: 'project-a',
    fetchImpl: async () => { called = true; },
  };
  await assert.rejects(
    jsonRequest('https://qa.example.test', 'https://attacker.example.test/api/data', options),
    /selected gateway/,
  );
  await assert.rejects(
    jsonRequest('https://qa.example.test', '/config.js', options),
    /selected gateway/,
  );
  assert.equal(called, false);
});

test('mergeEvidence preserves existing scenarios and creates a private manifest', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-fleet-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mergeEvidence(directory, 'anonymous', { result: 'passed' });
  const filename = mergeEvidence(directory, 'fullPipeline', { result: 'passed' });
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), {
    anonymous: { result: 'passed' },
    fullPipeline: { result: 'passed' },
  });
  assert.equal(fs.statSync(filename).mode & 0o077, 0);
});
