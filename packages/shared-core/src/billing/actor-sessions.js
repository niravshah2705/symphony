'use strict';

const { randomUUID } = require('node:crypto');
const store = require('../store');
const log = require('../logger');
const { openSession, closeSession, toEpochSeconds } = require('./substrate-session');
const { priceActorUsage } = require('./compute-pricing');
const { recordActorUsage } = require('./usage');

function startActorSession(input, deps = {}) {
  priceActorUsage({ ...input, durationSeconds: 0 });
  const session = openSession(input);
  return (deps.store || store).addActorSession({
    ...session, id: `act_${randomUUID()}`, atespace: input.atespace,
    runId: input.runId || null, userEmail: input.userEmail || null,
    lastSeenAt: session.startedAt, metered: false, metricsExported: false,
  });
}

function heartbeatActorSession(id, now = Date.now(), deps = {}) {
  const db = deps.store || store;
  const at = toEpochSeconds(now);
  if (at == null) throw new TypeError('actor heartbeat needs a timestamp');
  return db.updateActorSession(id, { lastSeenAt: at });
}

function finishActorSession(id, stoppedAt, deps = {}) {
  const db = deps.store || store;
  const session = db.getActorSession(id);
  if (!session) return null;
  const closed = db.updateActorSession(id, {
    ...closeSession(session, stoppedAt), closeReason: deps.closeReason || 'stop',
  });
  if (!closed.metered) {
    (deps.recordActorUsage || recordActorUsage)(closed, deps);
    return db.updateActorSession(id, { metered: true });
  }
  return closed;
}

function monitorActorSession(input, {
  now = Date.now, heartbeatMs = 15000, metrics, ...deps
} = {}) {
  const session = startActorSession({ ...input, startedAt: input.startedAt ?? now() }, deps);
  const emit = (value) => { void metrics?.emit(value, now()); };
  emit(session);
  const timer = setInterval(() => {
    try { emit(heartbeatActorSession(session.id, now(), deps)); }
    catch { log.warn('actor_session_heartbeat_failed', { sessionId: session.id }); }
  }, heartbeatMs);
  timer.unref();
  return {
    session,
    stop() {
      clearInterval(timer);
      try {
        const closed = finishActorSession(session.id, now(), deps);
        if (metrics) {
          void metrics.emit(closed, now()).then((accepted) => {
            if (accepted) (deps.store || store).updateActorSession(session.id, { metricsExported: true });
          }).catch(() => log.warn('actor_session_final_metrics_pending', { sessionId: session.id }));
        }
        return closed;
      } catch {
        log.error('actor_session_stop_failed', { sessionId: session.id });
        return null;
      }
    },
  };
}

module.exports = { startActorSession, heartbeatActorSession, finishActorSession, monitorActorSession };
