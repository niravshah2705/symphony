'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

process.env.STREAM_TOKEN_PROXY_URL ||= 'http://127.0.0.1:4030';

const {
  createStreamTokenClient,
  StreamTokenUnavailableError,
  STREAM_TOKEN_TIMEOUT_MS,
} = require('./stream-token');
const { WORKSPACE_CHANNEL } = require('@ai-fleet/shared-core/messaging/events');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('mint sends the exact proxy RPC payload and returns the unchanged token format', async () => {
  const expiresAt = Date.now() + 300_000;
  const expectedToken = `${expiresAt}.base64url-signature`;
  let request;
  const client = createStreamTokenClient({
    baseUrl: 'http://127.0.0.1:4403/',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse(200, { token: expectedToken, expiresAt });
    },
  });

  const token = await client.mintStreamToken('conversation-1', {
    organizationId: 'org-1',
    projectId: 'project-1',
  });

  assert.equal(token, expectedToken);
  assert.equal(request.url, 'http://127.0.0.1:4403/internal/stream-token/mint');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(request.init.body), {
    channelId: 'conversation-1',
    context: { organizationId: 'org-1', projectId: 'project-1' },
  });
  assert.ok(request.init.signal instanceof AbortSignal);
});

test('workspace mint uses the reserved workspace channel', async () => {
  const expiresAt = Date.now() + 300_000;
  let body;
  const client = createStreamTokenClient({
    baseUrl: 'http://127.0.0.1:4403',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse(200, { token: `${expiresAt}.signature`, expiresAt });
    },
  });

  await client.mintWorkspaceToken({ organizationId: 'org-1', projectId: 'project-1' });
  assert.deepEqual(body, {
    channelId: WORKSPACE_CHANNEL,
    context: { organizationId: 'org-1', projectId: 'project-1' },
  });
});

test('verify returns the proxy valid decision and preserves authoritative context', async () => {
  let body;
  const client = createStreamTokenClient({
    baseUrl: 'http://127.0.0.1:4403',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse(200, { valid: false });
    },
  });

  assert.equal(await client.verifyStreamToken('123.signature', 'conversation-1', {
    organizationId: 'org-1',
    projectId: 'project-1',
  }), false);
  assert.deepEqual(body, {
    token: '123.signature',
    channelId: 'conversation-1',
    context: { organizationId: 'org-1', projectId: 'project-1' },
  });
});

test('connection failures make one attempt and become stream_token_unavailable', async () => {
  let attempts = 0;
  const client = createStreamTokenClient({
    baseUrl: 'http://127.0.0.1:4403',
    fetchImpl: async () => {
      attempts += 1;
      throw new Error('connect ECONNREFUSED');
    },
  });

  await assert.rejects(
    client.verifyStreamToken('123.signature', 'conversation-1'),
    (error) => error instanceof StreamTokenUnavailableError
      && error.code === 'stream_token_unavailable',
  );
  assert.equal(attempts, 1);
});

test('non-2xx and malformed proxy replies fail closed as unavailable', async (t) => {
  const cases = [
    ['non-2xx', () => jsonResponse(500, { error: 'internal error' }), 'verify'],
    ['non-JSON', () => new Response('not json', { status: 200 }), 'verify'],
    ['non-boolean valid', () => jsonResponse(200, { valid: 'yes' }), 'verify'],
    ['missing mint expiry', () => jsonResponse(200, { token: '123.signature' }), 'mint'],
    ['mismatched mint expiry', () => jsonResponse(200, { token: '123.signature', expiresAt: 456 }), 'mint'],
    ['expired mint token', () => jsonResponse(200, { token: '123.signature', expiresAt: 123 }), 'mint'],
    ['unsafe mint expiry', () => jsonResponse(200, {
      token: '9007199254740993.signature', expiresAt: 9007199254740992,
    }), 'mint'],
  ];

  for (const [name, fetchImpl, operation] of cases) {
    await t.test(name, async () => {
      const client = createStreamTokenClient({ baseUrl: 'http://127.0.0.1:4403', fetchImpl });
      const promise = operation === 'mint'
        ? client.mintStreamToken('conversation-1')
        : client.verifyStreamToken('123.signature', 'conversation-1');
      await assert.rejects(promise, (error) => error.code === 'stream_token_unavailable');
    });
  }
});

test('proxy calls time out after the configured deadline without retrying', async () => {
  let attempts = 0;
  const client = createStreamTokenClient({
    baseUrl: 'http://127.0.0.1:4403',
    timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  await assert.rejects(
    client.verifyStreamToken('123.signature', 'conversation-1'),
    (error) => error.code === 'stream_token_unavailable',
  );
  assert.equal(attempts, 1);
  assert.equal(STREAM_TOKEN_TIMEOUT_MS, 2_000);
});

test('gateway fails startup when STREAM_TOKEN_PROXY_URL is unset', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./stream-token')"], {
    cwd: __dirname,
    encoding: 'utf8',
    env: { ...process.env, STREAM_TOKEN_PROXY_URL: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STREAM_TOKEN_PROXY_URL is required/);
});

test('gateway rejects a non-loopback stream-token proxy URL', () => {
  assert.throws(
    () => createStreamTokenClient({ baseUrl: 'https://proxy.example', fetchImpl: async () => {} }),
    /loopback HTTP origin/,
  );
});
