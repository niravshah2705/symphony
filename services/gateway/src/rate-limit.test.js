'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIpRateLimit, retryAfterSeconds, MAX_KEYS } = require('./rate-limit');

// A stub res records what a caller would see; no Express, no port.
function makeRes() {
  const headers = {};
  const res = {
    headers,
    statusCode: null,
    body: null,
    set(name, value) { headers[name] = String(value); return res; },
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

function harness(options = {}) {
  let clock = 1000000;
  const limiter = createIpRateLimit({ windowMs: 60000, max: 3, now: () => clock, ...options });
  const call = (ip = '203.0.113.7', method = 'POST') => {
    const req = { ip, method };
    const res = makeRes();
    let passed = false;
    limiter(req, res, () => { passed = true; });
    return { passed, res };
  };
  return { limiter, call, advance: (ms) => { clock += ms; } };
}

test('the first `max` requests pass and the next one is refused', () => {
  const { call } = harness();
  for (let i = 0; i < 3; i += 1) {
    const { passed, res } = call();
    assert.ok(passed, `request ${i + 1} should be allowed`);
    assert.equal(res.headers['X-RateLimit-Limit'], '3');
    assert.equal(res.headers['X-RateLimit-Remaining'], String(2 - i));
  }
  const { passed, res } = call();
  assert.equal(passed, false);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.body, { error: 'Too many requests from this address. Please slow down.', code: 'rate_limited' });
  assert.equal(res.headers['Retry-After'], '60');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('the window is fixed: it resets on its own clock, not on every request', () => {
  const { call, advance } = harness();
  for (let i = 0; i < 3; i += 1) call();
  advance(30000);
  assert.equal(call().res.statusCode, 429, 'a sliding window would have freed a slot here');
  advance(30001);
  assert.ok(call().passed, 'the window has now rolled over');
});

test('addresses are counted independently, keyed on the trusted req.ip', () => {
  const seen = [];
  const limiter = createIpRateLimit({ windowMs: 60000, max: 1, keyFor: (req) => { seen.push(req.ip); return req.ip; }, now: () => 1 });
  const fire = (ip) => {
    const res = makeRes();
    let passed = false;
    limiter({ ip, method: 'GET' }, res, () => { passed = true; });
    return { passed, res };
  };
  assert.ok(fire('198.51.100.1').passed);
  assert.equal(fire('198.51.100.1').res.statusCode, 429);
  assert.ok(fire('198.51.100.2').passed, 'one visitor must not inherit another\'s throttle');
  assert.deepEqual(seen, ['198.51.100.1', '198.51.100.1', '198.51.100.2']);
});

test('disabled means a pass-through, which is what keeps local dev and e2e unthrottled', () => {
  const { call, limiter } = harness({ enabled: false, max: 1 });
  for (let i = 0; i < 10; i += 1) assert.ok(call().passed);
  assert.equal(limiter.enabled, false);
  assert.equal(limiter.size(), 0, 'a disabled limiter must not accumulate buckets');
  assert.equal(call().res.headers['X-RateLimit-Limit'], undefined);
});

test('a zero window or a zero max is treated as not enabled, not as a permanent lockout', () => {
  assert.equal(harness({ max: 0 }).limiter.enabled, false);
  assert.equal(harness({ windowMs: 0 }).limiter.enabled, false);
  assert.equal(harness({ windowMs: undefined, max: undefined }).limiter.enabled, false);
  // Sanity: those configurations let traffic through instead of 429-ing the site.
  assert.ok(harness({ max: 0 }).call().passed);
});

test('OPTIONS preflight is never gated', () => {
  const { call } = harness();
  for (let i = 0; i < 10; i += 1) assert.ok(call('203.0.113.7', 'OPTIONS').passed);
  // …and consumes nothing: the POST budget is intact afterwards.
  assert.ok(call().passed);
});

test('the map is bounded, so the limiter cannot become the memory DoS', () => {
  // Clock frozen on purpose: a live clock would let the sweep expire buckets and
  // the map would never hit the ceiling, so the eviction path would go untested.
  let clock = 0;
  const limiter = createIpRateLimit({ windowMs: 1000, max: 1, now: () => clock });
  for (let i = 0; i < MAX_KEYS + 500; i += 1) {
    const res = makeRes();
    limiter({ ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, method: 'GET' }, res, () => {});
  }
  assert.ok(limiter.size() <= MAX_KEYS, `size grew to ${limiter.size()}`);
});

test('an unknown address still gets its own bucket instead of sharing none', () => {
  const { limiter } = harness();
  assert.equal(typeof limiter.peek, 'function');
  const res = makeRes();
  let passed = false;
  limiter({ method: 'GET' }, res, () => { passed = true; });
  assert.ok(passed, 'req.ip undefined must fall back to a key, not throw');
});

test('Retry-After never reports zero or a negative wait', () => {
  assert.equal(retryAfterSeconds(1000, 1000), 1);
  assert.equal(retryAfterSeconds(1000, 999), 1);
  assert.equal(retryAfterSeconds(45500, 1000), 45);
  assert.equal(retryAfterSeconds(1000, 5000), 1, 'already elapsed: still a whole second, not 0');
});

test('peek reports the allowance without consuming it', () => {
  const { call, limiter } = harness();
  call();
  const before = limiter.size();
  assert.equal(limiter.peek('203.0.113.7', 1000000), 2);
  assert.equal(limiter.size(), before, 'peek must not create or advance a bucket');
  assert.equal(limiter.peek('192.0.2.9', 1000000), 3);
});

test('reset clears the state, for tests and for an operator rotating policy', () => {
  const { call, limiter } = harness();
  for (let i = 0; i < 4; i += 1) call();
  assert.equal(limiter.size(), 1);
  limiter.reset();
  assert.equal(limiter.size(), 0);
  assert.ok(call().passed);
});
