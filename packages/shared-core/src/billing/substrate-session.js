'use strict';

// Actor session accounting: the state machine behind "how long was this actor
// running", in integer seconds.
//
// Why duration lives here and not in Prometheus. The substrate control plane
// already publishes `ate_actor_stats_cpu_time_seconds_total` and
// `ate_actor_stats_memory_working_set_bytes`, but both are aggregated per
// ActorTemplate/atespace by atelet reading cgroups — there is no per-actor
// series, and actors are not Kubernetes objects in this deployment at all
// (the only ate.dev CRDs are workerpools, sandboxconfigs and csidriverconfigs).
// So measured CPU can reconcile an org's spend but cannot answer "which project
// and which user", which the usage dashboard requires. The runner knows all
// three, so the runner owns the clock.
//
// Metric naming is a contract, not a style choice here: the in-cluster scrape
// job keeps only `^(substrate|otelcol)_.*`, and Prometheus anchors that fully,
// so a series named `agent_substrate_*` is accepted by the collector — it even
// increments `substrate_datapoints_total` — and then vanishes at scrape time.
// Verified with scripts/kind-otel-roundtrip.sh. Hence the names below.

const ACTOR_SESSION_METRICS = Object.freeze({
  startTimestamp: 'substrate_actor_start_timestamp_seconds',
  firstSeenTimestamp: 'substrate_actor_first_seen_timestamp_seconds',
  runningSeconds: 'substrate_actor_running_seconds_total',
});

const SESSION_RUNNING = 'RUNNING';
const SESSION_CLOSED = 'CLOSED';

// A scrape interval is 15s, so a session last seen more than a few intervals ago
// is not "still running", it is a writer that died. Under this long the sweeper
// would close sessions for actors that are merely between scrapes.
const ORPHAN_GRACE_SECONDS = 180;

/**
 * Normalise anything the runner might hand over to whole epoch seconds.
 *
 * Millisecond values are detected by magnitude rather than by type, because the
 * same field arrives as `Date.now()`, as an ISO string from a store row, and as
 * a number read back out of Prometheus — and a session opened from a
 * millisecond value treated as seconds would bill for fifty-six years.
 */
function toEpochSeconds(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  const numeric = typeof value === 'number' ? value : (/^\d+$/.test(String(value).trim()) ? Number(value) : NaN);
  if (Number.isFinite(numeric)) return numeric > 1e11 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

/** Begin a billable session. `tier` is the actor's resource shape, see TIERS. */
function openSession({ agentId, orgId, projectId = null, userId = null, tier, startedAt, hourlyRatePaise }, sessions = new Map()) {
  const agent = String(agentId || '');
  if (!agent) throw new TypeError('substrateSession.openSession: agentId is required');
  if (!orgId) throw new TypeError('substrateSession.openSession: orgId is required');
  if (!tier) throw new TypeError('substrateSession.openSession: tier is required');
  const started = toEpochSeconds(startedAt);
  if (started == null) throw new TypeError('substrateSession.openSession: startedAt is not a time');

  const session = {
    agentId: agent,
    orgId,
    projectId,
    userId,
    tier,
    hourlyRatePaise,
    startedAt: started,
    stoppedAt: null,
    status: SESSION_RUNNING,
  };
  sessions.set(agent, session);
  return session;
}

/**
 * End a session and report the billable duration.
 *
 * Duration is floored to whole seconds and never negative: a clock that goes
 * backwards (an NTP correction across a long run) must not produce a credit, and
 * must not throw either — the run happened and tearing the actor down afterwards
 * is more important than the last few seconds of accuracy.
 */
function closeSession(session, stoppedAt) {
  if (!session) return null;
  const stopped = toEpochSeconds(stoppedAt);
  if (stopped == null) throw new TypeError('substrateSession.closeSession: stoppedAt is not a time');
  const durationSeconds = Math.max(0, stopped - session.startedAt);
  return {
    ...session,
    stoppedAt: stopped,
    durationSeconds,
    status: SESSION_CLOSED,
  };
}

/** Live accrued seconds for a session that never got a STOP. */
function accrue(session, now) {
  const at = toEpochSeconds(now);
  if (!session || session.status !== SESSION_RUNNING || at == null) return 0;
  return Math.max(0, at - session.startedAt);
}

/**
 * Running sessions whose writer has stopped proving they exist.
 *
 * This is the case a duration-based bill cannot get wrong in the customer's
 * favour: if the planner pod dies between resume and suspend there is no STOP,
 * and "keep accruing forever" would eventually charge an org for days it did
 * not use. `lastSeenSecondsAgo` comes from the Prometheus query — a series that
 * is still being scraped is fresh, so an actor genuinely running is never
 * swept, and only a session that stopped reporting is closed.
 */
function orphanedSessions(sessions, { now, lastSeenSecondsAgo = new Map(), graceSeconds = ORPHAN_GRACE_SECONDS } = {}) {
  const at = toEpochSeconds(now);
  if (at == null) throw new TypeError('substrateSession.orphanedSessions: now is not a time');
  const out = [];
  for (const session of sessions.values()) {
    if (session.status !== SESSION_RUNNING) continue;
    const ago = lastSeenSecondsAgo.get(session.agentId);
    if (ago != null && ago <= graceSeconds) continue;
    if (ago == null && accrue(session, at) <= graceSeconds) continue;
    out.push({ session, accruedSeconds: accrue(session, at) });
  }
  return out;
}

/**
 * Close every orphan at the moment it was last seen, not at sweep time.
 *
 * Charging up to `now` would bill the gap between the crash and the sweep as
 * running time. Falling back to startedAt when the last scrape is unknown
 * charges nothing extra, which is the error to prefer.
 */
function settleOrphans(sessions, { now, lastSeenSecondsAgo = new Map(), graceSeconds = ORPHAN_GRACE_SECONDS } = {}) {
  const at = toEpochSeconds(now);
  return orphanedSessions(sessions, { now: at, lastSeenSecondsAgo, graceSeconds }).map(({ session }) => {
    const ago = lastSeenSecondsAgo.get(session.agentId);
    const closedAt = ago == null ? session.startedAt : at - ago;
    return closeSession(session, Math.max(session.startedAt, closedAt));
  });
}

module.exports = {
  ACTOR_SESSION_METRICS,
  SESSION_RUNNING,
  SESSION_CLOSED,
  ORPHAN_GRACE_SECONDS,
  toEpochSeconds,
  openSession,
  closeSession,
  accrue,
  orphanedSessions,
  settleOrphans,
};
