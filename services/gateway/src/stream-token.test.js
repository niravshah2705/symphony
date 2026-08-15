'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

process.env.STREAM_TOKEN_PROXY_URL ||= 'http://127.0.0.1:4030';

const {
  createStreamTokenClient,
  StreamTokenUnavailableError,
  STREAM_TOKEN_TIMEOUT_MS,
  STREAM_TOKEN_TTL_MS,
  STREAM_TOKEN_CLOCK_SKEW_MS,
  configuredServiceUrl,
  validMintResponse,
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
  assert.equal(request.init.headers.authorization, undefined);
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

test('remote HTTPS broker calls carry one Cloud Run OIDC header for the broker origin', async () => {
  const now = 1_800_000_000_000;
  const expiresAt = now + STREAM_TOKEN_TTL_MS;
  let identityCalls = 0;
  let request;
  const client = createStreamTokenClient({
    baseUrl: 'https://stream-token-broker.example/',
    now: () => now,
    identityHeader: async (audience) => {
      identityCalls += 1;
      assert.equal(audience, 'https://stream-token-broker.example');
      return 'Bearer cloud-run-oidc';
    },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse(200, { token: `${expiresAt}.signature`, expiresAt });
    },
  });

  assert.equal(await client.mintStreamToken('conversation-1'), `${expiresAt}.signature`);
  assert.equal(identityCalls, 1);
  assert.equal(request.url, 'https://stream-token-broker.example/internal/stream-token/mint');
  assert.equal(request.init.headers.authorization, 'Bearer cloud-run-oidc');
});

test('remote broker identity failures fail closed without attempting the RPC', async () => {
  let identityCalls = 0;
  let fetchCalls = 0;
  const client = createStreamTokenClient({
    baseUrl: 'https://stream-token-broker.example',
    identityHeader: async () => { identityCalls += 1; return ''; },
    fetchImpl: async () => { fetchCalls += 1; return jsonResponse(200, { valid: true }); },
  });

  await assert.rejects(
    client.verifyStreamToken('123.signature', 'conversation-1'),
    (error) => error instanceof StreamTokenUnavailableError
      && error.code === 'stream_token_unavailable',
  );
  assert.equal(identityCalls, 1);
  assert.equal(fetchCalls, 0);
});

test('the request deadline includes Cloud Run identity acquisition', async () => {
  let identityCalls = 0;
  let fetchCalls = 0;
  const client = createStreamTokenClient({
    baseUrl: 'https://stream-token-broker.example',
    timeoutMs: 10,
    identityHeader: async () => {
      identityCalls += 1;
      return new Promise(() => {});
    },
    fetchImpl: async () => { fetchCalls += 1; return jsonResponse(200, { valid: true }); },
  });

  await assert.rejects(
    client.verifyStreamToken('123.signature', 'conversation-1'),
    (error) => error.code === 'stream_token_unavailable',
  );
  assert.equal(identityCalls, 1);
  assert.equal(fetchCalls, 0);
});

test('mint expiry validation allows one minute of broker clock skew but rejects farther futures', () => {
  const now = 1_800_000_000_000;
  const allowedExpiry = now + STREAM_TOKEN_TTL_MS + STREAM_TOKEN_CLOCK_SKEW_MS;
  const allowed = { token: `${allowedExpiry}.signature`, expiresAt: allowedExpiry };
  const tooFar = { token: `${allowedExpiry + 1}.signature`, expiresAt: allowedExpiry + 1 };

  assert.equal(validMintResponse(allowed, now), true);
  assert.equal(validMintResponse(tooFar, now), false);
});

test('configured service URL prefers the broker and retains the loopback rollback fallback', () => {
  assert.equal(configuredServiceUrl({
    STREAM_TOKEN_SERVICE_URL: ' https://stream-token-broker.example/ ',
    STREAM_TOKEN_PROXY_URL: 'http://127.0.0.1:4030',
  }), 'https://stream-token-broker.example/');
  assert.equal(configuredServiceUrl({
    STREAM_TOKEN_SERVICE_URL: '',
    STREAM_TOKEN_PROXY_URL: ' http://127.0.0.1:4030 ',
  }), 'http://127.0.0.1:4030');
});

test('gateway fails startup when both stream-token service URLs are unset', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./stream-token')"], {
    cwd: __dirname,
    encoding: 'utf8',
    env: { ...process.env, STREAM_TOKEN_SERVICE_URL: '', STREAM_TOKEN_PROXY_URL: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STREAM_TOKEN_SERVICE_URL or STREAM_TOKEN_PROXY_URL is required/);
});

test('gateway rejects remote plaintext while allowing a remote HTTPS broker', () => {
  assert.throws(
    () => createStreamTokenClient({ baseUrl: 'http://broker.example', fetchImpl: async () => {} }),
    /HTTPS or loopback HTTP origin/,
  );
  assert.doesNotThrow(() => createStreamTokenClient({
    baseUrl: 'https://broker.example',
    fetchImpl: async () => {},
    identityHeader: async () => 'Bearer oidc',
  }));
});
