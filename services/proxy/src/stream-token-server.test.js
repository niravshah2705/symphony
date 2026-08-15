'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const {
  createStreamTokenServer,
  resolveBindHost,
  DEFAULT_BROKER_BIND_HOST,
  CLOUD_RUN_BIND_HOST,
  DEFAULT_BROKER_PORT,
} = require('./stream-token-server');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await close(server);
  return port;
}

function captureOutput(child) {
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  return output;
}

function waitForOutput(child, output, pattern, timeoutMs = 5_000) {
  if (pattern.test(output.stdout)) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.reject(new Error(
      `broker exited before listening (code=${child.exitCode}, signal=${child.signalCode})\n${output.stderr}`
    ));
  }
  return new Promise((resolve, reject) => {
    const finish = (callback) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      callback();
    };
    const onData = () => {
      if (pattern.test(output.stdout)) finish(resolve);
    };
    const onExit = (code, signal) => finish(() => reject(new Error(
      `broker exited before listening (code=${code}, signal=${signal})\n${output.stderr}`
    )));
    const onError = (error) => finish(() => reject(error));
    const timer = setTimeout(() => finish(() => reject(new Error(
      `broker did not listen within ${timeoutMs}ms\n${output.stderr}`
    ))), timeoutMs);
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

test('broker-only server exposes health, mint, and verify but no egress relay', async () => {
  const calls = [];
  const service = {
    mint(channelId, context) {
      calls.push({ operation: 'mint', channelId, context });
      return { token: '123.signature', expiresAt: 123 };
    },
    verify(token, channelId, context) {
      calls.push({ operation: 'verify', token, channelId, context });
      return true;
    },
  };
  const server = createStreamTokenServer({ streamTokenService: service });
  const port = await listen(server);

  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const mint = await fetch(`http://127.0.0.1:${port}/internal/stream-token/mint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channelId: 'conversation-1',
        context: { organizationId: 'org-1', projectId: 'project-1' },
      }),
    });
    assert.equal(mint.status, 200);
    assert.equal(mint.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await mint.json(), { token: '123.signature', expiresAt: 123 });

    const verify = await fetch(`http://127.0.0.1:${port}/internal/stream-token/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: '123.signature',
        channelId: 'conversation-1',
        context: { organizationId: 'org-1', projectId: 'project-1' },
      }),
    });
    assert.equal(verify.status, 200);
    assert.deepEqual(await verify.json(), { valid: true });

    const egress = await fetch(`http://127.0.0.1:${port}/openai/v1/models`);
    assert.equal(egress.status, 404);
    assert.deepEqual(await egress.json(), { error: 'not found' });
    assert.deepEqual(calls, [
      {
        operation: 'mint',
        channelId: 'conversation-1',
        context: { organizationId: 'org-1', projectId: 'project-1' },
      },
      {
        operation: 'verify',
        token: '123.signature',
        channelId: 'conversation-1',
        context: { organizationId: 'org-1', projectId: 'project-1' },
      },
    ]);
  } finally {
    await close(server);
  }
});

test('broker server keeps RPC method validation and safe binding defaults', async () => {
  const server = createStreamTokenServer({
    streamTokenService: { mint: () => assert.fail('must not mint'), verify: () => false },
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/internal/stream-token/mint`);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  } finally {
    await close(server);
  }
  assert.equal(DEFAULT_BROKER_BIND_HOST, '127.0.0.1');
  assert.equal(CLOUD_RUN_BIND_HOST, '0.0.0.0');
  assert.equal(DEFAULT_BROKER_PORT, 8080);
});

test('wildcard binding requires the explicit trusted Cloud Run value', () => {
  assert.equal(resolveBindHost(''), '127.0.0.1');
  assert.equal(resolveBindHost(' 127.0.0.1 '), '127.0.0.1');
  assert.equal(resolveBindHost(' 0.0.0.0 '), '0.0.0.0');
  for (const value of ['localhost', '::1', '10.0.0.2', '*']) {
    assert.throws(() => resolveBindHost(value), /STREAM_TOKEN_BIND_HOST must be/);
  }
});

test('production broker entrypoint listens without gateway authentication config', {
  timeout: 10_000,
}, async (t) => {
  const port = await availablePort();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    STREAM_TOKEN_SECRET: 'startup-test-secret',
    STREAM_TOKEN_BIND_HOST: CLOUD_RUN_BIND_HOST,
    PORT: String(port),
  };
  delete env.AUTH_MODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('FIREBASE_')) delete env[key];
  }

  const child = spawn(process.execPath, ['stream-token-server.js'], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = captureOutput(child);
  t.after(() => stopChild(child));

  await waitForOutput(
    child,
    output,
    new RegExp(`stream-token broker listening on http://0\\.0\\.0\\.0:${port}`)
  );
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(child.exitCode, null, output.stderr);
  assert.equal(Object.hasOwn(env, 'AUTH_MODE'), false);
  assert.deepEqual(Object.keys(env).filter((key) => key.startsWith('FIREBASE_')), []);
});

test('broker startup fails closed for an untrusted bind host', () => {
  const result = spawnSync(process.execPath, ['stream-token-server.js'], {
    cwd: __dirname,
    encoding: 'utf8',
    env: {
      ...process.env,
      STREAM_TOKEN_BIND_HOST: '10.0.0.2',
      STREAM_TOKEN_SECRET: 'test-secret',
      PORT: '0',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STREAM_TOKEN_BIND_HOST must be 127\.0\.0\.1 or 0\.0\.0\.0/);
});

test('broker startup fails closed without its signing secret', () => {
  const result = spawnSync(process.execPath, ['stream-token-server.js'], {
    cwd: __dirname,
    encoding: 'utf8',
    env: {
      ...process.env,
      STREAM_TOKEN_BIND_HOST: '',
      STREAM_TOKEN_SECRET: '',
      PORT: '0',
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STREAM_TOKEN_SECRET is required/);
});
