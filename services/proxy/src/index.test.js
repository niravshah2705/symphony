'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const proxyServer = require('./index');
const {
  createServer,
  parseCapabilities,
  resolveBindHost,
  PROXY_BIND_HOST,
  DEFAULT_PROXY_BIND_HOST,
  CLOUD_RUN_BIND_HOST,
} = proxyServer;

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

test('proxy binding defaults to loopback and permits the explicit Cloud Run wildcard', () => {
  assert.equal(DEFAULT_PROXY_BIND_HOST, '127.0.0.1');
  assert.equal(CLOUD_RUN_BIND_HOST, '0.0.0.0');
  assert.equal(PROXY_BIND_HOST, DEFAULT_PROXY_BIND_HOST);
  assert.equal(resolveBindHost(''), DEFAULT_PROXY_BIND_HOST);
  assert.equal(resolveBindHost(' 127.0.0.1 '), DEFAULT_PROXY_BIND_HOST);
  assert.equal(resolveBindHost(' 0.0.0.0 '), CLOUD_RUN_BIND_HOST);
  for (const value of ['localhost', '::', '10.0.0.2', '*']) {
    assert.throws(() => resolveBindHost(value), /PROXY_BIND_HOST must be/);
  }
});

test('proxy startup accepts the explicit Cloud Run wildcard bind', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "process.stdout.write(require('./index').PROXY_BIND_HOST)"],
    {
      cwd: __dirname,
      encoding: 'utf8',
      env: { ...process.env, PROXY_BIND_HOST: CLOUD_RUN_BIND_HOST },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, CLOUD_RUN_BIND_HOST);
});

test('proxy startup fails closed before listen for an untrusted bind host', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./index')"], {
    cwd: __dirname,
    encoding: 'utf8',
    env: { ...process.env, PROXY_BIND_HOST: '10.0.0.2' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PROXY_BIND_HOST must be 127\.0\.0\.1 or 0\.0\.0\.0/);
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
