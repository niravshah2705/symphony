'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGuestDeployerClient, RPC_PATH } = require('./guest-deployer-client');

function withFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

function jsonResponse(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

/** The gateway must present the broker's own secret, never the platform S2S token. */
function clientWith(captured, options = {}) {
  return createGuestDeployerClient({
    baseUrl: 'http://guest-deployer.test',
    token: 'guest-broker-secret',
    ...options,
  });
}

test('a deploy sends the broker secret and the template, and returns the handle', async () => {
  const captured = {};
  const restore = withFetch(async (url, init = {}) => {
    captured.url = url;
    captured.init = init;
    captured.body = JSON.parse(init.body);
    return jsonResponse(200, { token: 'preview-token-1', url: 'https://previews.test/preview-token-1/', expiresAt: '2026-11-21T00:00:00.000Z', fileCount: 4, live: 1 });
  });
  try {
    const client = clientWith(captured);
    const result = await client.deploy({ template: 'helloworld', variant: { accent: 'amber' } });
    assert.equal(captured.url, 'http://guest-deployer.test' + RPC_PATH);
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers['x-internal-token'], 'guest-broker-secret');
    assert.deepEqual(Object.keys(captured.body), ['template', 'variant']);
    assert.deepEqual(captured.body.variant, { accent: 'amber' });
    assert.equal(result.token, 'preview-token-1');
    assert.equal(result.expiresAt, '2026-11-21T00:00:00.000Z');
  } finally {
    restore();
  }
});

test('the platform-wide INTERNAL_API_TOKEN must not ride along', async () => {
  const captured = {};
  process.env.INTERNAL_API_TOKEN = 'platform-wide-token';
  const restore = withFetch(async (url, init = {}) => {
    captured.init = init;
    return jsonResponse(200, { token: 'preview-token-2', fileCount: 1, live: 1 });
  });
  try {
    await clientWith(captured).deploy({ template: 'tic-tac-toe' });
    assert.equal(captured.init.headers['x-internal-token'], 'guest-broker-secret');
    assert.notEqual(captured.init.headers['x-internal-token'], 'platform-wide-token');
    assert.ok(!('authorization' in captured.init.headers), 'no end-user credential belongs on a broker call');
  } finally {
    delete process.env.INTERNAL_API_TOKEN;
    restore();
  }
});

test('a withdraw reaches the broker and reports the success', async () => {
  const captured = {};
  const restore = withFetch(async (url, init = {}) => {
    captured.url = url;
    captured.method = init.method;
    captured.token = init.headers['x-internal-token'];
    return jsonResponse(200, { token: 'preview-token-5', live: 0 });
  });
  try {
    assert.equal(await clientWith(captured).remove('preview-token-5'), true, 'a 2xx withdraw must not be swallowed as a refusal');
    assert.equal(captured.method, 'DELETE');
    assert.equal(captured.url, 'http://guest-deployer.test' + RPC_PATH + '/preview-token-5');
    assert.equal(captured.token, 'guest-broker-secret');
  } finally {
    restore();
  }
});

test('a broker refusal degrades the step instead of failing the visitor turn', async () => {
  const restore = withFetch(async () => jsonResponse(503, { error: 'the preview host is unavailable', code: 'guest_hosting_release_failed' }));
  try {
    const client = clientWith({}, { token: 'guest-broker-secret' });
    assert.equal(await client.deploy({ template: 'helloworld' }), null, 'the caller must not report a URL that does not exist');
    assert.equal(await client.redeploy({ token: 'whatever', template: 'helloworld' }), false);
    assert.equal(await client.remove('whatever'), false);
  } finally {
    restore();
  }
});

test('a network failure is swallowed the same way a refusal is', async () => {
  const restore = withFetch(async () => { throw new Error('socket hang up'); });
  try {
    const client = clientWith({});
    assert.equal(await client.deploy({ template: 'helloworld' }), null);
    assert.equal(await client.redeploy({ token: 'preview-token-3', template: 'helloworld' }), false);
    assert.equal(await client.remove('preview-token-3'), false);
  } finally {
    restore();
  }
});

test('a missing template or handle is a no-op, not a request', async () => {
  const captured = { calls: 0 };
  const restore = withFetch(async (url, init) => {
    captured.calls += 1;
    captured.url = url;
    return jsonResponse(200, { token: 'preview-token-4', fileCount: 1, live: 1 });
  });
  try {
    const client = clientWith(captured);
    assert.equal(await client.deploy({ variant: {} }), null);
    assert.equal(await client.redeploy({ template: 'helloworld' }), false);
    assert.equal(await client.remove(''), false);
    assert.equal(captured.calls, 0);
  } finally {
    restore();
  }
});

test('a broker response without a token is treated as no preview', async () => {
  const restore = withFetch(async () => jsonResponse(200, { fileCount: 2, live: 1 }));
  try {
    const client = clientWith({});
    assert.equal(await client.deploy({ template: 'helloworld' }), null, 'a handle the broker did not mint cannot be trusted');
  } finally {
    restore();
  }
});

test('an unconfigured broker is unusable rather than unauthenticated', () => {
  assert.throws(() => createGuestDeployerClient({ baseUrl: '' }), /broker URL/);
  const client = createGuestDeployerClient({ baseUrl: 'http://guest-deployer.test', token: '' });
  assert.ok(client, 'an empty secret still builds a client; the broker will refuse it');
});
