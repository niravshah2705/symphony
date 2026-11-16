'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readSavingsPanel } = require('./savings-panel');

const TIER = 'standard-1v1g';
const NOW = 1700003600;
const FIRST = NOW - 3600;
const BASE = 'https://prometheus.example/otel';
const sample = (agentId, value, tier = TIER) => ({
  metric: { agent_id: agentId, substrate_tier: tier },
  // Deliberately unrelated scrape timestamp: the VALUE owns the actor clock.
  value: [NOW - 1, String(value)],
});
const vector = (rows) => ({ status: 'success', data: { resultType: 'vector', result: rows } });
function fixture(first = [sample('actor-a', FIRST)], running = [sample('actor-a', 90)]) {
  const calls = [];
  return {
    calls,
    deps: {
      baseUrl: BASE,
      fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), options });
        const rows = new URL(url).searchParams.get('query').includes('min_over_time') ? first : running;
        return { ok: true, json: async () => vector(rows) };
      },
    },
  };
}
const input = (extra = {}) => ({ orgId: 'org-a', now: NOW, ...extra });
function prometheusEnv(t, value) {
  const previous = process.env.SUBSTRATE_PROMETHEUS_URL;
  process.env.SUBSTRATE_PROMETHEUS_URL = value;
  t.after(() => {
    if (previous === undefined) delete process.env.SUBSTRATE_PROMETHEUS_URL;
    else process.env.SUBSTRATE_PROMETHEUS_URL = previous;
  });
}

function assertUnavailable(result) {
  assert.equal(result.available, false);
  assert.equal(typeof result.reason, 'string');
  assert.equal(Object.hasOwn(result, 'actors'), false);
  assert.equal(Object.hasOwn(result, 'hourlyRatePaise'), false);
}

test('90-second closed-session fixture: exact tenant lookback queries, seconds and explicit D4 price 0', async () => {
  const { calls, deps } = fixture();
  const result = await readSavingsPanel(input(), deps);
  assert.equal(result.available, true);
  assert.equal(result.hourlyRatePaise, 0);
  assert.equal(result.window, '30d');
  assert.deepEqual(calls.map(({ url }) => url.searchParams.get('query')), [
    'max by(agent_id,substrate_tier) (min_over_time(substrate_actor_first_seen_timestamp_seconds{fleet_org_id="org-a"}[30d]))',
    'max by(agent_id,substrate_tier) (last_over_time(substrate_actor_running_seconds_total{fleet_org_id="org-a"}[30d]))',
  ]);
  for (const { url, options } of calls) {
    assert.equal(url.origin, 'https://prometheus.example');
    assert.equal(url.pathname, '/otel/api/v1/query');
    assert.equal(url.searchParams.get('time'), String(NOW));
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.doesNotMatch(url.searchParams.get('query'), /hourly_rate|timestamp\(|rate\(|increase\(|start_timestamp/);
  }
  assert.deepEqual(result.actors, [{
    agentId: 'actor-a', tier: TIER, firstSeenAt: FIRST,
    baselineSeconds: 3600, actualSeconds: 90, idleSeconds: 3510,
    price: { tier: TIER, meterName: 'actor-compute', meterUnit: 'seconds', meterValue: 90,
      hourlyRatePaise: 0, expectedPaise: 0 },
    savings: { available: true, baselineSeconds: 3600, baselinePaise: 0,
      billedSeconds: 90, billedPaise: 0, netSavedPaise: 0, idleSeconds: 3510, idlePercent: 97.5 },
  }]);
});

test('a corrected final duration replaces a larger earlier heartbeat', async () => {
  const result = await readSavingsPanel(input(), {
    baseUrl: BASE,
    fetchImpl: async (url) => {
      const query = new URL(url).searchParams.get('query');
      const rows = query.includes('min_over_time')
        ? [sample('actor-a', FIRST)]
        : [sample('actor-a', query.includes('last_over_time') ? 80 : 90)];
      return { ok: true, json: async () => vector(rows) };
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.actors[0].actualSeconds, 80);
  assert.equal(result.actors[0].idleSeconds, 3520);
});

test('both instant reads share a bounded AbortSignal.timeout', async (t) => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const durations = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    durations.push(milliseconds);
    return nativeTimeout(milliseconds);
  });
  const { calls, deps } = fixture();
  assert.equal((await readSavingsPanel(input(), deps)).available, true);
  assert.deepEqual(durations, [5000]);
  assert.equal(calls[0].options.signal, calls[1].options.signal);
});

test('an observed zero duration is available, unlike an empty vector', async () => {
  const { deps } = fixture([sample('actor-a', FIRST)], [sample('actor-a', 0)]);
  const result = await readSavingsPanel(input(), deps);
  assert.equal(result.available, true);
  assert.equal(result.actors[0].actualSeconds, 0);
  assert.equal(result.actors[0].idleSeconds, 3600);
});

test('90-second fixture uses supplied test rate without reading any rate metric', async () => {
  const { deps } = fixture();
  const result = await readSavingsPanel(input(), { ...deps, hourlyRatePaise: 2000 });
  assert.equal(result.actors[0].price.expectedPaise, 50);
  assert.equal(result.actors[0].savings.baselinePaise, 2000);
  assert.equal(result.actors[0].savings.netSavedPaise, 1950);
});

test('quote, backslash and newline injection is escaped as a single exact org matcher', async () => {
  const orgId = 'org"}, fleet_org_id=~".*" #\\\n';
  const { calls, deps } = fixture();
  assert.equal((await readSavingsPanel(input({ orgId, window: '7d', baseUrl: 'https://attacker.example' }), deps)).available, true);
  assert.deepEqual(calls.map(({ url }) => url.searchParams.get('query')), [
    `max by(agent_id,substrate_tier) (min_over_time(substrate_actor_first_seen_timestamp_seconds{fleet_org_id=${JSON.stringify(orgId)}}[7d]))`,
    `max by(agent_id,substrate_tier) (last_over_time(substrate_actor_running_seconds_total{fleet_org_id=${JSON.stringify(orgId)}}[7d]))`,
  ]);
  assert.ok(calls.every(({ url }) => url.origin === 'https://prometheus.example'));
});

test('missing config never fetches, even with a caller-supplied upstream URL', async (t) => {
  prometheusEnv(t, '');
  let fetched = false;
  const result = await readSavingsPanel(input({ baseUrl: BASE }), {
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
  });
  assertUnavailable(result);
  assert.equal(fetched, false);
});

test('trusted environment supplies configured upstream', async (t) => {
  prometheusEnv(t, BASE);
  const { calls, deps } = fixture();
  delete deps.baseUrl;
  assert.equal((await readSavingsPanel(input(), deps)).available, true);
  assert.equal(calls.length, 2);
});

test('org is required and shared attribution is refused without fetching', async () => {
  const { calls, deps } = fixture();
  for (const orgId of [undefined, null, '', ' ', 123]) {
    await assert.rejects(readSavingsPanel(input({ orgId }), deps), TypeError);
  }
  for (const orgId of ['__shared__', ' __shared__ ']) {
    assertUnavailable(await readSavingsPanel(input({ orgId }), deps));
  }
  assert.equal(calls.length, 0);
});

test('only omission selects rate zero: explicit undefined/null and invalid custom rates reject', async () => {
  const { calls, deps } = fixture();
  for (const hourlyRatePaise of [undefined, null, NaN, Infinity, -1, '0', '', false, Number.MAX_VALUE]) {
    await assert.rejects(readSavingsPanel(input(), { ...deps, hourlyRatePaise }), /hourlyRatePaise/);
  }
  assert.equal(calls.length, 0);
  assert.equal((await readSavingsPanel(input(), { ...deps, hourlyRatePaise: 0 })).available, true);
});

test('window and epoch seconds are validated before network access', async () => {
  const { calls, deps } = fixture();
  for (const window of [null, '', '0d', '59s', '91d', '1000000w', '1d] offset 1d', '1h30m', 30]) {
    await assert.rejects(readSavingsPanel(input({ window }), deps), /window/);
  }
  for (const now of [null, NaN, Infinity, -1, '1700003600']) {
    await assert.rejects(readSavingsPanel(input({ now }), deps), /now/);
  }
  assert.equal(calls.length, 0);
  for (const window of ['60s', '1m', '24h', '90d']) {
    assert.equal((await readSavingsPanel(input({ window }), deps)).available, true);
  }
});

test('network, abort, HTTP, JSON and Prometheus errors are unavailable, never fabricated zeros', async () => {
  const failures = [
    async () => { throw new Error('network'); },
    async () => { throw new DOMException('timeout', 'TimeoutError'); },
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } }),
    async () => ({ ok: true, json: async () => ({ status: 'error', error: 'query error' }) }),
    async () => ({ ok: true, json: async () => ({ status: 'success', data: { resultType: 'matrix', result: [] } }) }),
  ];
  for (const fetchImpl of failures) {
    assertUnavailable(await readSavingsPanel(input(), { baseUrl: BASE, fetchImpl }));
  }
});

test('empty, incomplete, duplicate, malformed or inconsistent actor data is unavailable', async () => {
  const cases = [
    [[], []], [[], [sample('a', 90)]], [[sample('a', FIRST)], []],
    [[sample('a', FIRST)], [sample('b', 90)]],
    [[sample('a', FIRST), sample('a', FIRST)], [sample('a', 90)]],
    [[sample('a', FIRST)], [sample('a', 90), sample('a', 90)]],
    [[sample('a', NOW + 1)], [sample('a', 90)]],
    [[sample('a', FIRST)], [sample('a', 3601)]],
    [[sample('a', FIRST)], [sample('a', 'NaN')]],
    [[sample('a', FIRST)], [sample('a', -1)]],
    [[sample('a', FIRST)], [sample('a', '')]],
    [[sample('a', FIRST)], [{ metric: { agent_id: 'a' }, value: [NOW, '90'] }]],
    [[sample('a', FIRST, 'unknown')], [sample('a', 90, 'unknown')]],
  ];
  for (const [first, running] of cases) {
    assertUnavailable(await readSavingsPanel(input(), fixture(first, running).deps));
  }
});

test('actor+tier join is independent of response order; tier mismatch never cross-joins', async () => {
  const { deps } = fixture(
    [sample('b', NOW - 1800), sample('a', FIRST)],
    [sample('a', 90), sample('b', 60)],
  );
  const result = await readSavingsPanel(input(), deps);
  assert.deepEqual(result.actors.map(({ agentId, baselineSeconds, actualSeconds }) =>
    [agentId, baselineSeconds, actualSeconds]), [['a', 3600, 90], ['b', 1800, 60]]);
  const mismatch = fixture([sample('a', FIRST)], [sample('a', 90, 'different-tier')]);
  assertUnavailable(await readSavingsPanel(input(), mismatch.deps));
});

test('invalid configured URLs fail unavailable without fetching', async () => {
  const { calls, deps } = fixture();
  for (const baseUrl of ['not a URL', 'file:///tmp/prometheus', 'https://user:pass@example.com', `${BASE}?query=evil`, `${BASE}#evil`]) {
    assertUnavailable(await readSavingsPanel(input(), { ...deps, baseUrl }));
  }
  assert.equal(calls.length, 0);
});
