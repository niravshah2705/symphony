'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isInternalPath, blockInternalProxy } = require('./settings-internal-guard');

test('isInternalPath matches the internal surface but not normal settings paths', () => {
  assert.equal(isInternalPath('/internal/effective-config'), true);
  assert.equal(isInternalPath('/api/settings-policy/internal/effective-config'), true);
  assert.equal(isInternalPath('/settings/internal'), true);
  assert.equal(isInternalPath('/INTERNAL/effective-config'), true); // case-insensitive
  assert.equal(isInternalPath('/settings/effective'), false);
  assert.equal(isInternalPath('/me/settings'), false);
  assert.equal(isInternalPath('/settings/internalized'), false); // not a whole segment
});

function invoke(reqPath) {
  const result = { status: 200, body: undefined, nexted: false };
  const req = { path: reqPath };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    json(payload) {
      result.body = payload;
      return this;
    },
  };
  blockInternalProxy(req, res, () => {
    result.nexted = true;
  });
  return result;
}

test('blockInternalProxy 404s a browser request to the internal (unmasked) surface', () => {
  const blocked = invoke('/internal/effective-config');
  assert.equal(blocked.status, 404);
  assert.equal(blocked.nexted, false);
});

test('blockInternalProxy passes normal settings-policy requests through', () => {
  const ok = invoke('/settings/effective');
  assert.equal(ok.nexted, true);
  assert.equal(ok.status, 200);
});
