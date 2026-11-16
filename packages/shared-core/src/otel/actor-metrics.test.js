'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createActorMetrics } = require('./actor-metrics');
const { openSession, closeSession } = require('../billing/substrate-session');

const BASE = 1_794_000_000;
const ENDPOINT = 'http://collector.test/v1/metrics';
const NAMES = [
  'substrate_actor_start_timestamp_seconds',
  'substrate_actor_first_seen_timestamp_seconds',
  'substrate_actor_running_seconds_total',
];

function session(overrides = {}) {
  return openSession({
    agentId: 'actor-1', orgId: 'org-1', tier: 'standard-1v1g',
    projectId: 'project-1', userId: 'user-1', startedAt: BASE,
    hourlyRatePaise: 463, ...overrides,
  });
}

function response(result = {}, status = 200) {
  return { status, json: async () => result };
}

function capture() {
  const calls = [];
  const exporter = createActorMetrics({ endpoint: ENDPOINT, fetchImpl: async (url, options) => {
    calls.push({ url, options, payload: JSON.parse(options.body) });
    return response();
  } });
  return { calls, exporter };
}

function metrics(call) {
  return call.payload.resourceMetrics[0].scopeMetrics[0].metrics;
}

function values(call) {
  return metrics(call).map((metric) => metric.gauge.dataPoints[0].asDouble);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('RUNNING emits exactly three numeric gauges with precise time and allowlisted attribution', async () => {
  const { calls, exporter } = capture();
  const now = (BASE + 90) * 1000 + 123;
  const actor = { ...session(), userEmail: 'private@example.test', email: 'private@example.test' };
  assert.equal(await exporter.emit(actor, now), true);
  const [{ url, options, payload }] = calls;
  assert.equal(url, ENDPOINT);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
  assert.ok(options.signal instanceof AbortSignal);
  const labels = [
    ['fleet_org_id', 'org-1'], ['substrate_tier', 'standard-1v1g'], ['agent_id', 'actor-1'],
    ['project_id', 'project-1'], ['user_id', 'user-1'],
  ].map(([key, value]) => ({ key, value: { stringValue: value } }));
  assert.deepEqual(payload, { resourceMetrics: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'fleet-actor-sessions' } }] },
    scopeMetrics: [{ metrics: NAMES.map((name, i) => ({ name, gauge: { dataPoints: [{
      attributes: labels, asDouble: [BASE, BASE, 90][i], timeUnixNano: '1794000090123000000',
    }] } })) }],
  }] });
  assert.deepEqual(Object.keys(require('./actor-metrics')), ['createActorMetrics']);
});

test('CLOSED resets live start, preserves first-seen and uses final duration, not the current clock', async () => {
  const { calls, exporter } = capture();
  const closed = { ...closeSession(session(), BASE + 90), durationSeconds: 87 };
  assert.equal(await exporter.emit(closed, (BASE + 1000) * 1000), true);
  assert.deepEqual(values(calls[0]), [0, BASE, 87]);
  assert.deepEqual(metrics(calls[0]).map((m) => m.name), NAMES);
  for (const metric of metrics(calls[0])) {
    assert.equal(metric.gauge.dataPoints[0].timeUnixNano, '1794001000000000000');
  }
});

test('clock skew emits zero running seconds without changing first-seen', async () => {
  const { calls, exporter } = capture();
  await exporter.emit(session(), (BASE - 50) * 1000);
  await exporter.emit(closeSession(session(), BASE - 50), (BASE - 50) * 1000);
  assert.deepEqual(values(calls[0]), [BASE, BASE, 0]);
  assert.deepEqual(values(calls[1]), [0, BASE, 0]);
});

test('empty project/user identifiers are omitted from every datapoint', async () => {
  for (const absent of [null, undefined, '', '   ']) {
    const { calls, exporter } = capture();
    await exporter.emit(session({ projectId: absent, userId: absent }), BASE * 1000);
    for (const metric of metrics(calls[0])) {
      assert.deepEqual(metric.gauge.dataPoints[0].attributes.map((a) => a.key),
        ['fleet_org_id', 'substrate_tier', 'agent_id']);
    }
  }
});

test('disabled exporter does not read the session, log, or make a network call', async () => {
  const exporter = createActorMetrics({ endpoint: '', fetchImpl: () => assert.fail('network'),
    log: () => assert.fail('log') });
  assert.equal(await exporter.emit(null), false);
});

test('defaults use the operator endpoint and Date.now', async () => {
  const before = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = ENDPOINT;
  try {
    let point;
    const exporter = createActorMetrics({ fetchImpl: async (url, options) => {
      assert.equal(url, ENDPOINT);
      point = JSON.parse(options.body).resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0];
      return response();
    } });
    const earliest = Date.now();
    assert.equal(await exporter.emit(session()), true);
    const ms = Number(BigInt(point.timeUnixNano) / 1_000_000n);
    assert.ok(ms >= earliest && ms <= Date.now());
  } finally {
    if (before === undefined) delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = before;
  }
});

test('network, non-2xx, partial rejection and invalid JSON fail safely with only a generic event', async (t) => {
  const cases = {
    network: async () => { throw new Error('sensitive upstream details'); },
    redirect: async () => response({}, 302),
    non200: async () => response({}, 503),
    partial: async () => response({ partialSuccess: { rejectedDataPoints: '1', errorMessage: 'private body' } }),
    invalidJSON: async () => ({ status: 200, json: async () => { throw new SyntaxError('private body'); } }),
    nullJSON: async () => response(null),
  };
  for (const [name, fetchImpl] of Object.entries(cases)) {
    await t.test(name, async () => {
      const logs = [];
      const exporter = createActorMetrics({ endpoint: ENDPOINT, fetchImpl, log: (...args) => logs.push(args) });
      assert.equal(await exporter.emit(session(), BASE * 1000), false);
      assert.deepEqual(logs, [['actor_metrics_export_failed']]);
    });
  }
});

test('successful non-200 2xx and partialSuccess with zero rejection are accepted', async () => {
  for (const result of [{}, { partialSuccess: { rejectedDataPoints: '0' } }, { partialSuccess: {} }]) {
    const exporter = createActorMetrics({ endpoint: ENDPOINT,
      fetchImpl: async () => response(result, 202), log: () => assert.fail('log') });
    assert.equal(await exporter.emit(session(), BASE * 1000), true);
  }
});

test('timeout covers response decoding, aborts the request and returns false', async () => {
  let signal;
  const logs = [];
  const exporter = createActorMetrics({ endpoint: ENDPOINT, timeoutMs: 10,
    fetchImpl: async (_, options) => {
      signal = options.signal;
      return { status: 200, json: () => new Promise(() => {}) };
    }, log: (event) => logs.push(event) });
  assert.equal(await exporter.emit(session(), BASE * 1000), false);
  assert.equal(signal.aborted, true);
  assert.deepEqual(logs, ['actor_metrics_export_failed']);
});

test('a stalled fetch times out and releases the queue for STOP', async () => {
  let calls = 0;
  let signal;
  const exporter = createActorMetrics({ endpoint: ENDPOINT, timeoutMs: 10, log: () => {},
    fetchImpl: async (_, options) => {
      if (++calls === 1) {
        signal = options.signal;
        return new Promise(() => {});
      }
      return response();
    } });
  assert.deepEqual(await Promise.all([
    exporter.emit(session(), BASE * 1000),
    exporter.emit(closeSession(session(), BASE + 90), (BASE + 90) * 1000),
  ]), [false, true]);
  assert.equal(signal.aborted, true);
  assert.equal(calls, 2);
});

test('overlapping heartbeat and STOP are snapshotted and sent in invocation order', async () => {
  const started = deferred();
  const finishHeartbeat = deferred();
  const calls = [];
  const exporter = createActorMetrics({ endpoint: ENDPOINT, fetchImpl: async (_, options) => {
    calls.push({ payload: JSON.parse(options.body) });
    if (calls.length === 1) {
      started.resolve();
      await finishHeartbeat.promise;
    }
    return response();
  } });
  const actor = session();
  const heartbeat = exporter.emit(actor, (BASE + 30) * 1000);
  const stop = exporter.emit(closeSession(actor, BASE + 90), (BASE + 90) * 1000);
  actor.startedAt = BASE + 999;
  await started.promise;
  assert.equal(calls.length, 1);
  finishHeartbeat.resolve();
  assert.deepEqual(await Promise.all([heartbeat, stop]), [true, true]);
  assert.deepEqual(calls.map(values), [[BASE, BASE, 30], [0, BASE, 90]]);
});

test('failure and a throwing logger do not poison subsequent queued sends', async () => {
  let calls = 0;
  const exporter = createActorMetrics({ endpoint: ENDPOINT, fetchImpl: async () => {
    if (++calls === 1) throw new Error('network');
    return response();
  }, log: () => { throw new Error('logger'); } });
  assert.deepEqual(await Promise.all([
    exporter.emit(session(), BASE * 1000),
    exporter.emit(closeSession(session(), BASE + 90), (BASE + 90) * 1000),
  ]), [false, true]);
});
