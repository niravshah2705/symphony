'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { createConfigResolver } = require('./config-resolver');

function makeReq({
  authenticated = true,
  authorization = 'Bearer usertoken',
  organizationId = '',
  projectId = '',
} = {}) {
  return {
    auth: { authenticated },
    get: (h) => ({
      authorization,
      'x-ai-fleet-organization-id': organizationId,
      'x-ai-fleet-project-id': projectId,
    })[String(h).toLowerCase()],
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('anonymous caller: authenticated:false, same-origin, never hits the org service', async () => {
  let called = false;
  const handler = createConfigResolver({ callJson: async () => { called = true; return {}; } });
  const res = makeRes();
  await handler(makeReq({ authenticated: false }), res);

  assert.equal(called, false);
  assert.deepEqual(res.body, { authenticated: false, status: 'shared', gatewayUrl: '' });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('authenticated + org resolves shared: gatewayUrl empty (same-origin)', async () => {
  const handler = createConfigResolver({
    callJson: async () => ({ status: 200, data: { status: 'shared', gateway_url: '', org_name: 'Acme' } }),
  });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.deepEqual(res.body, { authenticated: true, status: 'shared', gatewayUrl: '', orgName: 'Acme' });
});

test('authenticated + org provisioned: re-points to the per-tenant gateway URL', async () => {
  const handler = createConfigResolver({
    callJson: async () => ({
      status: 200,
      data: { status: 'provisioned', gateway_url: 'https://gw-tabc.run.app', org_name: 'Acme' },
    }),
  });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.body.status, 'provisioned');
  assert.equal(res.body.gatewayUrl, 'https://gw-tabc.run.app');
});

test('provisioning status keeps the SPA on the shared gateway', async () => {
  const handler = createConfigResolver({
    callJson: async () => ({ status: 200, data: { status: 'provisioning', gateway_url: '' } }),
  });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.body.status, 'provisioning');
  assert.equal(res.body.gatewayUrl, '');
});

test('provisioned WITHOUT a url fails closed instead of guessing same-origin', async () => {
  const handler = createConfigResolver({
    callJson: async () => ({ status: 200, data: { status: 'provisioned' } }),
  });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'Organization deployment context is temporarily unavailable.' });
});

test('forwards the already-validated selected context on the correct S2S path', async () => {
  const seen = [];
  const handler = createConfigResolver({
    callJson: async (baseUrl, path, opts) => { seen.push({ baseUrl, path, opts }); return { status: 200, data: { status: 'shared' } }; },
  });
  await handler(makeReq({
    authorization: 'Bearer THE-USER-TOKEN',
    organizationId: 'org-1',
    projectId: 'project-1',
  }), makeRes());

  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/api/v1/me/deployment');
  assert.equal(seen[0].opts.userAuth, 'Bearer THE-USER-TOKEN');
  assert.deepEqual(seen[0].opts.context, { organizationId: 'org-1', projectId: 'project-1', llmGateway: '' });
  assert.equal(seen[0].opts.body, undefined);
});

test('never leaks internal service URLs to the browser', async () => {
  const handler = createConfigResolver({
    callJson: async () => ({
      status: 200,
      // Even if the org service mistakenly returned extras, they must not pass through.
      data: { status: 'provisioned', gateway_url: 'https://gw.run.app', planner_url: 'x', org_url: 'y', settings_url: 'z' },
    }),
  });
  const res = makeRes();
  await handler(makeReq(), res);
  const keys = Object.keys(res.body);
  assert.deepEqual(keys.sort(), ['authenticated', 'gatewayUrl', 'orgName', 'status']);
  for (const leak of ['plannerUrl', 'planner_url', 'orgUrl', 'org_url', 'settingsUrl', 'settings_url', 'coderUrl']) {
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, leak), false);
  }
});

test('org-service error fails closed instead of guessing the shared gateway', async () => {
  const handler = createConfigResolver({ callJson: async () => ({ status: 502, data: null }) });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'Organization deployment context is temporarily unavailable.' });
});

test('callJson throwing fails closed instead of guessing the shared gateway', async () => {
  const handler = createConfigResolver({ callJson: async () => { throw new Error('network'); } });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'Organization deployment context is temporarily unavailable.' });
});

test('501 when ORG_URL is unset in production', () => {
  const script = `
    const { createConfigResolver } = require('./config-resolver');
    const handler = createConfigResolver({ callJson: async () => ({ status: 200, data: {} }) });
    const req = { auth: { authenticated: true }, get: () => 'Bearer x' };
    const res = { statusCode: 200, body: null, set() { return this; },
      status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
    handler(req, res).then(() => {
      if (res.statusCode !== 501) { console.error('expected 501, got', res.statusCode); process.exit(2); }
      process.exit(0);
    });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    // Minimal production Firebase env so shared config loads; ORG_URL unset in
    // production makes CONFIG.SERVICES.orgUrl empty — the 501 condition under test.
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ORG_URL: '',
      AUTH_MODE: 'firebase',
      FIREBASE_PROJECT_ID: 'test-project',
      FIREBASE_API_KEY: 'test-api-key',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
