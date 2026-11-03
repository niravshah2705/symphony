'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// The org/settings services resolve the principal from a `Bearer `-prefixed
// credential, so these tests pin the scheme the S2S client actually sends.
delete process.env.MESSAGING_MODE;
delete process.env.INTERNAL_API_TOKEN;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-service-client-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;

const { callJson, bearerHeader } = require('./service-client');

test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

function stubFetch(captured) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.url = url;
    captured.headers = init.headers;
    return { status: 200, text: async () => JSON.stringify({ org_role: 'ORG_ADMIN' }) };
  };
  return () => { globalThis.fetch = original; };
}

test('bearerHeader prefixes a bare JWT and leaves a scheme-prefixed value alone', () => {
  assert.equal(bearerHeader('abc.def.ghi'), 'Bearer abc.def.ghi');
  assert.equal(bearerHeader('Bearer abc.def.ghi'), 'Bearer abc.def.ghi');
  assert.equal(bearerHeader('bearer  abc.def.ghi'), 'Bearer abc.def.ghi');
  assert.equal(bearerHeader(''), '');
  assert.equal(bearerHeader(undefined), '');
});

test('callJson forwards a bare bearer with the scheme (a bare JWT is 401ed downstream)', async () => {
  const captured = {};
  const restore = stubFetch(captured);
  try {
    const res = await callJson('https://org.example', '/api/v1/me', { userAuth: 'abc.def.ghi' });
    assert.equal(res.status, 200);
    assert.equal(res.data.org_role, 'ORG_ADMIN');
  } finally {
    restore();
  }
  assert.equal(captured.headers['x-forwarded-authorization'], 'Bearer abc.def.ghi');
  assert.equal(captured.headers.authorization, 'Bearer abc.def.ghi');
});

test('callJson omits auth headers when no user credential is given', async () => {
  const captured = {};
  const restore = stubFetch(captured);
  try {
    await callJson('https://org.example', '/api/v1/me', { userAuth: '   ' });
  } finally {
    restore();
  }
  assert.equal(captured.headers['x-forwarded-authorization'], undefined);
  assert.equal(captured.headers.authorization, undefined);
});
