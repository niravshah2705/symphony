'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const proxyServer = require('./index');
const { createServer, parseCapabilities, PROXY_BIND_HOST } = proxyServer;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('agent proxy without stream-token capability returns 404 for the internal RPCs', async () => {
  const server = createServer({
    capabilities: new Set(),
    proxyHandler: () => assert.fail('internal RPC must not reach the egress proxy'),
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/internal/stream-token/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 404);
  } finally {
    server.close();
  }
});

test('stream-token capability mounts the loopback RPC handler', async () => {
  const service = {
    mint: () => ({ token: '123.signature', expiresAt: 123 }),
    verify: () => true,
  };
  const server = createServer({ capabilities: 'stream-token', streamTokenService: service });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/internal/stream-token/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: '123.signature', channelId: 'conversation-1', context: {} }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { valid: true });
  } finally {
    server.close();
  }
});

test('capability parsing is explicit and comma-separated', () => {
  assert.deepEqual([...parseCapabilities('stream-token, OTHER, stream-token')], ['stream-token', 'other']);
  assert.deepEqual([...parseCapabilities('')], []);
});

test('the deployed proxy binds only shared loopback', () => {
  assert.equal(PROXY_BIND_HOST, '127.0.0.1');
});

test('proxy startup fails closed when stream-token capability has no secret', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./index')"], {
    cwd: __dirname,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROXY_CAPABILITIES: 'stream-token',
      STREAM_TOKEN_SECRET: '',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STREAM_TOKEN_SECRET is required/);
});
