'use strict';

const store = require('../store');
const log = require('../logger');
const { CONFIG } = require('../config');
const { assertPaise } = require('./money-wire');
const { SHARED_ORG_ID } = require('./org-context');

/**
 * The usage outbox: the hand-off between "a run consumed something" and
 * "FlexPrice has been told about it".
 *
 * A quantity is written here at the moment usage is recorded and NOTHING MORE —
 * no network call happens on this path. That is the whole point: a FlexPrice
 * outage, a slow ingest, or a 500 from the bulk endpoint must not turn into run
 * failures, and a run that succeeds while its cost is refused has to leave a
 * record somewhere that says so. `services/billing/src/outbox-drain.js` owns the
 * other half (delivery + read-back), on a tick rather than inline.
 *
 * Idempotency: the row's `idempotencyKey` doubles as FlexPrice's `event_id`, and
 * FlexPrice dedups first-wins on that id. So a blind retry of a batch that
 * partially landed is safe — the duplicates are dropped upstream, not
 * double-billed — and a row that was marked `sent` but never read back stays
 * truthful. The key is therefore part of the row's identity and never rewritten.
 */

// One entry per meter defined by scripts/flexprice-provision.js. `field` is the
// property name the meter aggregates on: a quantity posted under any other name
// is stored, acknowledged with 202, and contributes nothing — silently. So the
// name lives here and nowhere else.
const METERS = Object.freeze({
  llmCost: { meter: 'llm-cost', eventName: 'fleet.llm_cost', field: 'cost_paise', unit: 'paise' },
  actorCompute: {
    meter: 'actor-compute',
    eventName: 'fleet.actor_compute',
    field: 'duration_seconds',
    unit: 'seconds',
  },
  deploymentMinutes: {
    meter: 'deployment-minutes',
    eventName: 'fleet.deployment_minutes',
    field: 'minutes',
    unit: 'minutes',
  },
});

const QUANTITY_FIELD = { paise: 'quantityPaise', seconds: 'quantitySeconds', minutes: 'quantityMinutes' };

// A row that keeps failing stays retryable for this many passes. Twelve drains
// is roughly an hour at the billing tick's cadence; past that the row is
// `failed`, which is an alarm rather than a discard, because a payload FlexPrice
// refused is a bug on our side and the cost it represents is still real.
const FAILED_AFTER_ATTEMPTS = 12;

/**
 * Whether usage is being reported to FlexPrice at all. Off means the outbox
 * stays empty and the drain has nothing to do — the local, unconfigured profile
 * must not accumulate rows that can never be delivered.
 */
function isEnabled(deps = {}) {
  return deps.enabled === undefined ? Boolean(CONFIG.FLEXPRICE.enabled) : Boolean(deps.enabled);
}

/**
 * The delivery key for one quantity.
 *
 * `ev:{org}:{run}:{meter}` is the plan's shape and the right one while a run is
 * metered once per run — a re-metered run then dedups upstream instead of
 * billing twice. But `runId` is best-effort at every call site, and a constant
 * would collapse a whole org's unattributed runs into ONE event: the quantity
 * silently stops accruing and the balance stops moving. With no run id the key
 * therefore falls back to the usage record's own id, which is unique per row.
 */
function eventKey({ orgId, runId, meterName, recordId }) {
  const handle = String(runId || recordId || '').trim();
  if (!handle) return null;
  return `ev:${orgId}:${handle}:${meterName}`;
}

/**
 * Queue one quantity for delivery. Never throws: this runs inside usage
 * metering, and losing an outbox row is a billing alarm, not a reason to fail a
 * run that already happened. Returns the row, or null when skipped.
 */
function enqueue(input = {}, deps = {}) {
  if (!isEnabled(deps)) return null;
  try {
    const spec = METERS[input.kind];
    if (!spec) throw new Error(`unknown meter kind: ${input.kind}`);
    const orgId = String(input.orgId || '').trim();
    if (!orgId || orgId === SHARED_ORG_ID) return null;
    const quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      // Zero is the normal case for a BYOK run (the platform spent nothing); a
      // non-integer or negative is a defect, so only those get the loud path.
      if (quantity !== 0) {
        log.warn('billing_outbox_quantity_rejected', {
          kind: input.kind,
          orgId,
          quantity: input.quantity,
          runId: input.runId || null,
        });
      }
      return null;
    }
    if (spec.unit === 'paise') assertPaise(quantity, 'outbox cost_paise');
    const idempotencyKey = eventKey({
      orgId,
      runId: input.actorSessionId || input.runId,
      meterName: spec.meter,
      recordId: input.recordId,
    });
    if (!idempotencyKey) {
      log.warn('billing_outbox_unattributable', {
        kind: input.kind,
        orgId,
        quantity,
        note: 'no runId and no record id, so this quantity has no delivery key',
      });
      return null;
    }
    return store.addBillingOutboxRow({
      orgId,
      projectId: input.projectId || null,
      userId: input.userId || null,
      runId: input.runId || null,
      recordId: input.recordId || null,
      actorSessionId: input.actorSessionId || null,
      agentId: input.agentId || null,
      tier: input.tier || null,
      meter: spec.meter,
      eventName: spec.eventName,
      [QUANTITY_FIELD[spec.unit]]: quantity,
      idempotencyKey,
      // The event's own clock. A backlog drained an hour late must still meter
      // into the hour it happened, or the drain's read-back over the window
      // disagrees with what was sent.
      occurredAt: input.occurredAt || new Date().toISOString(),
    });
  } catch (err) {
    if (err && err.code === 'billing_outbox_overflow') {
      log.error('billing_outbox_overflow: usage is being recorded faster than it drains', {
        rows: err.rows,
        cap: err.cap,
        kind: input.kind,
        orgId: input.orgId || null,
        runId: input.runId || null,
      });
      return null;
    }
    log.warn(`billing outbox enqueue failed: ${err && err.message ? err.message : err}`, {
      kind: input.kind,
      orgId: input.orgId || null,
    });
    return null;
  }
}

/**
 * The one call site that exists today: an LLM run's platform cost, in whole
 * paise, as computed by pricing.js. `costPaise` is 0 for a run on the org's own
 * key and that is not a billable quantity, so it queues nothing.
 */
function enqueueLlmCost(usageRecord, deps = {}) {
  if (!usageRecord) return null;
  return enqueue({
    kind: 'llmCost',
    orgId: usageRecord.orgId,
    projectId: usageRecord.projectId,
    userId: usageRecord.userId,
    runId: usageRecord.runId,
    recordId: usageRecord.id,
    quantity: Number(usageRecord.costPaise) || 0,
    occurredAt: usageRecord.createdAt,
  }, deps);
}

/** Rows due for delivery, oldest first, capped at FlexPrice's bulk ceiling. */
function pending(limit = 1000) {
  return store.listBillingOutboxRows({ status: 'pending', limit });
}

/**
 * Rows FlexPrice has acknowledged but not confirmed: sent with no read-back yet.
 * These are re-checked, never re-sent blindly, and a row that stays `sent` past
 * the alarm threshold is the drift the reconciler reports.
 */
function sent(limit = 1000) {
  return store.listBillingOutboxRows({ status: 'sent', limit });
}

/**
 * The event body for one row, in the shape `POST /v1/events/bulk` wants.
 * `external_customer_id` is the org id — the same value the customer was
 * provisioned with — so a row can never be delivered to another tenant.
 */
function toEvent(row) {
  const spec = Object.values(METERS).find((m) => m.meter === row.meter);
  if (!spec) throw new Error(`outbox row ${row.id} names an unknown meter: ${row.meter}`);
  const quantity = row[QUANTITY_FIELD[spec.unit]];
  return {
    event_id: row.idempotencyKey,
    event_name: row.eventName,
    external_customer_id: row.orgId,
    timestamp: row.occurredAt || row.createdAt,
    properties: {
      [spec.field]: quantity,
      org_id: row.orgId,
      ...(row.projectId ? { project_id: row.projectId } : {}),
      ...(row.userId ? { user_id: row.userId } : {}),
      ...(row.agentId ? { agent_id: row.agentId } : {}),
      ...(row.tier ? { tier: row.tier } : {}),
    },
    source: 'ai-fleet-outbox',
  };
}

function markSent(row) {
  return store.updateBillingOutboxRow(row.id, {
    status: 'sent',
    attempts: (row.attempts || 0) + 1,
    sentAt: new Date().toISOString(),
  });
}

function markVerified(row) {
  return store.updateBillingOutboxRow(row.id, {
    status: 'verified',
    verifiedAt: new Date().toISOString(),
  });
}

/**
 * A failed row keeps its attempts and the reason, and stays retryable until the
 * ceiling: a 4xx from a bad payload is a bug to fix, not a reason to discard a
 * customer's cost. `failed` is therefore "given up on", and every transition
 * into it is an alarm.
 */
function markFailed(row, reason) {
  const attempts = (row.attempts || 0) + 1;
  const status = attempts >= FAILED_AFTER_ATTEMPTS ? 'failed' : 'pending';
  if (status === 'failed') {
    log.error('billing_outbox_row_dropped', {
      rowId: row.id,
      orgId: row.orgId,
      meter: row.meter,
      attempts,
      quantity: row.quantityPaise ?? row.quantitySeconds ?? row.quantityMinutes,
      lastError: String(reason || 'unknown').slice(0, 200),
      note: 'usage happened and FlexPrice never accepted its quantity; this cost is unaccounted',
    });
  }
  return store.updateBillingOutboxRow(row.id, {
    status,
    attempts,
    lastError: String(reason || 'unknown').slice(0, 400),
  });
}

/**
 * Rows for one org + meter, in the given statuses, whose event time falls in
 * `[fromIso, toIso]`. The drain needs this because FlexPrice answers a meter read
 * as ONE sum over a window: to check it, the expected side has to be every
 * quantity we said happened in that same window, verified rows included.
 */
function rowsInWindow({ orgId, meter, fromIso, toIso, statuses = ['sent', 'verified'] }) {
  return store.listBillingOutboxRows({ orgId }).filter((row) => {
    if (meter && row.meter !== meter) return false;
    if (!statuses.includes(row.status)) return false;
    const at = String(row.occurredAt || row.createdAt || '');
    return at >= fromIso && at <= toIso;
  });
}

/** Counts by status — what the drain logs and the alert reads. */
function counts() {
  return store.billingOutboxCounts();
}

/** Terminal rows older than the retention window. */
function prune(beforeIso) {
  return store.pruneBillingOutbox(beforeIso);
}

module.exports = {
  METERS,
  FAILED_AFTER_ATTEMPTS,
  isEnabled,
  eventKey,
  enqueue,
  enqueueLlmCost,
  pending,
  sent,
  toEvent,
  rowsInWindow,
  markSent,
  markVerified,
  markFailed,
  counts,
  prune,
};
