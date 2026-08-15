'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeValidatedContext, createContextValidationMiddleware, shouldSkip } = require('./context-validator');

const DATA = {
  user: { id: 'user-1', email: 'u@example.com' },
  organizations: [
    { id: 'org-1', role: 'MEMBER', projects: [{ id: 'project-1' }] },
    { id: 'org-2', role: 'ORG_ADMIN', projects: [{ id: 'project-2' }] },
  ],
};

function makeReq(headers = {}) {
  return {
    auth: { authenticated: true, mode: 'firebase' },
    originalUrl: '/api/settings-policy/settings/effective',
    headers,
    get: (name) => headers[String(name).toLowerCase()] || '',
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('normalizes requested accessible organization/project and defaults safely', () => {
  assert.deepEqual(normalizeValidatedContext(DATA, {
    organizationId: 'org-2', projectId: 'project-2',
  }), { organizationId: 'org-2', projectId: 'project-2' });
  assert.deepEqual(normalizeValidatedContext({
    organizations: [{ id: 'org-1', projects: [{ id: 'project-1' }] }],
  }), { organizationId: 'org-1', projectId: 'project-1' });
});

test('rejects a project from another organization', () => {
  assert.throws(
    () => normalizeValidatedContext(DATA, { organizationId: 'org-1', projectId: 'project-2' }),
    (error) => error.status === 404
  );
});

test('multi-org and multi-project callers must carry the explicit top selection', () => {
  const organizations = [
    { id: 'org-a', projects: [{ id: 'project-a' }] },
    { id: 'org-b', projects: [{ id: 'project-b' }] },
  ];
  assert.throws(
    () => normalizeValidatedContext({ organizations }, {}),
    (error) => error.status === 400 && /explicit organization/.test(error.message),
  );
  assert.throws(
    () => normalizeValidatedContext({ organizations: [{
      id: 'org-a', projects: [{ id: 'project-a' }, { id: 'project-b' }],
    }] }, { organizationId: 'org-a' }),
    (error) => error.status === 400 && /explicit project/.test(error.message),
  );
});

test('middleware forwards selection to org service and attaches validated context', async () => {
  let call = null;
  const middleware = createContextValidationMiddleware({
    orgUrl: 'http://org',
    callJson: async (...args) => { call = args; return { status: 200, data: DATA }; },
  });
  const req = makeReq({
    authorization: 'Bearer user',
    'x-ai-fleet-organization-id': 'org-2',
    'x-ai-fleet-project-id': 'project-2',
  });
  const res = makeRes();
  let nexted = false;
  await middleware(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.deepEqual(req.fleetContext, { organizationId: 'org-2', projectId: 'project-2' });
  assert.equal(call[1], '/api/v1/me/context');
  assert.deepEqual(call[2].context, { organizationId: 'org-2', projectId: 'project-2', llmGateway: '' });
});

test('middleware fails closed when authoritative context is unavailable', async () => {
  const middleware = createContextValidationMiddleware({
    orgUrl: 'http://org',
    callJson: async () => ({ status: 502, data: null }),
  });
  const res = makeRes();
  await middleware(makeReq({ authorization: 'Bearer user' }), res, () => assert.fail('must not continue'));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'context_unavailable');
});

test('dedicated gateway rejects an authenticated caller with no membership', async () => {
  const middleware = createContextValidationMiddleware({
    orgUrl: 'https://org.internal',
    pinnedOrganizationId: 'org-pinned',
    callJson: async () => ({ status: 200, data: { user: { id: 'user-1' }, organizations: [] } }),
  });
  const req = {
    auth: { authenticated: true, mode: 'firebase' },
    headers: {},
    get(name) { return this.headers[String(name).toLowerCase()] || ''; },
    originalUrl: '/api/agent/jobs',
  };
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  };
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(statusCode, 404);
  assert.equal(body.code, 'context_not_found');
});

test('only store-free locale suggestions bypass workspace validation', () => {
  assert.equal(shouldSkip({ originalUrl: '/api/locale/suggestions?languages=gu-IN' }), true);
  assert.equal(shouldSkip({ originalUrl: '/api/locale/translate' }), false);
});
