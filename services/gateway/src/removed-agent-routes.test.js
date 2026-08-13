'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REMOVED_CODEX_ROUTE_TOMBSTONES,
  gone,
  mountRemovedAgentRouteTombstones,
} = require('./removed-agent-routes');

test('removed Codex login, pending, callback, and browser sign-out are explicit tombstones', () => {
  assert.deepEqual(REMOVED_CODEX_ROUTE_TOMBSTONES, [
    { method: 'get', path: '/api/settings/codex/login' },
    { method: 'get', path: '/api/settings/codex/_pending' },
    { method: 'get', path: '/auth/callback' },
    { method: 'delete', path: '/api/settings/codex' },
  ]);
  const mounted = [];
  const app = {
    get(path, handler) { mounted.push({ method: 'get', path, handler }); },
    delete(path, handler) { mounted.push({ method: 'delete', path, handler }); },
  };
  assert.equal(mountRemovedAgentRouteTombstones(app), app);
  assert.deepEqual(
    mounted.map(({ method, path }) => ({ method, path })),
    REMOVED_CODEX_ROUTE_TOMBSTONES,
  );
  assert.ok(mounted.every(({ handler }) => handler === gone));
});

test('removed Codex route response is no-store 410 JSON', () => {
  const result = { status: null, headers: {}, body: null };
  const res = {
    status(code) { result.status = code; return this; },
    set(name, value) { result.headers[String(name).toLowerCase()] = value; return this; },
    json(body) { result.body = body; return this; },
  };
  assert.equal(gone({}, res), res);
  assert.equal(result.status, 410);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.body.code, 'endpoint_gone');
});
