'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalPath, isInternalPath, blockInternalProxy } = require('./settings-internal-guard');

test('isInternalPath matches internal/operator surfaces but not normal settings paths', () => {
  assert.equal(isInternalPath('/internal/effective-config'), true);
  assert.equal(isInternalPath('/api/settings-policy/internal/effective-config'), true);
  assert.equal(isInternalPath('/settings/internal'), true);
  assert.equal(isInternalPath('/INTERNAL/effective-config'), true); // case-insensitive
  assert.equal(isInternalPath('/operator/codex/import'), true);
  assert.equal(isInternalPath('/api/settings-policy/operator/codex/import'), true);
  assert.equal(isInternalPath('/OPERATOR/codex/import'), true); // case-insensitive
  assert.equal(isInternalPath('/settings/effective'), false);
  assert.equal(isInternalPath('/me/settings'), false);
  assert.equal(isInternalPath('/settings/internalized'), false); // not a whole segment
  assert.equal(isInternalPath('/settings/operator-guide'), false); // not a whole segment
});

test('privileged settings guard canonicalizes encoded paths and fails closed on ambiguity', () => {
  for (const path of [
    '/%69nternal/effective-config',
    '/%6fperator/org/codex-tokens',
    '/safe%2foperator%2fdeployment-approvals/run-1',
    '/safe%252foperator%252forg%252fcodex-tokens',
    '/operator%2fdeployment-approvals/run-1?source=browser',
    '/safe/%',
    '/safe/%GG',
  ]) {
    assert.equal(isInternalPath(path), true, path);
  }
  assert.equal(canonicalPath('/settings/effective?view=compact'), '/settings/effective');
  assert.equal(isInternalPath('/settings/%6fp%65rator-guide'), false);
});

function invoke(reqPath, originalUrl = reqPath) {
  const result = { status: 200, body: undefined, nexted: false };
  const req = { path: reqPath, originalUrl };
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

test('blockInternalProxy 404s browser requests to privileged settings surfaces', () => {
  for (const [path, originalUrl] of [
    ['/internal/effective-config', '/internal/effective-config'],
    ['/operator/codex/import', '/operator/codex/import'],
    ['/%6fperator/org/codex-tokens', '/%6fperator/org/codex-tokens'],
    ['/safe/operator-guide', '/safe%252foperator%252forg%252fcodex-tokens'],
  ]) {
    const blocked = invoke(path, originalUrl);
    assert.equal(blocked.status, 404);
    assert.equal(blocked.nexted, false);
  }
});

test('blockInternalProxy passes normal settings-policy requests through', () => {
  const ok = invoke('/settings/effective');
  assert.equal(ok.nexted, true);
  assert.equal(ok.status, 200);
});
