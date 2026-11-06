'use strict';

/**
 * W3C `traceparent` parsing — one validator for every hop.
 *
 * The header is the only thing that ties a browser request to the gateway, the
 * planner pod, a coder job, the substrate actor, the egress sidecar and the
 * usage row, so every service must accept and re-emit it identically. A parser
 * that is stricter in one hop than another silently ends traces mid-flight,
 * which is exactly the failure that makes an incident unreadable.
 *
 * We only *carry* a traceparent; we never mint one. An id that no span was ever
 * recorded against is worse than none, because it looks like a broken trace.
 * Span creation stays with the OpenTelemetry/Langfuse bootstrap
 * (`packages/shared/src/agent/langfuse.js`).
 */

const TRACEPARENT_HEADER = 'traceparent';
// version "-" trace-id "-" span-id "-" flags, all lowercase hex, 55 chars.
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

/**
 * Return the canonical (lowercased) traceparent, or '' for anything unusable:
 * a malformed string, an all-zero trace/span id (the spec's "invalid" values),
 * or a version other than `00` whose extra fields we must not re-serialize.
 * A `255` version is explicitly invalid per spec, so only `00` passes.
 */
function cleanTraceparent(value) {
  if (typeof value !== 'string') return '';
  const match = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!match) return '';
  const [, version, traceId, spanId] = match;
  if (version !== '00') return '';
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return '';
  return match[0];
}

/** The trace id alone — the key that joins a log line to a Langfuse trace. */
function traceIdOf(traceparent) {
  const clean = cleanTraceparent(traceparent);
  return clean ? clean.slice(3, 35) : '';
}

/**
 * Read the ambient traceparent a job was launched with. `TRACEPARENT_INBOUND`
 * is the value this platform sets deliberately on a Cloud Run job; the bare
 * `TRACEPARENT` is what OpenTelemetry auto-instrumentation would set, so it is
 * the fallback rather than the preference — the fleet's own value is the one
 * that names the request the user made.
 */
function traceparentFromEnv(env = process.env) {
  return cleanTraceparent(env.TRACEPARENT_INBOUND) || cleanTraceparent(env.TRACEPARENT);
}

module.exports = {
  TRACEPARENT_HEADER,
  cleanTraceparent,
  traceIdOf,
  traceparentFromEnv,
};
