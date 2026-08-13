'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const admin = require('./admin');

test('operator URL permits loopback HTTP but rejects remote plaintext and embedded credentials', () => {
  assert.equal(
    admin._test.operatorUrl({ 'settings-url': 'http://127.0.0.1:4020/' }),
    'http://127.0.0.1:4020',
  );
  assert.throws(
    () => admin._test.operatorUrl({ 'settings-url': 'http://settings.example.test' }),
    /must use HTTPS/,
  );
  assert.throws(
    () => admin._test.operatorUrl({ 'settings-url': 'https://user:password@settings.example.test' }),
    /must not contain credentials/,
  );
});

test('normalizeBundle accepts Codex CLI auth.json shape without retaining unrelated fields', () => {
  const normalized = admin._test.normalizeBundle({
    auth_mode: 'chatgpt',
    last_refresh: '2026-08-12T00:00:00.000Z',
    tokens: {
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: 'id',
      account_id: 'must-not-be-copied',
    },
  }, 123);
  assert.deepEqual(normalized, {
    accessToken: 'access',
    refreshToken: 'refresh',
    idToken: 'id',
    tokenType: 'Bearer',
    scope: 'openid profile email offline_access',
    expiresAt: 123,
    obtainedAt: Date.parse('2026-08-12T00:00:00.000Z'),
  });
});

test('operator request separates Cloud Run IAM and forwarded user identity', async () => {
  let seen;
  const client = { token: 'firebase-user' };
  const result = await admin._test.requestOperator({
    client,
    flags: {
      'settings-url': 'https://settings.example.test',
      'org-id': '11111111-1111-4111-8111-111111111111',
    },
    method: 'PUT',
    body: { tokens: { accessToken: 'secret' } },
    iamHeaderImpl: async () => 'Bearer cloud-run-iam',
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => '{"configured":true}' };
    },
  });
  assert.equal(result.configured, true);
  assert.equal(seen.init.headers.authorization, 'Bearer cloud-run-iam');
  assert.equal(seen.init.headers['x-forwarded-authorization'], 'Bearer firebase-user');
  assert.equal(seen.init.headers['x-ai-fleet-organization-id'], '11111111-1111-4111-8111-111111111111');
});

test('operator request supports a run-bound deployment approval path', async () => {
  let seen;
  await admin._test.requestOperator({
    client: { token: 'firebase-user' },
    flags: {
      'settings-url': 'http://127.0.0.1:4020',
      'org-id': '11111111-1111-4111-8111-111111111111',
    },
    method: 'PUT',
    path: '/api/v1/operator/deployment-approvals/run-1',
    body: { projectId: 'project-1' },
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => '{"approved":true}' };
    },
  });
  assert.equal(seen.url, 'http://127.0.0.1:4020/api/v1/operator/deployment-approvals/run-1');
  assert.equal(JSON.parse(seen.init.body).projectId, 'project-1');
});

test('deployment approval lineage is derived from the authenticated, scoped pipeline status', async () => {
  const commitSha = 'a'.repeat(40);
  const treeSha = 'b'.repeat(40);
  const preflightDecisionDigest = 'c'.repeat(64);
  let seen;
  const lineage = await admin._test.pendingDeploymentApproval({
    client: {
      async request(...args) {
        seen = args;
        return {
          run: {
            runId: 'run-1',
            organizationId: '11111111-1111-4111-8111-111111111111',
            projectId: '22222222-2222-4222-8222-222222222222',
            status: 'awaiting_approval',
            pendingDeploymentApproval: {
              runId: 'run-1',
              projectId: '22222222-2222-4222-8222-222222222222',
              repository: 'acme/fleet',
              environment: 'production',
              testCommandId: 'run-1:test:1',
              commitSha,
              treeSha,
              preflightDecisionDigest,
            },
          },
        };
      },
    },
    flags: { 'org-id': '11111111-1111-4111-8111-111111111111' },
    runId: 'run-1',
    projectId: '22222222-2222-4222-8222-222222222222',
    repository: 'acme/fleet',
    environment: 'production',
  });
  assert.equal(seen[0], 'GET');
  assert.equal(seen[1], '/api/pipeline/runs/run-1');
  assert.deepEqual(seen[3].headers, {
    'x-ai-fleet-organization-id': '11111111-1111-4111-8111-111111111111',
    'x-ai-fleet-project-id': '22222222-2222-4222-8222-222222222222',
  });
  assert.deepEqual(lineage, {
    testCommandId: 'run-1:test:1',
    commitSha,
    treeSha,
    preflightDecisionDigest,
  });
});

test('deployment approval refuses a mismatched pending scope', async () => {
  await assert.rejects(
    () => admin._test.pendingDeploymentApproval({
      client: {
        async request() {
          return {
            run: {
              runId: 'run-1',
              organizationId: '11111111-1111-4111-8111-111111111111',
              projectId: '22222222-2222-4222-8222-222222222222',
              status: 'awaiting_approval',
              pendingDeploymentApproval: {
                runId: 'run-1',
                projectId: '22222222-2222-4222-8222-222222222222',
                repository: 'attacker/other',
                environment: 'production',
              },
            },
          };
        },
      },
      flags: { 'org-id': '11111111-1111-4111-8111-111111111111' },
      runId: 'run-1',
      projectId: '22222222-2222-4222-8222-222222222222',
      repository: 'acme/fleet',
      environment: 'production',
    }),
    /does not match/,
  );
});
