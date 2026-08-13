'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { internalServiceAuth } = require('./internal-auth');

function invoke(middleware, token = '') {
  const result = { status: 200, body: null, nexted: false };
  middleware(
    { get: (name) => String(name).toLowerCase() === 'x-internal-token' ? token : '' },
    {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
    () => { result.nexted = true; },
  );
  return result;
}

test('direct internal services require the configured shared token', () => {
  const unconfigured = invoke(internalServiceAuth({ mode: 'direct', internalToken: '' }));
  assert.equal(unconfigured.status, 503);
  const rejected = invoke(internalServiceAuth({ mode: 'direct', internalToken: 'secret' }), 'wrong');
  assert.equal(rejected.status, 401);
  assert.equal(invoke(internalServiceAuth({ mode: 'direct', internalToken: 'secret' }), 'secret').nexted, true);
});

test('pubsub internal services defer to Cloud Run IAM and route-specific OIDC', () => {
  assert.equal(invoke(internalServiceAuth({ mode: 'pubsub' })).nexted, true);
});
