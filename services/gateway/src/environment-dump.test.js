'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_ENVIRONMENT_DUMP_EMAIL,
  createEnvironmentDumpHandler,
  environmentDumpNoCache,
} = require('./environment-dump');
const { requireAuthenticated } = require('./auth');

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function authenticatedRequest(email = ALLOWED_ENVIRONMENT_DUMP_EMAIL) {
  return {
    auth: {
      authenticated: true,
      user: { email },
    },
  };
}

function invokeMountedRoute(req, res, handler) {
  return environmentDumpNoCache(req, res, () =>
    requireAuthenticated()(req, res, () => handler(req, res))
  );
}

test('authorized user receives every environment value verbatim in sorted key order', () => {
  const env = {
    Z_LAST: 'last',
    STREAM_TOKEN_SECRET: 'stream-secret-value',
    EMPTY_VALUE: '',
    LINEAR_API_KEY: 'linear-secret-value',
    A_FIRST: 'first',
  };
  const originalEntries = Object.entries(env);
  const fixedTime = new Date('2026-08-15T10:11:12.345Z');
  const handler = createEnvironmentDumpHandler({ env, now: () => fixedTime });
  const res = responseRecorder();

  assert.equal(
    handler(authenticatedRequest('  NiravShah2705@GMAIL.COM  '), res),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.pragma, 'no-cache');
  assert.equal(res.body.service, 'gateway');
  assert.equal(res.body.generatedAt, '2026-08-15T10:11:12.345Z');
  assert.deepEqual(Object.keys(res.body.environment), [
    'A_FIRST',
    'EMPTY_VALUE',
    'LINEAR_API_KEY',
    'STREAM_TOKEN_SECRET',
    'Z_LAST',
  ]);
  assert.deepEqual(res.body.environment, {
    A_FIRST: 'first',
    EMPTY_VALUE: '',
    LINEAR_API_KEY: 'linear-secret-value',
    STREAM_TOKEN_SECRET: 'stream-secret-value',
    Z_LAST: 'last',
  });
  assert.deepEqual(Object.entries(env), originalEntries, 'source environment is not mutated');
});

test('direct handler rejects wrong, missing, and unauthenticated identities with no-store 403', () => {
  const requests = [
    authenticatedRequest('someone-else@example.com'),
    { auth: { authenticated: true, user: null } },
    { auth: { authenticated: true } },
    { auth: { authenticated: false, user: { email: ALLOWED_ENVIRONMENT_DUMP_EMAIL } } },
    {},
  ];
  let clockCalls = 0;
  const handler = createEnvironmentDumpHandler({
    env: { SECRET: 'must-not-be-returned' },
    now: () => {
      clockCalls += 1;
      return new Date('2026-08-15T10:11:12.345Z');
    },
  });

  for (const request of requests) {
    const res = responseRecorder();
    assert.equal(handler(request, res), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers.pragma, 'no-cache');
    assert.deepEqual(res.body, {
      error: 'Access denied',
      code: 'access_denied',
    });
  }

  assert.equal(clockCalls, 0, 'unauthorized requests do not build a dump');
});

test('mounted route returns no-cache 401 before the email gate for an anonymous caller', () => {
  const handler = createEnvironmentDumpHandler({
    env: { SECRET: 'must-not-be-returned' },
    now: () => {
      throw new Error('anonymous requests must not build a dump');
    },
  });
  const res = responseRecorder();

  invokeMountedRoute({ auth: { authenticated: false } }, res, handler);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.pragma, 'no-cache');
  assert.equal(res.headers['www-authenticate'], 'Bearer realm="AI Fleet"');
  assert.deepEqual(res.body, {
    error: 'Authentication required',
    code: 'authentication_required',
  });
});
