'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-session-test-'));
process.env.AI_FLEET_DATA_DIR = dir;
const store = require('../store');
const { startActorSession, heartbeatActorSession, finishActorSession, monitorActorSession } = require('./actor-sessions');
const { toEvent } = require('./billing-outbox');
const { priceActorUsage } = require('./compute-pricing');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const input = {
  agentId: 'actor-1', orgId: 'org-1', projectId: 'project-1', userId: 'user-1',
  userEmail: 'user@test.invalid', tier: 'standard-1v1g', hourlyRatePaise: 0,
  startedAt: 1794000000, runId: 'run-1', atespace: 'space-1',
};

test('a 90 second zero-priced session persists attribution and seconds, and replay meters once', () => {
  const session = startActorSession(input);
  const closed = finishActorSession(session.id, input.startedAt + 90, { enabled: true });
  assert.equal(closed.durationSeconds, 90);
  assert.equal(closed.metered, true);
  const usage = store.listUsageRecords().filter((r) => r.actorSessionId === session.id);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].costPaise, 0);
  assert.equal(usage[0].userId, input.userId);
  assert.equal(usage[0].userEmail, input.userEmail);
  const rows = store.listBillingOutboxRows().filter((r) => r.actorSessionId === session.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, input.runId);
  assert.equal(rows[0].quantitySeconds, 90);
  assert.deepEqual(toEvent(rows[0]).properties, {
    duration_seconds: 90, org_id: 'org-1', project_id: 'project-1', user_id: 'user-1',
    agent_id: 'actor-1', tier: 'standard-1v1g',
  });
  assert.ok(!JSON.stringify(toEvent(rows[0])).includes(input.userEmail));
  finishActorSession(session.id, input.startedAt + 900, { enabled: true });
  heartbeatActorSession(session.id, input.startedAt + 1000);
  assert.equal(store.getActorSession(session.id).durationSeconds, 90);
  assert.equal(store.getActorSession(session.id).status, 'CLOSED');
  assert.equal(store.listUsageRecords().filter((r) => r.actorSessionId === session.id).length, 1);
});

test('two actors in the same run have distinct delivery keys', () => {
  const a = startActorSession(input);
  const b = startActorSession({ ...input, agentId: 'actor-2' });
  finishActorSession(a.id, input.startedAt + 90, { enabled: true });
  finishActorSession(b.id, input.startedAt + 90, { enabled: true });
  const rows = store.listBillingOutboxRows().filter((r) => [a.id, b.id].includes(r.actorSessionId));
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].idempotencyKey, rows[1].idempotencyKey);
});

test('a backwards clock bills nothing and emits no negative quantity', () => {
  const session = startActorSession(input);
  const closed = finishActorSession(session.id, input.startedAt - 5, { enabled: true });
  assert.equal(closed.durationSeconds, 0);
  assert.equal(store.listBillingOutboxRows().some((r) => r.actorSessionId === session.id), false);
});

test('missing or unknown rates/shapes are refused rather than guessed', () => {
  for (const rate of [undefined, null, '']) {
    assert.throws(() => startActorSession({ ...input, hourlyRatePaise: rate }), /refusing to guess/);
  }
  assert.throws(() => startActorSession({ ...input, tier: 'unknown' }), /unknown actor tier/);
  assert.equal(priceActorUsage({ durationSeconds: 90, hourlyRatePaise: 463 }).expectedPaise, 12);
});

test('heartbeats never move last-seen backwards', () => {
  const session = startActorSession(input);
  heartbeatActorSession(session.id, input.startedAt + 10);
  heartbeatActorSession(session.id, input.startedAt - 10);
  assert.equal(store.getActorSession(session.id).lastSeenAt, input.startedAt + 10);
});

test('failed settlement keeps a closed row retryable without extending its frozen duration', () => {
  const session = startActorSession(input);
  assert.throws(() => finishActorSession(session.id, input.startedAt + 90, {
    recordActorUsage: () => { throw new Error('outbox down'); },
  }));
  assert.equal(store.getActorSession(session.id).metered, false);
  assert.equal(store.getActorSession(session.id).status, 'CLOSED');
  const closed = finishActorSession(session.id, input.startedAt + 900, { enabled: true });
  assert.equal(closed.durationSeconds, 90);
  assert.equal(closed.metered, true);
});

test('monitor owns a heartbeat timer and stops it before publishing final seconds', async () => {
  let at = input.startedAt * 1000;
  const values = [];
  const monitor = monitorActorSession(input, {
    now: () => at, heartbeatMs: 5, enabled: true,
    metrics: { emit: (session) => { values.push(session); return Promise.resolve(true); } },
  });
  at += 90000;
  await new Promise((resolve) => setTimeout(resolve, 12));
  const closed = monitor.stop();
  assert.equal(closed.durationSeconds, 90);
  assert.ok(values.some((s) => s.status === 'RUNNING' && s.lastSeenAt === input.startedAt + 90));
  assert.equal(values.at(-1).status, 'CLOSED');
  const count = values.length;
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(values.length, count);
});

test('only accepted final exports acknowledge telemetry in the persisted session', async () => {
  for (const outcome of ['accepted', 'refused', 'rejected']) {
    const monitor = monitorActorSession(input, {
      now: () => (input.startedAt + 90) * 1000, enabled: true,
      metrics: { emit: async (session) => {
        if (session.status === 'RUNNING') return true;
        if (outcome === 'rejected') throw new Error('collector unavailable');
        return outcome === 'accepted';
      } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.getActorSession(monitor.session.id).metricsExported, false);
    monitor.stop();
    await new Promise((resolve) => setImmediate(resolve));
    const closed = store.getActorSession(monitor.session.id);
    assert.equal(closed.metered, true);
    assert.equal(closed.metricsExported, outcome === 'accepted');
    assert.equal(closed.durationSeconds, 90);
    store.updateActorSession(closed.id, { metricsExported: false });
    assert.equal(store.getActorSession(closed.id).metricsExported, outcome === 'accepted');
  }
});

test('shared sessions are observable but never queued for money', () => {
  const session = startActorSession({ ...input, orgId: '__shared__' });
  finishActorSession(session.id, input.startedAt + 90, { enabled: true });
  assert.equal(store.listBillingOutboxRows().some((r) => r.actorSessionId === session.id), false);
});
