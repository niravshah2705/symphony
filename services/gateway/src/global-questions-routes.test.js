'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');

const { mountGlobalQuestionsRoutes, callerIdentity, BASE_PATH } = require('./global-questions-routes');
const { requireAuthenticated, requirePermission } = require('./auth');
const { requireOrganizationContext } = require('./request-context');
const { requireEulaAccepted } = require('./eula');
const { PUBLIC_PERMISSIONS, ROLE_PERMISSIONS } = require('@ai-fleet/shared-core/authz');

const IDENTITIES = {
  anonymous: { authenticated: false, mode: 'firebase', user: null, permissions: PUBLIC_PERMISSIONS },
  viewer: { authenticated: true, mode: 'firebase', user: { sub: 'u-viewer' }, permissions: ROLE_PERMISSIONS.viewer },
  admin: { authenticated: true, mode: 'firebase', user: { sub: 'u-admin', email: 'a@t.test' }, permissions: ROLE_PERMISSIONS.admin },
};

/**
 * A gateway app with the real auth/context/EULA gates and a stub proxy, so a
 * request that reaches the proxy proves the chain let it through and a 401/403
 * proves it did not. `identity` and `organizationId` stand in for the auth
 * middleware and the browser's selected-org header.
 */
function buildApp({ identity = IDENTITIES.viewer, eulaAccepted = true } = {}) {
  const forwarded = [];
  const state = { identity, organizationId: 'org_a' };
  const app = express();

  app.use((req, _res, next) => {
    // Stands in for createAuthenticationMiddleware: the gates read req.auth, and
    // the selected org arrives as the forwarded context header.
    req.auth = state.identity;
    if (state.organizationId) req.headers['x-ai-fleet-organization-id'] = state.organizationId;
    else delete req.headers['x-ai-fleet-organization-id'];
    next();
  });

  const proxy = (req, res) => {
    forwarded.push({ method: req.method, path: req.originalUrl });
    res.json({ proxied: true });
  };

  mountGlobalQuestionsRoutes(app, {
    proxy,
    gates: {
      requireAuthenticated,
      requirePermission,
      requireOrganizationContext,
      requireEulaAccepted: () => requireEulaAccepted({ readUser: () => (eulaAccepted ? { status: 'accepted', version: '1.0.0' } : null) }),
    },
  });
  // The catch-all that normally follows these mounts in index.js, so the ordering
  // is tested rather than assumed.
  app.use('/api/agent', requireAuthenticated(), requirePermission('workspace'), requireOrganizationContext(), proxy);

  return { app, forwarded, state };
}

async function start(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function call(base, method, path, headers = {}) {
  const response = await fetch(`${base}${path}`, { method, headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('the bank mounts three routes ahead of the /api/agent catch-all', () => {
  const mounted = [];
  const recorderApp = {
    post: (path, ...handlers) => mounted.push({ verb: 'POST', path, count: handlers.length }),
    use: (path, ...handlers) => mounted.push({ verb: 'USE', path, count: handlers.length }),
  };
  mountGlobalQuestionsRoutes(recorderApp, { proxy: function proxy() {} });

  assert.deepEqual(mounted.map((entry) => `${entry.verb} ${entry.path}`), [
    `POST ${BASE_PATH}/coverage`,
    `POST ${BASE_PATH}/ai-assist`,
    `USE ${BASE_PATH}`,
  ]);
  // 3 gates + proxy for the bank, 4 gates + proxy for the two model-backed routes.
  assert.deepEqual(mounted.map((entry) => entry.count), [5, 5, 4]);
});

test('anonymous callers never reach the coverage proxy, even though workspace:read is public', async () => {
  const { app, forwarded } = buildApp({ identity: IDENTITIES.anonymous });
  const { server, url } = await start(app);
  try {
    const coverage = await call(url, 'POST', `${BASE_PATH}/coverage`);
    assert.equal(coverage.status, 401);
    const bank = await call(url, 'GET', BASE_PATH);
    assert.equal(bank.status, 401);
    assert.deepEqual(forwarded, [], 'an unauthenticated read must not surface tenant memories');
  } finally {
    server.close();
  }
});

test('a viewer may read the bank and run coverage but cannot edit or draft', async () => {
  const { app, forwarded } = buildApp({ identity: IDENTITIES.viewer });
  const { server, url } = await start(app);
  try {
    assert.equal((await call(url, 'GET', BASE_PATH)).status, 200);
    assert.equal((await call(url, 'POST', `${BASE_PATH}/coverage`)).status, 200);
    assert.equal((await call(url, 'POST', `${BASE_PATH}/ai-assist`)).status, 403, 'drafting needs settings:write');
    assert.equal((await call(url, 'POST', BASE_PATH, { 'content-type': 'application/json' })).status, 403);

    assert.deepEqual(forwarded.map((entry) => entry.method), ['GET', 'POST'], 'only the two permitted calls were proxied');
  } finally {
    server.close();
  }
});

test('an admin edit is proxied on its full path', async () => {
  const { app, forwarded } = buildApp({ identity: IDENTITIES.admin });
  const { server, url } = await start(app);
  try {
    const result = await call(url, 'PUT', `${BASE_PATH}/gq_org_01`, { 'content-type': 'application/json' });
    assert.equal(result.status, 200);
    assert.deepEqual(forwarded, [{ method: 'PUT', path: `${BASE_PATH}/gq_org_01` }]);
  } finally {
    server.close();
  }
});

test('the caller identity injected for the planner is session-derived, never body-derived', () => {
  assert.deepEqual(callerIdentity({ auth: { user: { sub: 'U-1', email: 'a@t.test' } } }), { 'x-ai-fleet-user-id': 'U-1' });
  assert.deepEqual(callerIdentity({ auth: { user: { email: 'a@t.test' } } }), { 'x-ai-fleet-user-id': 'a@t.test' });
  assert.deepEqual(callerIdentity({ auth: { user: null } }), { 'x-ai-fleet-user-id': '' });
  assert.deepEqual(callerIdentity({}), { 'x-ai-fleet-user-id': '' }, 'no session means no attribution, not a client-supplied one');
});

test('both model-backed routes require EULA acceptance; plain bank reads do not', async () => {
  const blocked = buildApp({ identity: IDENTITIES.admin, eulaAccepted: false });
  const { server, url } = await start(blocked.app);
  try {
    const coverage = await call(url, 'POST', `${BASE_PATH}/coverage`);
    assert.equal(coverage.status, 403);
    assert.equal(coverage.body.code, 'EULA_REQUIRED');
    assert.equal((await call(url, 'POST', `${BASE_PATH}/ai-assist`, { 'content-type': 'application/json' })).body.code, 'EULA_REQUIRED');
    assert.equal((await call(url, 'GET', BASE_PATH)).status, 200, 'reading the bank is not actual work');
    assert.deepEqual(blocked.forwarded.map((entry) => entry.method), ['GET']);
  } finally {
    server.close();
  }
});

test('every bank route needs an organization context', async () => {
  const { app, forwarded, state } = buildApp({ identity: IDENTITIES.admin });
  const { server, url } = await start(app);
  try {
    state.organizationId = '';

    for (const [method, path] of [['GET', BASE_PATH], ['POST', `${BASE_PATH}/coverage`], ['POST', `${BASE_PATH}/ai-assist`]]) {
      const response = await call(url, method, path, { 'content-type': 'application/json' });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.body.code, 'organization_context_required');
    }
    assert.deepEqual(forwarded, []);
  } finally {
    server.close();
  }
});

test('CORS preflight passes the gates untouched and an unlisted method falls to the catch-all', async () => {
  const { app, forwarded } = buildApp({ identity: IDENTITIES.viewer });
  const { server, url } = await start(app);
  try {
    const preflight = await fetch(`${url}${BASE_PATH}/coverage`, {
      method: 'OPTIONS',
      headers: { origin: 'https://platform.archagentix.com', 'access-control-request-method': 'POST' },
    });
    assert.equal(preflight.status, 200, 'the stub proxy answers every call that clears the gates');
    assert.equal(forwarded.at(-1).method, 'OPTIONS', 'preflight is never gated');

    // GET /coverage is not a POST route, so it falls through to the base mount
    // (settings:read for a viewer) rather than being refused by the catch-all.
    assert.equal((await call(url, 'GET', `${BASE_PATH}/coverage`)).status, 200);
  } finally {
    server.close();
  }
});
