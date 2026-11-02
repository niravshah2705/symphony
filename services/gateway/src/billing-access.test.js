'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// The billing org/admin decision is made here and handed to the billing service
// as trusted headers, so these tests pin what the org service's answer becomes.
delete process.env.MESSAGING_MODE;
delete process.env.INTERNAL_API_TOKEN;
delete process.env.FLEET_ORG_ID;
delete process.env.PROXY_ORG_ID;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-billing-access-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;

const { SHARED_ORG_ID } = require('@ai-fleet/shared-core/billing/org-context');
const { resolveCallerOrg, requireBillingCaller, billingTrustedHeaders } = require('./billing-access');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

function callerReq(authorization) {
  const headers = {};
  if (authorization) headers.authorization = authorization;
  return {
    headers,
    originalUrl: '/api/billing/summary',
    get(name) { return headers[String(name).toLowerCase()] || ''; },
  };
}

function stubOrgMe(captured, response) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.url = url;
    captured.headers = init.headers;
    return { status: response.status, text: async () => JSON.stringify(response.body || {}) };
  };
  return () => { globalThis.fetch = original; };
}

test('an org admin resolves to the trusted org + role header pair', async (t) => {
  const captured = {};
  const restore = stubOrgMe(captured, { status: 200, body: { org_id: 'org-1', org_role: 'ORG_ADMIN', user_id: 'u1' } });
  t.after(restore);

  const caller = await resolveCallerOrg(callerReq('Bearer id.jwt.token'));
  assert.deepEqual(caller, { orgId: 'org-1', userId: 'u1', isAdmin: true });
  // The bare-JWT regression: the org service 401s an unscheme'd credential, and
  // a failed lookup fails closed to a non-admin — so the scheme must be added.
  assert.equal(captured.headers['x-forwarded-authorization'], 'Bearer id.jwt.token');
  assert.deepEqual(billingTrustedHeaders({ billingCaller: caller }), {
    'x-ai-fleet-billing-org-id': 'org-1',
    'x-ai-fleet-billing-org-role': 'ORG_ADMIN',
    'x-ai-fleet-billing-user-id': 'u1',
  });
});

test('a member is forwarded as a non-admin and keeps read access only', async (t) => {
  const captured = {};
  const restore = stubOrgMe(captured, { status: 200, body: { org_id: 'org-2', org_role: 'ORG_MEMBER', user_id: 'u2' } });
  t.after(restore);

  const caller = await resolveCallerOrg(callerReq('Bearer id.jwt.token'));
  assert.equal(caller.isAdmin, false);
  assert.equal(billingTrustedHeaders({ billingCaller: caller })['x-ai-fleet-billing-org-role'], 'ORG_MEMBER');
});

test('an org-less caller maps to the shared account without admin', async (t) => {
  const restore = stubOrgMe({}, { status: 200, body: { org_id: '', org_role: '', user_id: 'u3' } });
  t.after(restore);
  const caller = await resolveCallerOrg(callerReq('Bearer id.jwt.token'));
  assert.equal(caller.orgId, SHARED_ORG_ID);
  assert.equal(caller.isAdmin, false);
});

test('a rejected or absent credential fails closed, never as admin', async (t) => {
  const restore = stubOrgMe({}, { status: 401, body: { detail: 'unauthenticated' } });
  t.after(restore);

  const denied = await resolveCallerOrg(callerReq('Bearer expired.jwt'));
  assert.equal(denied.isAdmin, false);
  assert.equal(denied.orgId, SHARED_ORG_ID);

  const anonymous = await resolveCallerOrg(callerReq(''));
  assert.equal(anonymous.isAdmin, false);
});

test('requireBillingCaller attaches the caller and always continues', async () => {
  const restore = stubOrgMe({}, { status: 200, body: { org_id: 'org-4', org_role: 'ORG_ADMIN', user_id: 'u4' } });
  try {
    let continued = false;
    const req = callerReq('Bearer id.jwt.token');
    await new Promise((resolve) => requireBillingCaller(req, {}, () => { continued = true; resolve(); }));
    assert.equal(continued, true);
    assert.equal(req.billingCaller.orgId, 'org-4');
    assert.equal(req.billingCaller.isAdmin, true);
  } finally {
    restore();
  }
});

test('no headers are injected for an unresolved caller', () => {
  assert.deepEqual(billingTrustedHeaders({}), {});
});
