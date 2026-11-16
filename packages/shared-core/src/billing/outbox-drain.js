'use strict';

const log = require('../logger');
const { CONFIG } = require('../config');
const outbox = require('./billing-outbox');
const { createFlexpriceClient, rowsOf } = require('./flexprice-client');

/**
 * The outbox drain: the only code that reports usage to FlexPrice, running on the
 * billing tick rather than inline with a run.
 *
 * Two halves, and the second is what makes the first worth trusting.
 *
 *  1. DELIVER — `POST /v1/events/bulk` with the pending rows. A 202 is an
 *     acknowledgement, not a receipt: the spike measured that a Kafka publish
 *     failure is swallowed, that an event naming no meter is stored and
 *     contributes nothing silently, and that a misspelled aggregation property
 *     does the same. So delivery moves a row to `sent` and nothing more.
 *  2. READ BACK — `POST /v1/events/usage/meter` over the window the rows cover,
 *     per org and meter. Only when FlexPrice's number equals the number we sent
 *     does a row become `verified`, which is the only claim about delivery worth
 *     logging.
 *
 * The check is per (org, meter) window rather than per row because that is the
 * only question the route answers: it returns one SUM over a window, so a
 * row-by-row read would compare a total against a part and report the difference
 * as a failure. Rows already `verified` inside the window count on the expected
 * side, which keeps the identity stable when one hour drains across two passes.
 *
 * Delivery stops at the first refusal on purpose. If the ingest plane is not
 * taking our events, the remaining batches will not be taken either, and walking
 * them turns a billing outage into self-inflicted load.
 */

const BATCH_LIMIT = 1000;
const MAX_BATCHES_PER_TICK = 5;

// A row in `sent` for longer than this is undelivered-as-far-as-we-know, which is
// a reportable condition rather than a retryable one: re-sending it is a no-op
// upstream (first-wins on `event_id`), so nothing else will ever notice. Six
// ticks at the 5-minute cadence — enough passes that a transient ingest lag has
// resolved itself.
const STALE_SENT_MS = 30 * 60 * 1000;

function quantityOf(row) {
  const value = Number(row.quantityPaise ?? row.quantitySeconds ?? row.quantityMinutes ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** `meter name -> meter id`, read once per pass from the provisioned catalog. */
async function resolveMeterIds(client) {
  const byName = new Map();
  for (const meter of rowsOf(await client.listMeters())) {
    if (meter && meter.name && meter.id) byName.set(String(meter.name), String(meter.id));
  }
  return byName;
}

/**
 * Hand every pending row to the ingest plane, oldest first, in bulk-sized
 * batches. Returns how many moved to `sent` and why it stopped.
 */
async function deliver({ client, batchLimit = BATCH_LIMIT, maxBatches = MAX_BATCHES_PER_TICK }) {
  let sent = 0;
  let batches = 0;
  let stopped = null;
  while (batches < maxBatches) {
    const rows = outbox.pending(batchLimit);
    if (!rows.length) break;
    batches += 1;
    try {
      await client.eventsBulk(rows.map((row) => outbox.toEvent(row)));
    } catch (err) {
      stopped = err && err.message ? err.message : String(err);
      for (const row of rows) outbox.markFailed(row, stopped);
      // One line per outage, not one per row: the rows themselves are the
      // record, and after a failed attempt they still say `pending`.
      log.warn('outbox_delivery_failed', {
        rows: rows.length,
        error: stopped.slice(0, 200),
        orgIds: [...new Set(rows.map((r) => r.orgId))].slice(0, 20),
      });
      break;
    }
    for (const row of rows) outbox.markSent(row);
    sent += rows.length;
    if (rows.length < batchLimit) break;
  }
  return { sent, batches, stopped };
}

/**
 * Compare each org+meter window FlexPrice reports against what we believe it
 * should hold, and promote the rows that agree. `value` is `omitempty` on this
 * route, so an absent key reads as zero — which is precisely the signature of
 * events stored under an `event_name` no meter aggregates.
 */
async function verify({ client, meterIds, nowIso }) {
  const pendingProof = outbox.sent(BATCH_LIMIT * MAX_BATCHES_PER_TICK);
  const groups = new Map();
  for (const row of pendingProof) {
    const key = `${row.orgId}|${row.meter}`;
    if (!groups.has(key)) groups.set(key, { orgId: row.orgId, meter: row.meter, rows: [] });
    groups.get(key).rows.push(row);
  }

  const verified = [];
  const drift = [];
  for (const group of groups.values()) {
    const meterId = meterIds.get(group.meter);
    if (!meterId) {
      // Nothing can prove this group: the catalog is missing the meter the rows
      // name. Loud, because the alternative is rows that stay `sent` forever.
      log.warn('outbox_meter_unresolved', { orgId: group.orgId, meter: group.meter, rows: group.rows.length });
      drift.push({ orgId: group.orgId, meter: group.meter, reason: 'meter_unresolved', rows: group.rows.length });
      continue;
    }
    const occurred = (r) => String(r.occurredAt || r.createdAt);
    const from = group.rows.map(occurred).sort()[0];
    // Verified rows in the same window belong to FlexPrice's total too, so the
    // comparison is against everything we have ever said happened here.
    const inWindow = outbox.rowsInWindow({
      orgId: group.orgId,
      meter: group.meter,
      fromIso: from,
      toIso: nowIso,
      statuses: ['sent', 'verified'],
    });
    const expected = inWindow.reduce((sum, r) => sum + quantityOf(r), 0);
    let observed;
    try {
      const out = await client.eventsUsageMeter({
        meter_id: meterId,
        external_customer_id: group.orgId,
        start_time: from,
        end_time: nowIso,
      });
      observed = Number(out && out.value !== undefined ? out.value : 0);
    } catch (err) {
      log.warn('outbox_readback_failed', {
        orgId: group.orgId,
        meter: group.meter,
        error: (err && err.message ? err.message : String(err)).slice(0, 200),
      });
      continue;
    }
    if (observed !== expected) {
      // The rows stay `sent`: they were delivered, but delivery is not proved,
      // and a number we cannot account for must never be recorded as accounted
      // for. The reconciler turns this window-scale disagreement into an alert.
      log.warn('outbox_readback_mismatch', {
        orgId: group.orgId,
        meter: group.meter,
        expected,
        observed,
        delta: observed - expected,
        rows: group.rows.length,
        windowStart: from,
      });
      drift.push({ orgId: group.orgId, meter: group.meter, expected, observed, rows: group.rows.length });
      continue;
    }
    for (const row of group.rows) {
      outbox.markVerified(row);
      verified.push(row);
    }
  }
  return { verified: verified.length, groups: groups.size, drift };
}

/**
 * Rows acknowledged but never proved. This is the standing drift alarm: the
 * read-back either promotes a row or complains on its own window, and a row that
 * has waited past the threshold without either means the complaint itself is not
 * reaching anyone.
 */
function staleSent(nowMs = Date.now(), thresholdMs = STALE_SENT_MS) {
  return outbox.sent(BATCH_LIMIT * MAX_BATCHES_PER_TICK).filter((row) => {
    const at = Date.parse(String(row.sentAt || row.createdAt || ''));
    return Number.isFinite(at) && nowMs - at > thresholdMs;
  });
}

/**
 * One drain pass, called from the billing tick. Never throws: a tick that fails
 * because FlexPrice is unreachable must not be reported as a failed scheduler
 * invocation, and the rows still describe exactly what is undelivered.
 */
async function drainOnce(deps = {}) {
  if (!outbox.isEnabled(deps)) return { skipped: 'disabled' };
  const startedAt = Date.now();
  const nowIso = deps.now || new Date().toISOString();
  const client = deps.client
    || createFlexpriceClient({ config: deps.flexpriceConfig || CONFIG.FLEXPRICE });
  const before = outbox.counts();
  let meterIds = new Map();
  try {
    meterIds = deps.meterIds || await resolveMeterIds(client);
  } catch (err) {
    log.warn(`outbox: meters could not be listed, nothing was verified: ${err && err.message}`, {
      error: (err && err.message ? err.message : String(err)).slice(0, 200),
    });
  }
  const delivery = await deliver({ client, batchLimit: deps.batchLimit, maxBatches: deps.maxBatches });
  // Verified unconditionally: a pass that could not list the catalog still has
  // rows sitting in `sent` with nothing proving them, and saying so is the whole
  // point of the read-back. Skipping it here would be the silent freeze.
  const proof = await verify({ client, meterIds, nowIso });
  const stale = staleSent(Date.parse(nowIso) || Date.now(), deps.staleSentMs);
  if (stale.length) {
    log.error('outbox_unverified_stale', {
      rows: stale.length,
      orgIds: [...new Set(stale.map((r) => r.orgId))].slice(0, 20),
      meters: [...new Set(stale.map((r) => r.meter))],
      oldestSentAt: stale.map((r) => String(r.sentAt || r.createdAt)).sort()[0],
      thresholdMs: deps.staleSentMs === undefined ? STALE_SENT_MS : deps.staleSentMs,
    });
  }
  const pruned = outbox.prune(deps.pruneBefore || retentionCutoff());
  const summary = {
    delivered: delivery.sent,
    batches: delivery.batches,
    stopped: delivery.stopped,
    verified: proof.verified,
    drift: proof.drift,
    stale: stale.length,
    pruned,
    remaining: outbox.counts(),
    before,
    elapsedMs: Date.now() - startedAt,
  };
  log.info('outbox_drained', {
    delivered: summary.delivered,
    verified: summary.verified,
    pending: summary.remaining.pending,
    sent: summary.remaining.sent,
    failed: summary.remaining.failed,
    driftGroups: summary.drift.length,
    elapsedMs: summary.elapsedMs,
  });
  return summary;
}

/** Terminal rows go on the same window as the usage records they came from. */
function retentionCutoff() {
  const days = Number(CONFIG.BILLING.usageRetentionDays) || 90;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

module.exports = {
  BATCH_LIMIT,
  MAX_BATCHES_PER_TICK,
  quantityOf,
  resolveMeterIds,
  deliver,
  verify,
  drainOnce,
  staleSent,
  retentionCutoff,
};
