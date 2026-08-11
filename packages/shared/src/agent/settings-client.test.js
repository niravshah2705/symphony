'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveEffectiveSettings,
  resolveOrgEffectivePolicy,
  authHeaders,
  isPolicyUnavailableError,
} = require('./settings-client');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const match = Object.keys(routes).find((key) => url.includes(key));
    if (!match) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[match] };
  };
  impl.calls = calls;
  return impl;
}

test('authHeaders: S2S token in Authorization, user token forwarded', () => {
  const h = authHeaders({
    userToken: 'u', s2sToken: 's', organizationId: 'org-1', projectId: 'project-1',
  });
  assert.equal(h.authorization, 'Bearer s');
  assert.equal(h['x-forwarded-authorization'], 'Bearer u');
  assert.equal(h['x-ai-fleet-organization-id'], 'org-1');
  assert.equal(h['x-ai-fleet-project-id'], 'project-1');
});

test('authHeaders: direct user token when no S2S token', () => {
  const h = authHeaders({ userToken: 'Bearer u' });
  assert.equal(h.authorization, 'Bearer u'); // already-prefixed token not double-prefixed
  assert.equal(h['x-forwarded-authorization'], undefined);
});

test('resolveEffectiveSettings returns the policy domains and the unmasked gemini key', async () => {
  const fetchImpl = fakeFetch({
    '/api/v1/settings/effective': {
      domains: { harness: { effective: ['deepagent'] }, tools: { effective: ['quality'] } },
      values: { geminiApiKey: { set: true } },
    },
    '/api/v1/internal/effective-config': { values: { geminiApiKey: 'plain-secret' } },
  });

  const out = await resolveEffectiveSettings({
    baseUrl: 'http://settings',
    userToken: 'user-token',
    organizationId: 'org-1',
    projectId: 'p1',
    fetchImpl,
  });

  assert.deepEqual(out.effectivePolicy.harness.effective, ['deepagent']);
  assert.equal(out.geminiApiKey, 'plain-secret');
  // The project scope is forwarded as a query param on both calls.
  assert.ok(fetchImpl.calls.every((c) => c.url.includes('project_id=p1')));
  assert.ok(fetchImpl.calls.every((c) => c.init.headers['x-ai-fleet-organization-id'] === 'org-1'));
  assert.ok(fetchImpl.calls.every((c) => c.init.headers['x-ai-fleet-project-id'] === 'p1'));
});

test('resolveEffectiveSettings keeps empty local context allow-all when the service is unavailable', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const out = await resolveEffectiveSettings({ baseUrl: 'http://settings', userToken: 'u', fetchImpl });
  assert.equal(out.effectivePolicy, null);
  assert.equal(out.geminiApiKey, '');
  assert.deepEqual(out.values, {});
});

test('resolveEffectiveSettings fails closed for a selected org on missing config, HTTP failure, or missing policy', async () => {
  await assert.rejects(
    () => resolveEffectiveSettings({ organizationId: 'org-1', baseUrl: '', fetchImpl: async () => ({}) }),
    (error) => isPolicyUnavailableError(error) && error.status === 503,
  );
  await assert.rejects(
    () => resolveEffectiveSettings({
      organizationId: 'org-1',
      baseUrl: 'http://settings',
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    }),
    isPolicyUnavailableError,
  );
  await assert.rejects(
    () => resolveEffectiveSettings({
      organizationId: 'org-1',
      baseUrl: 'http://settings',
      fetchImpl: fakeFetch({
        '/api/v1/settings/effective': { prefs: {} },
        '/api/v1/internal/effective-config': { values: {} },
      }),
    }),
    isPolicyUnavailableError,
  );
});

test('resolveEffectiveSettings fails closed when selected-org config resolution fails after policy', async () => {
  await assert.rejects(
    () => resolveEffectiveSettings({
      organizationId: 'org-1',
      baseUrl: 'http://settings',
      fetchImpl: fakeFetch({
        '/api/v1/settings/effective': { domains: { harness: { effective: ['deepagent'] } } },
      }),
    }),
    isPolicyUnavailableError,
  );
});

test('resolveEffectiveSettings is a no-op without a baseUrl (local single-user)', async () => {
  const out = await resolveEffectiveSettings({ userToken: 'u', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(out.effectivePolicy, null);
  assert.equal(out.geminiApiKey, '');
});

test('resolveOrgEffectivePolicy returns org effective domains, token-gated (S2S)', async () => {
  const fetchImpl = fakeFetch({
    '/api/v1/internal/s2s/orgs/org-1/effective-policy': {
      domains: {
        harness: { org: ['deepagent'], project: ['deepagent'], user: ['deepagent'], effective: ['deepagent'] },
        models: { org: ['claude-opus-4-8'], project: ['claude-opus-4-8'], user: ['claude-opus-4-8'], effective: ['claude-opus-4-8'] },
      },
    },
  });
  const out = await resolveOrgEffectivePolicy({
    baseUrl: 'http://settings', orgId: 'org-1', internalToken: 'tok', authBearer: 'Bearer oidc', fetchImpl,
  });
  assert.deepEqual(out.effectivePolicy.harness.effective, ['deepagent']);
  assert.deepEqual(out.effectivePolicy.models.effective, ['claude-opus-4-8']);
  // X-Internal-Token + OIDC bearer sent; org id is the route scope.
  const call = fetchImpl.calls[0];
  assert.equal(call.init.headers['x-internal-token'], 'tok');
  assert.equal(call.init.headers.authorization, 'Bearer oidc');
  assert.ok(call.url.includes('/orgs/org-1/effective-policy'));
});

test('resolveOrgEffectivePolicy is local allow-all without org and selected-org fail-closed otherwise', async () => {
  const local = await resolveOrgEffectivePolicy({ baseUrl: '', orgId: '', internalToken: '' });
  assert.equal(local.effectivePolicy, null);

  await assert.rejects(
    () => resolveOrgEffectivePolicy({
      baseUrl: 'http://settings', orgId: 'o', internalToken: '', fetchImpl: async () => ({}),
    }),
    isPolicyUnavailableError,
  );
  await assert.rejects(
    () => resolveOrgEffectivePolicy({
      baseUrl: 'http://settings',
      orgId: 'o',
      internalToken: 't',
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    }),
    isPolicyUnavailableError,
  );
  await assert.rejects(
    () => resolveOrgEffectivePolicy({
      baseUrl: 'http://settings',
      orgId: 'o',
      internalToken: 't',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ prefs: {} }) }),
    }),
    isPolicyUnavailableError,
  );
});

test('resolveEffectiveSettings surfaces resolved operational prefs', async () => {
  const fetchImpl = fakeFetch({
    '/api/v1/settings/effective': { domains: {}, prefs: { complexityTier: 'balanced', agentRuntime: 'codex-sdk' } },
    '/api/v1/internal/effective-config': { values: {} },
  });
  const out = await resolveEffectiveSettings({ baseUrl: 'http://settings', userToken: 'u', fetchImpl });
  assert.deepEqual(out.prefs, { complexityTier: 'balanced', agentRuntime: 'codex-sdk' });
  // Fail-open default is an empty prefs object.
  const empty = await resolveEffectiveSettings({ baseUrl: 'http://settings', userToken: 'u', fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  assert.deepEqual(empty.prefs, {});
});

test('resolveOrgEffectivePolicy surfaces org-resolved prefs', async () => {
  const fetchImpl = fakeFetch({
    '/api/v1/internal/s2s/orgs/org-1/effective-policy': {
      domains: { harness: { effective: ['deepagent'] } },
      prefs: { agentRuntime: 'deepagent' },
    },
  });
  const out = await resolveOrgEffectivePolicy({ baseUrl: 'http://settings', orgId: 'org-1', internalToken: 'tok', fetchImpl });
  assert.deepEqual(out.prefs, { agentRuntime: 'deepagent' });
});
