'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pushAuth } = require('./oidc');

function invoke(middleware, token = '') {
  const result = { status: 200, body: null, nexted: false };
  const req = { get: (name) => String(name).toLowerCase() === 'x-internal-token' ? token : '' };
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };
  return Promise.resolve(middleware(req, res, () => { result.nexted = true; })).then(() => result);
}

test('direct push authentication fails closed without the shared token', async () => {
  assert.equal((await invoke(pushAuth({ internalToken: '' }))).status, 503);
  assert.equal((await invoke(pushAuth({ internalToken: 'shared' }), 'wrong')).status, 401);
  assert.equal((await invoke(pushAuth({ internalToken: 'shared' }), 'shared')).nexted, true);
});
