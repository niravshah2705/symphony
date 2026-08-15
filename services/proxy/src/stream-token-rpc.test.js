'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  createStreamTokenRpcHandler,
  isLoopbackAddress,
  MAX_BODY_BYTES,
} = require('./stream-token-rpc');

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function post(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('mint and verify RPCs use the locked request and response shapes', async () => {
  const calls = [];
  const service = {
    mint(channelId, context) {
      calls.push({ method: 'mint', channelId, context });
      return { token: '123.signature', expiresAt: 123 };
    },
    verify(token, channelId, context) {
      calls.push({ method: 'verify', token, channelId, context });
      return false;
    },
  };
  const { server, port } = await startServer(createStreamTokenRpcHandler({ service }));

  try {
    const context = { organizationId: 'org-1', projectId: 'project-1' };
    const minted = await post(port, '/internal/stream-token/mint', { channelId: 'conversation-1', context });
    assert.equal(minted.status, 200);
    assert.deepEqual(await minted.json(), { token: '123.signature', expiresAt: 123 });

    const verified = await post(port, '/internal/stream-token/verify', {
      token: '123.signature', channelId: 'conversation-1', context,
    });
    assert.equal(verified.status, 200);
    assert.deepEqual(await verified.json(), { valid: false });
    assert.deepEqual(calls, [
      { method: 'mint', channelId: 'conversation-1', context },
      { method: 'verify', token: '123.signature', channelId: 'conversation-1', context },
    ]);
  } finally {
    server.close();
  }
});

test('RPC surface accepts POST only and rejects malformed requests', async () => {
  const service = { mint: () => assert.fail('must not mint'), verify: () => assert.fail('must not verify') };
  const { server, port } = await startServer(createStreamTokenRpcHandler({ service }));
  try {
    const get = await fetch(`http://127.0.0.1:${port}/internal/stream-token/mint`);
    assert.equal(get.status, 405);
    const invalidJson = await post(port, '/internal/stream-token/mint', '{');
    assert.equal(invalidJson.status, 400);
    const missingChannel = await post(port, '/internal/stream-token/mint', { context: {} });
    assert.equal(missingChannel.status, 400);
    const missingVerifyChannel = await post(port, '/internal/stream-token/verify', { token: '123.signature' });
    assert.equal(missingVerifyChannel.status, 400);
  } finally {
    server.close();
  }
});

test('RPC request bodies are capped at 8 KiB', async () => {
  const service = { mint: () => assert.fail('must not mint'), verify: () => false };
  const { server, port } = await startServer(createStreamTokenRpcHandler({ service }));
  try {
    const response = await post(
      port,
      '/internal/stream-token/mint',
      JSON.stringify({ channelId: 'x'.repeat(MAX_BODY_BYTES) }),
    );
    assert.equal(MAX_BODY_BYTES, 8 * 1024);
    assert.equal(response.status, 413);
  } finally {
    server.close();
  }
});

test('loopback address check rejects non-loopback peers', () => {
  for (const address of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ['', '10.0.0.2', '192.168.1.2', '::ffff:10.0.0.2']) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
});
