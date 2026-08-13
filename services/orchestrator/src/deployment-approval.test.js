'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SettingsDeploymentApproval } = require('./deployment-approval');
const COMMIT_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);
const PREFLIGHT_DIGEST = 'c'.repeat(64);

function context() {
  return {
    run: {
      runId: 'run-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      preflight: {
        preflightDecisionDigest: PREFLIGHT_DIGEST,
        repository: { owner: 'acme', name: 'fleet' },
        stageConfiguration: { deploy: { environment: 'production' } },
      },
    },
    testResult: {
      commandId: 'run-1:test:1',
      completedAt: '2026-08-13T10:00:00.000Z',
      artifact: { commitSha: COMMIT_SHA, treeSha: TREE_SHA },
    },
  };
}

test('settings approval client binds the consume call to run, scope, repository, and test time', async () => {
  let seen;
  const client = new SettingsDeploymentApproval({
    settingsUrl: 'https://settings.example.test',
    internalToken: 'internal-token',
    cloud: true,
    identityHeader: async () => 'Bearer service-identity',
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          approved: true,
          approvalId: 'approval-1',
          approvedBy: 'release@example.com',
          approvedAt: '2026-08-13T10:01:00.000Z',
          testCommandId: 'run-1:test:1',
          commitSha: COMMIT_SHA,
          treeSha: TREE_SHA,
          preflightDecisionDigest: PREFLIGHT_DIGEST,
        }),
      };
    },
  });
  assert.deepEqual(await client.assertApproved(context()), {
    approved: true,
    approvalId: 'approval-1',
    by: 'release@example.com',
    at: '2026-08-13T10:01:00.000Z',
    testCommandId: 'run-1:test:1',
    commitSha: COMMIT_SHA,
    treeSha: TREE_SHA,
    preflightDecisionDigest: PREFLIGHT_DIGEST,
  });
  assert.match(seen.url, /orgs\/org-1\/deployment-approvals\/run-1\/consume$/);
  assert.equal(seen.init.headers.authorization, 'Bearer service-identity');
  assert.equal(seen.init.headers['x-internal-token'], 'internal-token');
  assert.deepEqual(JSON.parse(seen.init.body), {
    projectId: 'project-1',
    repository: 'acme/fleet',
    environment: 'production',
    testCompletedAt: '2026-08-13T10:00:00.000Z',
    testCommandId: 'run-1:test:1',
    commitSha: COMMIT_SHA,
    treeSha: TREE_SHA,
    preflightDecisionDigest: PREFLIGHT_DIGEST,
  });
});

test('a success response with different artifact lineage fails closed', async () => {
  const client = new SettingsDeploymentApproval({
    settingsUrl: 'http://settings', internalToken: 'token', cloud: false,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        approved: true,
        testCommandId: 'run-1:test:1',
        commitSha: 'd'.repeat(40),
        treeSha: TREE_SHA,
        preflightDecisionDigest: PREFLIGHT_DIGEST,
      }),
    }),
  });
  await assert.rejects(
    () => client.assertApproved(context()),
    (error) => error.code === 'pipeline_deployment_approval_invalid',
  );
});

test('missing repository identity fails closed before approval consumption', async () => {
  let fetched = false;
  const client = new SettingsDeploymentApproval({
    settingsUrl: 'http://settings', internalToken: 'token', cloud: false,
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
  });
  const value = context();
  value.run.preflight.repository = {};

  await assert.rejects(
    () => client.assertApproved(value),
    (error) => error.code === 'pipeline_deployment_lineage_required',
  );
  assert.equal(fetched, false);
});

test('missing/consumed approval returns null while service outages fail closed', async () => {
  const missing = new SettingsDeploymentApproval({
    settingsUrl: 'http://settings', internalToken: 'token', cloud: false,
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(await missing.assertApproved(context()), null);

  const unavailable = new SettingsDeploymentApproval({
    settingsUrl: 'http://settings', internalToken: 'token', cloud: false,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(
    () => unavailable.assertApproved(context()),
    (error) => error.code === 'pipeline_deployment_approval_unavailable',
  );
});
