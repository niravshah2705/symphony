'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createClient, resolveBaseUrl, resolveToken } = require('./client');
const credentials = require('./credentials');
const { version: VERSION } = require('../package.json');

function fakeResponse({ ok = true, status = 200, statusText = 'OK', body = '' } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('resolveBaseUrl prefers the --api flag and strips trailing slashes', () => {
  assert.equal(resolveBaseUrl({ api: 'http://x:1/' }), 'http://x:1');
});

test('resolveBaseUrl falls back to $ADLC_API_URL', () => {
  withEnv('ADLC_API_URL', 'http://env-host:9/', () => {
    assert.equal(resolveBaseUrl({}), 'http://env-host:9');
  });
});

test('resolveToken reads ADLC_TOKEN from the environment only', () => {
  withEnv('ADLC_TOKEN', 'tok-123', () => {
    assert.equal(resolveToken(), 'tok-123');
  });
  withEnv('ADLC_TOKEN', undefined, () => {
    assert.equal(resolveToken(), null);
  });
});

test('request sends a bearer Authorization header when a token is set', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return fakeResponse({ body: { ok: true } });
  };
  const client = createClient({ baseUrl: 'http://gw', token: 'secret-token', fetchImpl });
  const data = await client.request('GET', '/api/coder');
  assert.equal(seen.url, 'http://gw/api/coder');
  assert.equal(seen.init.headers.Authorization, 'Bearer secret-token');
  assert.deepEqual(data, { ok: true });
});

test('request omits Authorization when no token is configured', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = init;
    return fakeResponse({ body: {} });
  };
  const client = createClient({ baseUrl: 'http://gw', fetchImpl });
  await client.request('GET', '/healthz');
  assert.equal(seen.headers.Authorization, undefined);
});

test('request serializes a JSON body and sets Content-Type', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = init;
    return fakeResponse({ status: 202, body: { accepted: true } });
  };
  const client = createClient({ baseUrl: 'http://gw', fetchImpl });
  await client.request('POST', '/api/agent/enqueue', { projectId: 'p1' });
  assert.equal(seen.headers['Content-Type'], 'application/json');
  assert.equal(seen.body, JSON.stringify({ projectId: 'p1' }));
});

test('non-2xx throws with the server error message and status', async () => {
  const fetchImpl = async () =>
    fakeResponse({ ok: false, status: 400, body: { error: 'Assume a role before enqueuing planner work.' } });
  const client = createClient({ baseUrl: 'http://gw', fetchImpl });
  await assert.rejects(
    () => client.request('POST', '/api/agent/enqueue', {}),
    (err) => {
      assert.equal(err.message, 'Assume a role before enqueuing planner work.');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('a network failure surfaces a reachability hint', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const client = createClient({ baseUrl: 'http://gw', fetchImpl });
  await assert.rejects(() => client.request('GET', '/healthz'), /Cannot reach the gateway/);
});

test('every request carries the adlc version (User-Agent + X-Adlc-Version)', async () => {
  let seen = null;
  const fetchImpl = async (_url, init) => {
    seen = init;
    return fakeResponse({ body: {} });
  };
  const client = createClient({ baseUrl: 'http://gw', fetchImpl });
  await client.request('GET', '/healthz');
  assert.equal(seen.headers['User-Agent'], `adlc/${VERSION}`);
  assert.equal(seen.headers['X-Adlc-Version'], VERSION);
});

test('a 401 attaches a re-login hint', async () => {
  const fetchImpl = async () => fakeResponse({ ok: false, status: 401, body: { error: 'Authentication required' } });
  const client = createClient({ baseUrl: 'http://gw', fetchImpl });
  await assert.rejects(
    () => client.request('GET', '/api/coder'),
    (err) => {
      assert.equal(err.status, 401);
      assert.match(err.hint, /adlc auth login/);
      return true;
    }
  );
});

test('resolveToken prefers $ADLC_TOKEN, else the stored credential', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adlc-tok-'));
  const prevHome = process.env.ADLC_HOME;
  const prevTok = process.env.ADLC_TOKEN;
  process.env.ADLC_HOME = home;
  try {
    delete process.env.ADLC_TOKEN;
    credentials.save({ token: 'stored-tok' });
    assert.equal(resolveToken(), 'stored-tok');

    process.env.ADLC_TOKEN = 'env-tok';
    assert.equal(resolveToken(), 'env-tok');
  } finally {
    if (prevHome === undefined) delete process.env.ADLC_HOME;
    else process.env.ADLC_HOME = prevHome;
    if (prevTok === undefined) delete process.env.ADLC_TOKEN;
    else process.env.ADLC_TOKEN = prevTok;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
