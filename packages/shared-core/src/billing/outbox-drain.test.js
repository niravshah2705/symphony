'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-drain-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.STORE_BACKEND = 'file';
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const store = require('../store');
const outbox = require('./billing-outbox');
const drain = require('./outbox-drain');

const ON = { enabled: true };
const METERS = [{ id: 'met_llm', name: 'llm-cost', event_name: 'fleet.llm_cost', field: 'cost_paise' }];

/**
 * A stand-in for the ingest plane that reproduces the three measured behaviours
 * the drain exists for: a 202 that proves nothing, first-wins dedup on
 * `event_id`, and a `value` that is `omitempty` so a meter which aggregates
 * nothing reads as a 200 with no key rather than an error.
 */
function makeFlex(over = {}) {
  const table = [];
  const calls = { bulk: [], usage: [], meters: 0 };
  const client = {
    listMeters: async () => {
      calls.meters += 1;
      if (over.noMeters) return [];
      return { items: METERS };
    },
    eventsBulk: async (events) => {
      calls.bulk.push(events);
      if (over.bulkFails) throw Object.assign(new Error('POST /v1/events/bulk -> 503'), { status: 503 });
      for (const event of events) {
        const aggregated = !over.dropEventNames || !over.dropEventNames.includes(event.event_name);
        if (!aggregated) continue;
        if (table.some((e) => e.event_id === event.event_id)) continue;
        table.push(event);
      }
      return { accepted: events.length };
    },
    eventsUsageMeter: async (query) => {
      calls.usage.push(query);
      const meter = METERS.find((m) => m.id === query.meter_id);
      const sum = table
        .filter((e) => e.event_name === meter.event_name
          && e.external_customer_id === query.external_customer_id
          && e.timestamp >= query.start_time && e.timestamp <= query.end_time)
        .reduce((total, e) => total + Number(e.properties[meter.field]), 0);
      return sum === 0 ? {} : { value: String(sum) };
    },
  };
  return { client, calls, table };
}

/**
 * Each test starts from an empty outbox. Without this the suite is one shared
 * store, and a row left in `sent` by an earlier test gets re-checked by every
 * later drain — which is exactly what the drain does in production, and exactly
 * what makes an assertion about "this pass" unreadable here.
 */
function resetOutbox() {
  for (const row of store.listBillingOutboxRows({})) {
    store.updateBillingOutboxRow(row.id, { status: 'verified' });
  }
  store.pruneBillingOutbox(new Date(Date.now() + 60000).toISOString());
}
test.beforeEach(resetOutbox);

function enqueueOne(orgId, runId, quantity, over = {}) {
  return outbox.enqueue({
    kind: 'llmCost',
    orgId,
    runId,
    quantity,
    occurredAt: over.occurredAt || new Date(Date.now() - 60000).toISOString(),
  }, ON);
}

test('delivery moves rows to sent, and the read-back is what moves them to verified', async () => {
  const flex = makeFlex();
  const a = enqueueOne('org-drain-1', 'd1', 400);
  const b = enqueueOne('org-drain-1', 'd2', 600);
  const summary = await drain.drainOnce({ client: flex.client, enabled: true });

  assert.equal(summary.delivered, 2);
  assert.equal(summary.verified, 2);
  assert.deepEqual(summary.drift, []);
  assert.equal(outbox.counts().pending, 0);
  assert.equal(outbox.counts().sent, 0);
  const rows = store.listBillingOutboxRows({ orgId: 'org-drain-1' });
  assert.ok(rows.some((r) => r.id === a.id && r.status === 'verified'));
  assert.ok(rows.some((r) => r.id === b.id && r.status === 'verified'));
});

test('the event carries the delivery key as event_id and the org as its customer', async () => {
  const flex = makeFlex();
  const row = enqueueOne('org-drain-2', 'd3', 250);
  await drain.drainOnce({ client: flex.client, enabled: true });
  const [event] = flex.calls.bulk[0];
  assert.equal(event.event_id, row.idempotencyKey);
  assert.equal(event.external_customer_id, 'org-drain-2');
  assert.deepEqual(event.properties, { cost_paise: 250 });
});

test('the window it reads back starts at the oldest event, not at now', async () => {
  const flex = makeFlex();
  enqueueOne('org-drain-3', 'd4', 100, { occurredAt: '2026-11-12T01:00:00.000Z' });
  await drain.drainOnce({ client: flex.client, enabled: true, now: '2026-11-12T09:00:00.000Z' });
  assert.equal(flex.calls.usage[0].start_time, '2026-11-12T01:00:00.000Z');
  assert.equal(flex.calls.usage[0].end_time, '2026-11-12T09:00:00.000Z');
  assert.equal(flex.calls.usage[0].meter_id, 'met_llm');
});

test('an event no meter aggregates is reported, not quietly accepted', async () => {
  // The silent-freeze case the plan names: FlexPrice stores the event, answers
  // 202, and contributes nothing. Without the read-back the rows would be
  // `sent`, the balance would never move, and nothing would ever complain.
  const flex = makeFlex({ dropEventNames: ['fleet.llm_cost'] });
  const row = enqueueOne('org-drain-4', 'd5', 900);
  const summary = await drain.drainOnce({ client: flex.client, enabled: true });

  assert.equal(summary.delivered, 1);
  assert.equal(summary.verified, 0);
  assert.equal(store.listBillingOutboxRows({ orgId: 'org-drain-4' })
    .find((r) => r.id === row.id).status, 'sent');
  assert.deepEqual(summary.drift[0].expected, 900);
  assert.equal(summary.drift[0].observed, 0);
});

test('a meter missing from the catalog says so instead of reading zero forever', async () => {
  const flex = makeFlex({ noMeters: true });
  enqueueOne('org-drain-5', 'd6', 100);
  const summary = await drain.drainOnce({ client: flex.client, enabled: true });
  assert.equal(summary.delivered, 1);
  assert.equal(summary.verified, 0);
  assert.equal(summary.drift[0].reason, 'meter_unresolved');
  assert.equal(flex.calls.usage.length, 0);
});

test('a refused bulk keeps the rows retryable and stops the pass', async () => {
  const flex = makeFlex({ bulkFails: true });
  const row = enqueueOne('org-drain-6', 'd7', 700);
  const summary = await drain.drainOnce({ client: flex.client, enabled: true });

  assert.equal(summary.delivered, 0);
  assert.equal(summary.stopped.includes('503'), true);
  const after = store.listBillingOutboxRows({ orgId: 'org-drain-6' }).find((r) => r.id === row.id);
  assert.equal(after.status, 'pending', 'an outage is not the run’s fault and not a discard');
  assert.equal(after.attempts, 1);
  assert.match(after.lastError, /503/);
  assert.equal(flex.calls.usage.length, 0, 'nothing was delivered, so there is nothing to read back');
});

test('the pass dies with the first refusal rather than walking every batch', async () => {
  const flex = makeFlex({ bulkFails: true });
  for (let i = 0; i < 5; i += 1) enqueueOne('org-drain-7', `stop${i}`, 10);
  const summary = await drain.drainOnce({
    client: flex.client, enabled: true, batchLimit: 2, maxBatches: 5,
  });
  assert.equal(summary.batches, 1);
  assert.equal(flex.calls.bulk.length, 1);
});

test('batches are bounded, and a backlog drains in more than one batch', async () => {
  const flex = makeFlex();
  for (let i = 0; i < 5; i += 1) enqueueOne('org-drain-8', `b${i}`, 11);
  const summary = await drain.drainOnce({ client: flex.client, enabled: true, batchLimit: 2, maxBatches: 3 });
  assert.equal(summary.delivered, 5);
  assert.equal(summary.batches, 3);
  assert.deepEqual(flex.calls.bulk.map((b) => b.length), [2, 2, 1]);
});

test('a blind retry of a delivered batch cannot double-bill, because the id wins first', async () => {
  const flex = makeFlex();
  const row = enqueueOne('org-drain-9', 'dup', 500);
  await drain.deliver({ client: flex.client });
  // Same row, sent again: what a re-queue after an unclear 500 looks like.
  store.updateBillingOutboxRow(row.id, { status: 'pending' });
  const summary = await drain.drainOnce({ client: flex.client, enabled: true });
  assert.equal(flex.table.length, 1, 'FlexPrice kept one event');
  assert.equal(summary.verified, 1);
  // The proof the retry cost nothing: the meter still reads the single 500.
  assert.equal(Number(flex.table[0].properties.cost_paise), 500);
});

test('rows already verified inside the window count on the expected side', async () => {
  const flex = makeFlex();
  const window = '2026-11-12T01:00:00.000Z';
  enqueueOne('org-drain-10', 'v1', 300, { occurredAt: window });
  await drain.drainOnce({ client: flex.client, enabled: true, now: '2026-11-12T02:00:00.000Z' });
  // A second pass with a later row in the SAME hour: the meter now reads 300 +
  // 200, so the expected side must too, or the fresh row never verifies.
  const second = enqueueOne('org-drain-10', 'v2', 200, { occurredAt: '2026-11-12T01:30:00.000Z' });
  const summary = await drain.drainOnce({ client: flex.client, enabled: true, now: '2026-11-12T02:00:00.000Z' });
  assert.equal(summary.verified, 1);
  assert.equal(store.listBillingOutboxRows({ orgId: 'org-drain-10' })
    .find((r) => r.id === second.id).status, 'verified');
  assert.equal(summary.drift.length, 0);
});

test('one org’s delivery never reads another org’s meter window', async () => {
  const flex = makeFlex();
  enqueueOne('org-drain-11a', 'x1', 400, { occurredAt: '2026-11-12T01:00:00.000Z' });
  enqueueOne('org-drain-11b', 'x2', 500, { occurredAt: '2026-11-12T01:10:00.000Z' });
  const summary = await drain.drainOnce({ client: flex.client, enabled: true, now: '2026-11-12T02:00:00.000Z' });
  assert.equal(summary.verified, 2);
  const customers = flex.calls.usage.map((q) => q.external_customer_id).sort();
  assert.deepEqual(customers, ['org-drain-11a', 'org-drain-11b']);
});

test('with FlexPrice off the drain does nothing at all', async () => {
  const flex = makeFlex();
  const summary = await drain.drainOnce({ client: flex.client, enabled: false });
  assert.deepEqual(summary, { skipped: 'disabled' });
  assert.equal(flex.calls.bulk.length, 0);
});

test('terminal rows go on the retention window, undelivered ones never', async () => {
  const flex = makeFlex();
  const done = enqueueOne('org-drain-12', 'p1', 100);
  await drain.drainOnce({ client: flex.client, enabled: true });
  assert.equal(store.listBillingOutboxRows({ orgId: 'org-drain-12' })
    .find((r) => r.id === done.id).status, 'verified');

  // A row that arrives after that pass, then an ingest that refuses everything:
  // the only thing that can leave is the terminal row.
  const kept = enqueueOne('org-drain-13', 'p2', 200);
  const summary = await drain.drainOnce({
    client: makeFlex({ bulkFails: true }).client,
    enabled: true,
    pruneBefore: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal(summary.pruned, 1);
  assert.ok(!store.listBillingOutboxRows({}).some((r) => r.id === done.id));
  assert.ok(store.listBillingOutboxRows({ orgId: 'org-drain-13' })
    .some((r) => r.id === kept.id && r.status === 'pending'));
});

/**
 * The standing drift alarm. Re-sending a `sent` row buys nothing — the id wins
 * first upstream — so if nothing complains about it, an unaggregated quantity
 * disappears from billing quietly forever.
 */
test('an acknowledged row that never proves becomes an alarm; a proven one ages out', async () => {
  const dropped = makeFlex({ dropEventNames: ['fleet.llm_cost'] });
  const row = enqueueOne('org-stale-1', 's1', 300);
  const first = await drain.drainOnce({ client: dropped.client, enabled: true });
  assert.equal(first.stale, 0, 'a row from this tick is not yet stale');

  const longAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  store.updateBillingOutboxRow(row.id, { sentAt: longAgo });
  assert.deepEqual(drain.staleSent().map((r) => r.id), [row.id]);

  const second = await drain.drainOnce({ client: dropped.client, enabled: true });
  assert.equal(second.stale, 1);
  assert.equal(second.verified, 0);

  // A verified row is terminal: it left the set the alarm reads, so retention
  // prunes it on schedule instead of an alert counting it forever.
  resetOutbox();
  const flex = makeFlex();
  const done = enqueueOne('org-stale-2', 's2', 400);
  await drain.drainOnce({ client: flex.client, enabled: true });
  store.updateBillingOutboxRow(done.id, { sentAt: longAgo });
  assert.equal(drain.staleSent().length, 0);
  assert.equal(store.listBillingOutboxRows({ orgId: 'org-stale-2' })
    .find((r) => r.id === done.id).status, 'verified');
});

test('quantities are read off whichever field the meter uses', () => {
  assert.equal(drain.quantityOf({ quantityPaise: 1200 }), 1200);
  assert.equal(drain.quantityOf({ quantitySeconds: 90 }), 90);
  assert.equal(drain.quantityOf({ quantityMinutes: 5 }), 5);
  assert.equal(drain.quantityOf({}), 0);
  assert.equal(drain.quantityOf({ quantityPaise: 'nonsense' }), 0);
});
