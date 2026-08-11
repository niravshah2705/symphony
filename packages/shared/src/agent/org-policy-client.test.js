'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchOrgEffectivePolicy,
  resolvePolicyOrganization,
  isOrganizationContextMismatch,
  isPolicyUnavailableError,
} = require('./org-policy-client');

test('resolvePolicyOrganization uses selected org on shared deployments and the pin on tenant deployments', () => {
  assert.equal(resolvePolicyOrganization('org-selected', ''), 'org-selected');
  assert.equal(resolvePolicyOrganization(null, 'org-pinned'), 'org-pinned');
  assert.equal(resolvePolicyOrganization('org-pinned', 'org-pinned'), 'org-pinned');
});

test('resolvePolicyOrganization rejects a selected org that conflicts with the tenant pin', () => {
  assert.throws(
    () => resolvePolicyOrganization('org-other', 'org-pinned'),
    (error) => isOrganizationContextMismatch(error) && error.status === 403,
  );
});

test('fetchOrgEffectivePolicy forwards the trusted org and native project to settings', async () => {
  let seen;
  const effectivePolicy = { tools: { effective: ['quality'] } };
  const result = await fetchOrgEffectivePolicy('org-selected', 'native-project-1', {
    pinnedOrgId: '',
    baseUrl: 'http://settings.internal',
    internalToken: 'internal-token',
    authBearer: 'Bearer oidc',
    resolveImpl: async (options) => {
      seen = options;
      return { effectivePolicy, prefs: { agentRuntime: 'deepagent' } };
    },
  });

  assert.equal(seen.orgId, 'org-selected');
  assert.equal(seen.projectId, 'native-project-1');
  assert.equal(seen.internalToken, 'internal-token');
  assert.equal(seen.authBearer, 'Bearer oidc');
  assert.deepEqual(result, { effectivePolicy, prefs: { agentRuntime: 'deepagent' } });
});

test('fetchOrgEffectivePolicy is allow-all only for empty local context', async () => {
  assert.deepEqual(
    await fetchOrgEffectivePolicy('', '', {
      pinnedOrgId: '',
      baseUrl: '',
      internalToken: '',
    }),
    { effectivePolicy: null, prefs: {} },
  );

});

test('fetchOrgEffectivePolicy fails closed for selected-org config, transport, and response failures', async () => {
  await assert.rejects(
    () => fetchOrgEffectivePolicy('org-selected', 'native-project-1', {
      pinnedOrgId: '',
      baseUrl: '',
      internalToken: '',
    }),
    (error) => isPolicyUnavailableError(error) && error.status === 503,
  );

  const warnings = [];
  await assert.rejects(
    () => fetchOrgEffectivePolicy('org-selected', 'native-project-1', {
      pinnedOrgId: '',
      baseUrl: 'http://settings.internal',
      internalToken: 'internal-token',
      authBearer: '',
      resolveImpl: async () => { throw new Error('settings unavailable'); },
      logger: { warn: (message) => warnings.push(message) },
    }),
    isPolicyUnavailableError,
  );
  await assert.rejects(
    () => fetchOrgEffectivePolicy('org-selected', 'native-project-1', {
      pinnedOrgId: '',
      baseUrl: 'http://settings.internal',
      internalToken: 'internal-token',
      authBearer: '',
      resolveImpl: async () => ({ effectivePolicy: null, prefs: {} }),
    }),
    isPolicyUnavailableError,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /settings unavailable/);
});

test('fetchOrgEffectivePolicy checks the tenant pin before transport configuration', async () => {
  await assert.rejects(
    () => fetchOrgEffectivePolicy('org-other', 'native-project-1', {
      pinnedOrgId: 'org-pinned',
      baseUrl: '',
      internalToken: '',
    }),
    (error) => isOrganizationContextMismatch(error),
  );
});
