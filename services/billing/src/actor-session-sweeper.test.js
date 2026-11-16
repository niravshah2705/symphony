'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sweepActorSessions } = require('./actor-session-sweeper');

function fixture(overrides = {}) {
  let row = {
    id: 'session-1', agentId: 'actor-1', orgId: 'org-1', tier: 'standard-1v1g',
    startedAt: 1794000000, lastSeenAt: 1794000090, hourlyRatePaise: 0,
    status: 'RUNNING', metered: false, ...overrides,
  };
  const recorded = [];
  const emitted = [];
  return {
    now: 1794000400,
    store: {
      listActorSessions: () => [row],
      getActorSession: () => row,
      updateActorSession: (_id, patch) => {
        row = row.status === 'CLOSED' ? {
          ...row, metered: row.metered || patch.metered,
          metricsExported: row.metricsExported || patch.metricsExported,
        }
          : { ...row, ...patch };
        return row;
      },
    },
    metrics: { emit: async (session) => { emitted.push(session); return true; } },
    recordActorUsage: (session) => recorded.push(session),
    recorded, emitted, row: () => row,
  };
}

test('planner crash closes at runner last-seen, not fresh scrape or sweep time', async () => {
  const deps = fixture();
  const result = await sweepActorSessions(deps);
  assert.equal(result.settled, 1);
  assert.equal(deps.row().stoppedAt, 1794000090);
  assert.equal(deps.row().durationSeconds, 90);
  assert.equal(deps.row().closeReason, 'orphan');
  assert.equal(deps.recorded[0].durationSeconds, 90);
  assert.equal(deps.emitted[0].status, 'CLOSED');
  const again = await sweepActorSessions({ ...deps, now: 1794009000 });
  assert.equal(again.settled, 0);
  assert.equal(deps.recorded.length, 1);
});

test('a still-heartbeating actor is never swept', async () => {
  const deps = fixture({ lastSeenAt: 1794000390 });
  assert.equal((await sweepActorSessions(deps)).orphaned, 0);
  assert.equal(deps.recorded.length, 0);
});

test('a young session without an observed heartbeat remains running', async () => {
  const deps = fixture({ startedAt: 1794000390, lastSeenAt: 1794000390 });
  assert.equal((await sweepActorSessions(deps)).settled, 0);
});

test('a failed close remains retryable and keeps its original duration', async () => {
  const deps = fixture();
  const first = await sweepActorSessions({ ...deps, recordActorUsage: () => { throw new Error('outbox outage'); } });
  assert.equal(first.failed, 1);
  assert.equal(deps.row().status, 'CLOSED');
  assert.equal(deps.row().metered, false);
  const second = await sweepActorSessions({ ...deps, now: 1794009999 });
  assert.equal(second.retried, 1);
  assert.equal(deps.recorded[0].durationSeconds, 90);
});

test('final telemetry retries independently after metering without billing again', async () => {
  const deps = fixture();
  const first = await sweepActorSessions({ ...deps, metrics: { emit: async () => false } });
  assert.equal(first.settled, 1);
  assert.equal(first.metricsPending, 1);
  assert.equal(deps.row().metered, true);
  assert.equal(Boolean(deps.row().metricsExported), false);
  const second = await sweepActorSessions(deps);
  assert.equal(second.settled, 0);
  assert.equal(second.metricsRetried, 1);
  assert.equal(deps.row().metricsExported, true);
  assert.equal(deps.recorded.length, 1);
  assert.equal((await sweepActorSessions(deps)).metricsRetried, 0);
});

test('clock skew never produces a credit or sweeps a future heartbeat', async () => {
  const deps = fixture({ lastSeenAt: 1794000500 });
  assert.equal((await sweepActorSessions(deps)).settled, 0);
});

test('invalid grace or clock is refused, not an immediate mass close', async () => {
  for (const graceSeconds of [-1, NaN, 'bad']) {
    await assert.rejects(sweepActorSessions({ ...fixture(), graceSeconds }), TypeError);
  }
  await assert.rejects(sweepActorSessions({ ...fixture(), now: 'bad' }), TypeError);
});
