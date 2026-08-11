'use strict';

const events = require('../messaging/events');
const store = require('../store');

/**
 * Typed publishers for the selected native workspace channel.
 *
 * These replace the SPA's 5-second polling of GET /api/agent/status,
 * /api/agent/jobs and /api/coder: instead of the browser re-fetching on a timer,
 * the planner and coder services emit a small typed SNAPSHOT event at each
 * mutation point (enqueue / complete / pause, coder in-flight start/stop, gate
 * transitions) and the browser applies it directly.
 *
 * Every publish is best-effort and swallows its own errors — telemetry must
 * never break an agent run (e.g. an uninitialized store or a down http-sink).
 */

function nowISO() {
  return new Date().toISOString();
}

function normalizedContext(context = {}) {
  return events.normalizeEventContext(context);
}

/** Publish the selected context's jobs snapshot (matches GET /api/agent/jobs `{ jobs }`). */
function publishJobsSnapshot(context = {}) {
  try {
    const selected = normalizedContext(context);
    const jobs = store.listJobs().filter((job) => events.matchesEventContext(job, selected));
    events.publishWorkspace({ type: 'jobs', jobs, ts: nowISO() }, selected);
  } catch (_) {
    /* fire-and-forget */
  }
}

/**
 * Publish a planner status snapshot. The caller passes the assembled status so
 * this module stays decoupled from the scheduler/route it is emitted from. The
 * SPA MERGES it onto its seeded status, so a partial (counts + pause + schedule)
 * is enough and never clobbers the model/provider fields from the seed load.
 */
function publishAgentStatus(status, context = {}) {
  try {
    events.publishWorkspace({ type: 'agent-status', status, ts: nowISO() }, normalizedContext(context));
  } catch (_) {
    /* fire-and-forget */
  }
}

/** Publish a coder monitor status snapshot (matches GET /api/coder). */
function publishCoderStatus(coder, context = {}) {
  try {
    events.publishWorkspace({ type: 'coder', coder, ts: nowISO() }, normalizedContext(context));
  } catch (_) {
    /* fire-and-forget */
  }
}

/** Publish a requirement-gate transition (approve / auto-approve / supersede). */
function publishGate(gateId, status, context = {}) {
  try {
    events.publishWorkspace({ type: 'gate', gateId, status, ts: nowISO() }, normalizedContext(context));
  } catch (_) {
    /* fire-and-forget */
  }
}

/**
 * Publish a user-facing notification (e.g. a billing threshold alert) to the
 * browser workspace channel. The SPA renders it as a toast + a native browser
 * Notification (see public/js/notifications.js). Best-effort, like the others.
 */
function publishNotification({ channel = 'general', level = 'info', title = '', message = '', orgId = null } = {}) {
  try {
    events.publishWorkspace(
      { type: 'notification', channel, level, title, message, orgId, ts: nowISO() },
      { organizationId: orgId }
    );
  } catch (_) {
    /* fire-and-forget */
  }
}

module.exports = { publishJobsSnapshot, publishAgentStatus, publishCoderStatus, publishGate, publishNotification };
