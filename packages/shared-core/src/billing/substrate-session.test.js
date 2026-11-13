'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const s = require('./substrate-session');

const BASE = 1_794_000_000; // a fixed epoch second; no wall clock in these tests

function running(overrides = {}) {
  return s.openSession({
    agentId: 'actor-1',
    orgId: 'org-1',
    projectId: 'proj-1',
    userId: 'user-1',
    tier: 'standard-1v1g',
    hourlyRatePaise: 463,
    startedAt: BASE,
    ...overrides,
  }, new Map());
}

function sessionsWith(...sessions) {
  const map = new Map();
  for (const session of sessions) map.set(session.agentId, session);
  return map;
}

// The names are load-bearing, not cosmetic: the in-cluster scrape job keeps only
// ^(substrate|otelcol)_.* and Prometheus anchors it fully, so anything named
// otherwise is accepted by the collector and then silently never stored.
// Proven against the live cluster by scripts/kind-otel-roundtrip.sh.
test('metric names satisfy the cluster scrape filter', () => {
  for (const [key, name] of Object.entries(s.ACTOR_SESSION_METRICS)) {
    assert.match(name, /^(substrate|otelcol)_/, `${key} would be dropped at scrape time`);
    assert.doesNotMatch(name, /^agent_/, `${key} uses the reference formula's name, which this cluster discards`);
  }
});

test('openSession: normalises the start time to whole epoch seconds', () => {
  assert.equal(running().startedAt, BASE);
  assert.equal(s.openSession({ agentId: 'a', orgId: 'o', tier: 'standard-1v1g', startedAt: BASE * 1000 }, new Map()).startedAt, BASE, 'milliseconds are detected and divided');
  assert.equal(
    s.openSession({ agentId: 'a', orgId: 'o', tier: 'standard-1v1g', startedAt: '2026-11-12T06:00:00.000Z' }, new Map()).startedAt,
    Math.floor(Date.parse('2026-11-12T06:00:00.000Z') / 1000),
  );
  const session = running();
  assert.equal(session.status, s.SESSION_RUNNING);
  assert.equal(session.stoppedAt, null);
  assert.deepEqual(
    [session.orgId, session.projectId, session.userId, session.tier],
    ['org-1', 'proj-1', 'user-1', 'standard-1v1g'],
    'attribution is carried on the session, because no pod metric can supply project or user',
  );
});

test('openSession: refuses an unattributable or untimeable session', () => {
  assert.throws(() => s.openSession({ orgId: 'o', tier: 't', startedAt: BASE }, new Map()), TypeError);
  assert.throws(() => s.openSession({ agentId: 'a', tier: 't', startedAt: BASE }, new Map()), TypeError);
  assert.throws(() => s.openSession({ agentId: 'a', orgId: 'o', startedAt: BASE }, new Map()), TypeError);
  assert.throws(() => s.openSession({ agentId: 'a', orgId: 'o', tier: 't', startedAt: 'not a time' }, new Map()), TypeError);
});

test('closeSession: reports whole seconds of running time', () => {
  assert.equal(s.closeSession(running(), BASE + 90).durationSeconds, 90);
  assert.equal(s.closeSession(running(), BASE + 90).status, s.SESSION_CLOSED);
  assert.equal(s.closeSession(running(), BASE + 90).durationSeconds, duration(running(), BASE + 90));
  assert.equal(s.closeSession(running(), BASE + 90.9).startedAt, BASE, 'the source session is not mutated');
  assert.equal(s.closeSession(null, BASE), null, 'closing a session that was never opened is a no-op, not a crash in a finally block');
});

test('closeSession: a clock that went backwards bills nothing rather than crediting', () => {
  assert.equal(s.closeSession(running(), BASE - 500).durationSeconds, 0, 'an NTP correction must not become a refund');
  assert.equal(s.closeSession(running(), BASE).durationSeconds, 0);
  assert.throws(() => s.closeSession(running(), 'soon'), TypeError);
});

function duration(session, at) {
  return s.closeSession(session, at).durationSeconds;
}

test('accrue: live seconds for a session with no STOP', () => {
  assert.equal(s.accrue(running(), BASE + 50), 50);
  assert.equal(s.accrue(running(), BASE), 0);
  assert.equal(s.accrue(running(), BASE - 50), 0);
  assert.equal(s.accrue(s.closeSession(running(), BASE + 10), BASE + 999), 0, 'a closed session stops accruing');
  assert.equal(s.accrue(null, BASE), 0);
});

test('orphanedSessions: only a session nobody is reporting any more', () => {
  const now = BASE + 1000;
  const fresh = running({ agentId: 'fresh' });
  const stale = running({ agentId: 'stale' });
  const unknownButYoung = running({ agentId: 'young', startedAt: now - 60 });
  const unknownAndOld = running({ agentId: 'old' });
  const map = sessionsWith(fresh, stale, unknownButYoung, unknownAndOld);

  const found = s.orphanedSessions(map, {
    now,
    lastSeenSecondsAgo: new Map([['fresh', 10], ['stale', 500], ['young', null]]),
  }).map((o) => o.session.agentId);

  assert.deepEqual(found, ['stale', 'old'], 'a series still being scraped is proof of life; a vanished writer past the grace period is not');
});

test('orphanedSessions: the grace period is configurable and a young session is never swept', () => {
  const map = sessionsWith(running({ agentId: 'a' }));
  assert.deepEqual(s.orphanedSessions(map, { now: BASE + 60 }), []);
  assert.deepEqual(s.orphanedSessions(map, { now: BASE + 60, graceSeconds: 30 }).map((o) => o.session.agentId), ['a']);
  assert.deepEqual(s.orphanedSessions(sessionsWith(s.closeSession(running({ agentId: 'closed' }), BASE + 5)), { now: BASE + 100000 }), [], 'closed sessions are settled, not orphans');
});

test('settleOrphans: closes at last-seen, not at sweep time', () => {
  const map = sessionsWith(running({ agentId: 'a' }));
  const [settled] = s.settleOrphans(map, { now: BASE + 1000, lastSeenSecondsAgo: new Map([['a', 300]]) });
  assert.equal(settled.durationSeconds, 700, 'the gap between the crash and the sweep is not running time');
  assert.equal(settled.stoppedAt, BASE + 700);
  assert.equal(settled.status, s.SESSION_CLOSED);

  const [noScrapeData] = s.settleOrphans(sessionsWith(running({ agentId: 'b' })), {
    now: BASE + 1000,
    lastSeenSecondsAgo: new Map(),
    graceSeconds: 100,
  });
  assert.equal(noScrapeData.durationSeconds, 0, 'with no last-seen signal, charge nothing rather than guess');
});

test('toEpochSeconds: what counts as a time', () => {
  assert.equal(s.toEpochSeconds(BASE), BASE);
  assert.equal(s.toEpochSeconds(BASE * 1000), BASE);
  assert.equal(s.toEpochSeconds(String(BASE)), BASE);
  assert.equal(s.toEpochSeconds(null), null);
  assert.equal(s.toEpochSeconds(undefined), null);
  assert.equal(s.toEpochSeconds(''), null);
  assert.equal(s.toEpochSeconds('nonsense'), null);
  assert.equal(s.toEpochSeconds(NaN), null);
});
