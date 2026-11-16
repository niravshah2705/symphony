'use strict';

const store = require('@ai-fleet/shared-core/store');
const log = require('@ai-fleet/shared-core/logger');
const { settleOrphans, toEpochSeconds, ORPHAN_GRACE_SECONDS } = require('@ai-fleet/shared-core/billing/substrate-session');
const { finishActorSession } = require('@ai-fleet/shared-core/billing/actor-sessions');
const { createActorMetrics } = require('@ai-fleet/shared-core/otel/actor-metrics');

async function sweepActorSessions(deps = {}) {
  const db = deps.store || store;
  const now = toEpochSeconds(deps.now ?? Date.now());
  const graceSeconds = Number(deps.graceSeconds ?? process.env.SUBSTRATE_ORPHAN_GRACE_SECONDS ?? ORPHAN_GRACE_SECONDS);
  if (now == null || !Number.isFinite(graceSeconds) || graceSeconds < 0) {
    throw new TypeError('actor sweeper requires a timestamp and nonnegative grace seconds');
  }
  const metrics = deps.metrics || createActorMetrics();
  const sessions = db.listActorSessions();
  // Collector caches can keep being scraped after a planner dies; only runner heartbeats prove liveness.
  const orphaned = sessions.flatMap((session) => settleOrphans(new Map([[session.id, session]]), {
    now, graceSeconds, lastSeenSecondsAgo: new Map([[session.agentId, Math.max(0, now - session.lastSeenAt)]]),
  }));
  const retries = sessions.filter((s) => s.status === 'CLOSED' && (!s.metered || !s.metricsExported));
  const result = {
    orphaned: orphaned.length, settled: 0, retried: retries.filter((s) => !s.metered).length,
    metricsRetried: retries.filter((s) => s.metered && !s.metricsExported).length,
    metricsPending: 0, failed: 0,
  };
  for (const session of [...orphaned, ...retries]) {
    try {
      const closed = finishActorSession(session.id, session.stoppedAt, {
        ...deps, closeReason: session.closeReason || 'orphan',
      });
      if (!session.metered) result.settled += 1;
      if (await metrics.emit(closed, now * 1000)) {
        db.updateActorSession(session.id, { metricsExported: true });
      } else {
        result.metricsPending += 1;
      }
    } catch {
      result.failed += 1;
      log.error('actor_session_settlement_failed', { sessionId: session.id });
    }
  }
  return result;
}

module.exports = { sweepActorSessions };
