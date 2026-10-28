'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCorsMiddleware, getDefaultAllowedOrigins, isOriginAllowed } = require('./cors');

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
  assert.match(res.headers['access-control-allow-headers'], /Accept/);
  assert.match(res.headers['access-control-allow-headers'], /X-AI-Fleet-Organization-Id/);
  assert.match(res.headers['access-control-allow-headers'], /X-AI-Fleet-Project-Id/);
  assert.match(res.headers['access-control-allow-headers'], /X-AI-Fleet-Api-Docs/);
  assert.match(res.headers['access-control-allow-headers'], /X-Requested-With/);
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

test('default middleware allows platform.archagentix.com and archagentix.com origins', () => {
  const cors = createCorsMiddleware();
  for (const origin of ['https://platform.archagentix.com', 'https://archagentix.com', 'https://staging.archagentix.com']) {
    const res = makeRes();
    let nexted = 0;
    cors({ method: 'GET', get: (n) => (n === 'origin' ? origin : '') }, res, () => { nexted += 1; });
    assert.equal(res.headers['access-control-allow-origin'], origin, `failed for origin: ${origin}`);
    assert.equal(nexted, 1);
  }
});

test('isOriginAllowed supports exact matches and wildcard patterns', () => {
  const allowlist = new Set(['https://app.example.com', 'https://*.archagentix.com']);
  assert.equal(isOriginAllowed('https://app.example.com', allowlist), true);
  assert.equal(isOriginAllowed('https://platform.archagentix.com', allowlist), true);
  assert.equal(isOriginAllowed('https://sub.platform.archagentix.com', allowlist), true);
  assert.equal(isOriginAllowed('https://evil-archagentix.com', allowlist), false);
  assert.equal(isOriginAllowed('http://platform.archagentix.com', allowlist), false);
  assert.equal(isOriginAllowed('https://other.com', allowlist), false);
  assert.equal(isOriginAllowed('', allowlist), false);
  assert.equal(isOriginAllowed(null, allowlist), false);
});
