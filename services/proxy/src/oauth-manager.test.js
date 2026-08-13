'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const manager = require('./oauth-manager');

test('org Codex resolver consumes a fresh encrypted-vault bundle without legacy store access', async () => {
  const now = Date.now();
  const bundle = {
    accessToken: 'org-access',
    refreshToken: 'org-refresh',
    idToken: '',
    tokenType: 'Bearer',
    scope: 'openid',
    expiresAt: now + 3_600_000,
    obtainedAt: now,
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          org_id: 'org-1',
          secrets: {
            codexTokenBundle: { source: 'customer', value: JSON.stringify(bundle) },
          },
        };
      },
    };
  };

  const resolved = await manager.ensureFreshOrgCodexTokens({
    orgId: 'org-1', orgInternalToken: 'org-token', fetchImpl,
  });
  assert.deepEqual(resolved, bundle);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/v1\/internal\/s2s\/orgs\/org-1\/secrets$/);
  assert.equal(calls[0].init.method, 'GET');
});

test('org Codex resolver honors the fleet org pin used by static credential resolution', async () => {
  const now = Date.now();
  const bundle = {
    accessToken: 'fleet-access',
    refreshToken: 'fleet-refresh',
    idToken: '',
    tokenType: 'Bearer',
    scope: 'openid',
    expiresAt: now + 3_600_000,
    obtainedAt: now,
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          org_id: 'org-fleet',
          secrets: {
            codexTokenBundle: { source: 'customer', value: JSON.stringify(bundle) },
          },
        };
      },
    };
  };

  const resolved = await manager.ensureFreshOrgCodexTokens({
    env: { FLEET_ORG_ID: 'org-fleet' },
    orgInternalToken: 'org-token',
    fetchImpl,
  });

  assert.deepEqual(resolved, bundle);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/v1\/internal\/s2s\/orgs\/org-fleet\/secrets$/);
});

test('org Codex resolver rejects conflicting proxy and fleet organization pins', async () => {
  await assert.rejects(
    () => manager.ensureFreshOrgCodexTokens({
      env: { PROXY_ORG_ID: 'org-a', FLEET_ORG_ID: 'org-b' },
      fetchImpl: async () => { throw new Error('must not fetch'); },
    }),
    /must identify the same organization/,
  );
});

test('org Codex resolver fails closed for an explicitly missing customer bundle', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        org_id: 'org-1',
        secrets: {
          codexTokenBundle: { source: 'customer', value: null, error: 'missing' },
        },
      };
    },
  });

  await assert.rejects(
    () => manager.ensureFreshOrgCodexTokens({
      orgId: 'org-1', orgInternalToken: 'org-token', fetchImpl,
    }),
    (error) => error.name === 'FailClosed' && error.status === 502,
  );
});

test('org Codex resolver fails closed for a malformed customer bundle', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        org_id: 'org-1',
        secrets: {
          codexTokenBundle: { source: 'customer', value: 'not-json' },
        },
      };
    },
  });

  await assert.rejects(
    () => manager.ensureFreshOrgCodexTokens({
      orgId: 'org-1', orgInternalToken: 'org-token', fetchImpl,
    }),
    (error) => error.name === 'FailClosed' && error.status === 502,
  );
});

test('parseBundle rejects invalid vault values', () => {
  assert.equal(manager._test.parseBundle(null), null);
  assert.equal(manager._test.parseBundle({ value: 'not json' }), null);
});
