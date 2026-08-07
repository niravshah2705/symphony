'use strict';

const events = require('../messaging/events');
const store = require('../store');

/**
 * Typed publishers for the GLOBAL workspace channel.
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

/** Publish the current jobs snapshot (matches GET /api/agent/jobs `{ jobs }`). */
function publishJobsSnapshot() {
  try {
    events.publishWorkspace({ type: 'jobs', jobs: store.listJobs(), ts: nowISO() });
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
function publishAgentStatus(status) {
  try {
    events.publishWorkspace({ type: 'agent-status', status, ts: nowISO() });
  } catch (_) {
    /* fire-and-forget */
  }
}

/** Publish a coder monitor status snapshot (matches GET /api/coder). */
function publishCoderStatus(coder) {
  try {
    events.publishWorkspace({ type: 'coder', coder, ts: nowISO() });
  } catch (_) {
    /* fire-and-forget */
  }
}

/** Publish a requirement-gate transition (approve / auto-approve / supersede). */
function publishGate(gateId, status) {
  try {
    events.publishWorkspace({ type: 'gate', gateId, status, ts: nowISO() });
  } catch (_) {
    /* fire-and-forget */
  }
}

module.exports = { publishJobsSnapshot, publishAgentStatus, publishCoderStatus, publishGate };
