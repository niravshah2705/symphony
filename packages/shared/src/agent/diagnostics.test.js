'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { endpoint, packageAvailable, runDiagnostics } = require('./diagnostics');

function response(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { async cancel() {} },
  };
}

const configuredSettings = {
  planningProvider: 'jira',
  jiraBaseUrl: 'https://jira.example.com',
  jiraEmail: 'person@example.com',
  jiraApiToken: 'jira-secret',
  repositoryProvider: 'gitlab',
  repositoryUrl: 'group/project',
  gitlabToken: 'gitlab-secret',
  langsmithTracing: true,
  langsmithApiKey: 'langsmith-secret',
  langsmithProject: 'project',
  byomProvider: 'ollama',
  ollamaHost: 'http://127.0.0.1:11434',
  ollamaModel: 'local-model',
  codexTokens: { accessToken: 'codex-secret' },
  claudeTokens: { refreshToken: 'claude-secret' },
};

test('diagnostic endpoint builder removes credentials and replaces the path', () => {
  assert.equal(
    endpoint('https://user:password@example.com/internal?token=secret', '/health'),
    'https://example.com/health'
  );
  assert.equal(endpoint('file:///tmp/socket', '/health'), null);
});

test('package detection recognizes installed ESM packages without a default export', () => {
  const error = new Error('No exports main defined');
  error.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
  assert.equal(packageAvailable('@scope/esm-sdk', () => { throw error; }, {
    resolvePaths: () => ['/workspace/node_modules'],
    existsSync: (file) => file === '/workspace/node_modules/@scope/esm-sdk/package.json',
  }), true);
  assert.equal(packageAvailable('@scope/missing-sdk', () => { throw error; }, {
    resolvePaths: () => ['/workspace/node_modules'],
    existsSync: () => false,
  }), false);
});

test('diagnostics report services, local model, integrations, and SDK readiness without secrets', async () => {
  const requested = [];
  const report = await runDiagnostics(configuredSettings, {
    services: { plannerUrl: 'http://planner.internal:4010', coderUrl: 'http://coder.internal:4020' },
    fetch: async (url) => {
      requested.push(url);
      return response(200);
    },
    resolvePackage: () => '/installed/package.js',
    readLogTail: async () => ({ text: '[2026-07-16T11:59:00.000Z] INFO  Ready\n', bytesRead: 42, exists: true }),
    now: '2026-07-16T12:00:00.000Z',
  });

  assert.equal(report.status, 'healthy');
  assert.equal(report.generatedAt, '2026-07-16T12:00:00.000Z');
  assert.deepEqual(requested.sort(), [
    'http://127.0.0.1:11434/api/tags',
    'http://coder.internal:4020/api/coder',
    'http://planner.internal:4010/api/agent/status',
  ]);
  const ids = new Set(report.checks.map((item) => item.id));
  for (const id of [
    'planner-service', 'coder-service', 'local-model', 'planning-integration', 'repository-integration',
    'service-log', 'langsmith-integration', 'deepagents-sdk', 'codex-sdk', 'claude-sdk',
  ]) assert.equal(ids.has(id), true, id);

  const serialized = JSON.stringify(report);
  for (const secret of ['jira-secret', 'gitlab-secret', 'langsmith-secret', 'codex-secret', 'claude-secret']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes('planner.internal'), false);
});

test('diagnostics distinguish unavailable endpoints and missing SDK packages', async () => {
  const report = await runDiagnostics({
    byomProvider: 'lmstudio',
    lmstudioHost: 'http://localhost:1234',
    lmstudioModel: 'model',
    planningProvider: 'linear',
    repositoryProvider: 'github',
  }, {
    services: { plannerUrl: 'http://localhost:4010', coderUrl: 'http://localhost:4020' },
    fetch: async () => { throw new Error('connection refused with private detail'); },
    resolvePackage: () => { throw new Error('missing'); },
    readLogTail: async () => ({ text: '[2026-07-16T11:59:00.000Z] ERROR secret detail omitted\n', bytesRead: 60, exists: true }),
  });

  assert.equal(report.status, 'degraded');
  assert.equal(report.checks.find((item) => item.id === 'planner-service').status, 'unavailable');
  assert.equal(report.checks.find((item) => item.id === 'codex-sdk').details.installed, false);
  assert.equal(JSON.stringify(report).includes('private detail'), false);
});
