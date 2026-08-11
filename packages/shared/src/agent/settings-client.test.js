'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveEffectiveSettings, resolveOrgEffectivePolicy, authHeaders } = require('./settings-client');

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
  const h = authHeaders({ userToken: 'u', s2sToken: 's' });
  assert.equal(h.authorization, 'Bearer s');
  assert.equal(h['x-forwarded-authorization'], 'Bearer u');
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
    projectId: 'p1',
    fetchImpl,
  });

  assert.deepEqual(out.effectivePolicy.harness.effective, ['deepagent']);
  assert.equal(out.geminiApiKey, 'plain-secret');
  // The project scope is forwarded as a query param on both calls.
  assert.ok(fetchImpl.calls.every((c) => c.url.includes('project_id=p1')));
});

test('resolveEffectiveSettings fails open (no throw) when the service is unavailable', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const out = await resolveEffectiveSettings({ baseUrl: 'http://settings', userToken: 'u', fetchImpl });
  assert.equal(out.effectivePolicy, null);
  assert.equal(out.geminiApiKey, '');
  assert.deepEqual(out.values, {});
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

test('resolveOrgEffectivePolicy fails open (null) without token/org and on error', async () => {
  // Missing internal token → no call, allow-all.
  const noTok = await resolveOrgEffectivePolicy({ baseUrl: 'http://settings', orgId: 'o', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(noTok.effectivePolicy, null);
  // Service error → allow-all (never throws).
  const err = await resolveOrgEffectivePolicy({ baseUrl: 'http://settings', orgId: 'o', internalToken: 't', fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
  assert.equal(err.effectivePolicy, null);
});
