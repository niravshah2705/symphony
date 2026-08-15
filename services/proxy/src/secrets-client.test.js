'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchOrgSecrets,
  fetchOrgEgressConfig,
  rotateOrgCodexTokens,
} = require('./secrets-client');

test('organization secret resolution uses the organization-bound bearer', async () => {
  let request = null;
  await fetchOrgSecrets('org-1', {
    orgInternalToken: 'org-bound-token',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 200, json: async () => ({ org_id: 'org-1', secrets: {} }) };
    },
  });
  assert.equal(request.init.headers['x-org-internal-token'], 'org-bound-token');
  assert.equal(request.init.headers['x-internal-token'], undefined);
});

test('project-scoped secret resolution appends only a validated UUID', async () => {
  let request = null;
  const projectId = '7e2ce8ba-57d3-4d80-bdba-ec18a8d2d348';
  await fetchOrgSecrets('org-1', {
    projectId,
    orgInternalToken: 'org-bound-token',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 200, json: async () => ({ org_id: 'org-1', project_id: projectId, secrets: {} }) };
    },
  });
  assert.match(request.url, new RegExp(`secrets\\?project_id=${projectId}$`));
  await assert.rejects(
    () => fetchOrgSecrets('org-1', {
      projectId: '../../other',
      orgInternalToken: 'org-bound-token',
      fetchImpl: async () => { throw new Error('must not fetch'); },
    }),
    /must be a UUID/,
  );
});

test('organization egress config uses the organization-bound S2S endpoint', async () => {
  let request = null;
  await fetchOrgEgressConfig('org-1', {
    orgInternalToken: 'org-bound-token',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 200, json: async () => ({ jira_origin: null, jira_email: null }) };
    },
  });
  assert.match(request.url, /\/orgs\/org-1\/egress-config$/);
  assert.equal(request.init.headers['x-org-internal-token'], 'org-bound-token');
});

test('organization secret resolution fails closed without an organization bearer', async () => {
  await assert.rejects(
    () => fetchOrgSecrets('org-1', {
      orgInternalToken: '',
      fetchImpl: async () => { throw new Error('must not fetch'); },
    }),
    /requires ORG_INTERNAL_API_TOKEN/,
  );
});

test('Codex rotation uses the token-gated org-scoped settings endpoint', async () => {
  let request = null;
  const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 2, obtainedAt: 1 };
  const response = await rotateOrgCodexTokens('org/unsafe', 1, tokens, {
    orgInternalToken: 'org-bound-token',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 200, json: async () => ({ updated: true, tokens }) };
    },
  });
  assert.equal(response.updated, true);
  assert.match(request.url, /orgs\/org%2Funsafe\/codex-tokens$/);
  assert.equal(request.init.method, 'PUT');
  assert.equal(request.init.headers['content-type'], 'application/json');
  assert.equal(request.init.headers['x-org-internal-token'], 'org-bound-token');
  assert.equal(request.init.headers['x-internal-token'], undefined);
  assert.deepEqual(JSON.parse(request.init.body), { expectedObtainedAt: 1, tokens });
});
