'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCorsMiddleware } = require('./cors');
const { parseSpaOrigins } = require('@ai-fleet/shared-core/config');

function makeRes() {
  return {
    headers: {},
    statusCode: 200,
    ended: false,
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    end() { this.ended = true; return this; },
  };
}

test('reflects an allowlisted origin and calls next', () => {
  const cors = createCorsMiddleware(['https://spa.example.com']);
  const res = makeRes();
  let nexted = 0;
  cors({ method: 'GET', get: (n) => (n === 'origin' ? 'https://spa.example.com' : '') }, res, () => { nexted += 1; });
  assert.equal(res.headers['access-control-allow-origin'], 'https://spa.example.com');
  assert.equal(res.headers.vary, 'Origin');
  assert.match(res.headers['access-control-allow-headers'], /X-AI-Fleet-Organization-Id/);
  assert.match(res.headers['access-control-allow-headers'], /X-AI-Fleet-Project-Id/);
  assert.equal(nexted, 1);
});

test('does not reflect a non-allowlisted origin', () => {
  const cors = createCorsMiddleware(['https://spa.example.com']);
  const res = makeRes();
  cors({ method: 'GET', get: () => 'https://evil.example.com' }, res, () => {});
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('answers preflight with 204 (and does not call next)', () => {
  const cors = createCorsMiddleware(['https://spa.example.com']);
  const res = makeRes();
  let nexted = 0;
  cors({ method: 'OPTIONS', get: (n) => (n === 'origin' ? 'https://spa.example.com' : '') }, res, () => { nexted += 1; });
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.equal(nexted, 0);
});

test('is a no-op passthrough when no origins are configured (local same-origin)', () => {
  const cors = createCorsMiddleware([]);
  const res = makeRes();
  let nexted = 0;
  cors({ method: 'GET', get: () => 'https://spa.example.com' }, res, () => { nexted += 1; });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(nexted, 1);
});

test('reflects custom domain origin configured in allowlist', () => {
  const cors = createCorsMiddleware(['https://adlc-9e72f.web.app', 'https://platform.archagentix.com']);
  const res = makeRes();
  let nexted = 0;
  cors({ method: 'GET', get: (n) => (n === 'origin' ? 'https://platform.archagentix.com' : '') }, res, () => { nexted += 1; });
  assert.equal(res.headers['access-control-allow-origin'], 'https://platform.archagentix.com');
  assert.equal(res.headers.vary, 'Origin');
  assert.equal(nexted, 1);
});

test('parseSpaOrigins combines SPA_ORIGIN and FIREBASE_CUSTOM_DOMAIN with normalization', () => {
  const origins = parseSpaOrigins({
    SPA_ORIGIN: 'https://adlc-9e72f.web.app, https://storage.googleapis.com',
    FIREBASE_CUSTOM_DOMAIN: 'platform.archagentix.com, https://custom.example.com',
  });
  assert.deepEqual(origins, [
    'https://adlc-9e72f.web.app',
    'https://storage.googleapis.com',
    'https://platform.archagentix.com',
    'https://custom.example.com',
  ]);
});

test('parseSpaOrigins handles empty or unset env', () => {
  assert.deepEqual(parseSpaOrigins({}), []);
  assert.deepEqual(parseSpaOrigins(undefined), []);
});
