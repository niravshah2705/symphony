'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The real store in a temp dir, as recharge-settle.test.js does it: the outbox's
// whole contract is about what a ROW looks like after two writers and a retry,
// and a mocked store would prove the mock.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-outbox-'));
process.env.SOFTWARE_FACTORY_DATA_DIR = TMP_DIR;
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const store = require('../store');
const log = require('../logger');
const outbox = require('./billing-outbox');

const QUIET = { info() {}, warn() {}, error() {} };
let logged = [];

function withQuietLog(fn) {
  const original = { warn: log.warn, error: log.error };
  logged = [];
  log.warn = (msg, meta) => { logged.push({ level: 'warn', msg, meta }); };
  log.error = (msg, meta) => { logged.push({ level: 'error', msg, meta }); };
  try { return fn(); } finally { Object.assign(log, original); }
}

const ON = { enabled: true };

/** A usage record as `recordUsage` would have persisted it. */
function record(over = {}) {
  return {
    id: `use_${Math.random().toString(36).slice(2, 8)}`,
    orgId: 'org-a',
    projectId: 'proj-1',
    userId: 'user-1',
    runId: 'run-1',
    costTokenCredits: 12345,
    createdAt: '2026-11-12T10:00:00.000Z',
    ...over,
  };
}

test('a recorded cost becomes one pending row, keyed by org + run + meter', () => {
  const before = outbox.counts().total;
  const row = outbox.enqueueLlmCost(record({ runId: 'run-key-1' }), ON);
  assert.equal(row.orgId, 'org-a');
  assert.equal(row.meter, 'llm-token-credits');
  assert.equal(row.eventName, 'fleet.llm_cost');
  assert.equal(row.quantityTokenCredits, 12345);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);
  assert.equal(row.idempotencyKey, 'ev:org-a:run-key-1:llm-token-credits');
  assert.equal(outbox.counts().total, before + 1);
});

test('with FlexPrice off nothing is queued, because an undeliverable row is a lie', () => {
  const before = outbox.counts().total;
  assert.equal(outbox.enqueueLlmCost(record({ runId: 'run-off' }), { enabled: false }), null);
  assert.equal(outbox.counts().total, before);
});

test('a BYOK run costs the platform nothing and therefore queues nothing', () => {
  const before = outbox.counts().total;
  assert.equal(outbox.enqueueLlmCost(record({ runId: 'run-byok', costTokenCredits: 0 }), ON), null);
  assert.equal(outbox.counts().total, before);
});

test('a fractional token-credit quantity is refused loudly rather than rounded onto the wire', () => {
  const before = outbox.counts().total;
  withQuietLog(() => {
    assert.equal(outbox.enqueueLlmCost(record({ runId: 'run-fraction', costTokenCredits: 100.5 }), ON), null);
  });
  assert.equal(outbox.counts().total, before);
  assert.ok(logged.some((l) => l.msg.includes('outbox')), JSON.stringify(logged));
});

test('the shared org is never billed, so it never gets a row', () => {
  assert.equal(outbox.enqueueLlmCost(record({ orgId: '__shared__', runId: 'run-shared' }), ON), null);
});

test('metering the same run twice does not bill it twice', () => {
  const a = outbox.enqueueLlmCost(record({ runId: 'run-dup', costTokenCredits: 500 }), ON);
  const b = outbox.enqueueLlmCost(record({ runId: 'run-dup', costTokenCredits: 500, id: 'use_other' }), ON);
  assert.equal(a.id, b.id);
  assert.equal(outbox.pending(1000).filter((r) => r.runId === 'run-dup').length, 1);
});

test('runs with no runId key on their own record, or they would collapse into one event', () => {
  // This is the failure the fallback exists for: `runId` is best-effort at every
  // call site, and a constant key would let the FIRST unattributed run of an org
  // stand for all of them — the balance would stop moving and nothing would error.
  const one = outbox.enqueueLlmCost(record({ runId: null, id: 'use_a', costTokenCredits: 700 }), ON);
  const two = outbox.enqueueLlmCost(record({ runId: null, id: 'use_b', costTokenCredits: 800 }), ON);
  assert.notEqual(one.id, two.id);
  assert.equal(one.idempotencyKey, 'ev:org-a:use_a:llm-token-credits');
  assert.equal(outbox.pending(1000).filter((r) => r.orgId === 'org-a' && !r.runId).length, 2);
});

test('with neither a run nor a record handle it says so instead of guessing', () => {
  withQuietLog(() => {
    assert.equal(outbox.enqueueLlmCost(record({ runId: null, id: null, costTokenCredits: 900 }), ON), null);
  });
  assert.ok(logged.some((l) => l.msg === 'billing_outbox_unattributable'), JSON.stringify(logged));
});

test('each meter writes its own quantity field, because a wrong name is a silent 202', () => {
  // FlexPrice matches a meter by event_name and aggregates the property named at
  // create time. An event whose property is misspelled is STORED and contributes
  // nothing — no error, no drift signal. So the mapping is asserted, not assumed.
  const llm = outbox.enqueue({ kind: 'llmTokenCredits', orgId: 'org-map', runId: 'r1', quantity: 1200 }, ON);
  const actor = outbox.enqueue({ kind: 'actorCompute', orgId: 'org-map', runId: 'r2', quantity: 90 }, ON);
  const deploy = outbox.enqueue({ kind: 'deploymentMinutes', orgId: 'org-map', runId: 'r3', quantity: 5 }, ON);
  assert.deepEqual(outbox.toEvent(llm).properties, { token_credits: 1200, org_id: 'org-map' });
  assert.deepEqual(outbox.toEvent(actor).properties, { duration_seconds: 90, org_id: 'org-map' });
  assert.deepEqual(outbox.toEvent(deploy).properties, { minutes: 5, org_id: 'org-map' });
  assert.equal(outbox.toEvent(llm).event_name, 'fleet.llm_cost');
  assert.equal(outbox.toEvent(actor).event_name, 'fleet.actor_compute');
});

// The event is the only surviving statement of what a debit was computed FROM: the
// card can be edited and redeployed, the usage record can age out of the retention
// window, and none of it may have to be re-derived. So the property set is asserted
// exactly — a field that goes missing is an audit gap nobody notices, and a field
// that becomes a second aggregated number would become a second money source.
test('an llm event carries its provenance beside the one aggregated field', () => {
  const row = outbox.enqueueLlmCost(record({
    runId: 'run-prov',
    costTokenCredits: 236000,
    usage: { inputTokens: 100000, outputTokens: 20000, cacheReadTokens: 5, cacheWriteTokens: 0 },
    providerCost: '0.6',
    providerCurrency: 'USD',
    fxRateToInr: '87.00',
    inrCost: '2360.00',
  }), ON);
  const ev = outbox.toEvent(row);
  assert.deepEqual(ev.properties, {
    token_credits: 236000,
    input_tokens: 100000,
    output_tokens: 20000,
    cache_read_tokens: 5,
    cache_write_tokens: 0,
    provider_cost: '0.6',
    provider_currency: 'USD',
    fx_rate_to_inr: '87.00',
    inr_cost: '2360.00',
    org_id: 'org-a',
    project_id: 'proj-1',
    user_id: 'user-1',
  }, 'a zero token count is reported as zero: it is a measured answer, not a missing one');
  assert.equal(typeof ev.properties.token_credits, 'number', 'the metered field is the integer');
  assert.equal(typeof ev.properties.inr_cost, 'string', 'a rupee figure is a decimal STRING so it cannot be mistaken for the metered int');
  assert.deepEqual(Object.keys(ev.properties).filter((k) => /[a-z][A-Z]/.test(k)), [],
    'property keys are never camelCased — the meter binds on the exact snake_case name');
});

test('an unattributed provenance field is omitted, never zeroed', () => {
  // Zero says "the provider reports this run was free"; absent says "no provider
  // figure exists" (Codex, Gemini, every local run). The reconciler counts the
  // difference, so collapsing them would silently invent a billed amount of nil.
  const ev = outbox.toEvent(outbox.enqueueLlmCost(record({ runId: 'run-bare', costTokenCredits: 50 }), ON));
  assert.equal('provider_cost' in ev.properties, false);
  assert.equal('inr_cost' in ev.properties, false);
  assert.equal('token_credits' in ev.properties, true);
});

test('an event carries the org id as its customer, and the time it happened', () => {
  const row = outbox.enqueueLlmCost(record({ runId: 'run-event', occurredAt: null }), ON);
  const ev = outbox.toEvent(row);
  assert.equal(ev.event_id, row.idempotencyKey);
  assert.equal(ev.external_customer_id, 'org-a');
  assert.equal(ev.timestamp, '2026-11-12T10:00:00.000Z');
});

test('a backlog drained late still meters into the hour it happened', () => {
  const row = outbox.enqueue({
    kind: 'llmTokenCredits',
    orgId: 'org-a',
    runId: 'run-late',
    quantity: 400,
    occurredAt: '2026-11-12T03:00:00.000Z',
  }, ON);
  assert.equal(outbox.toEvent(row).timestamp, '2026-11-12T03:00:00.000Z');
  assert.notEqual(row.occurredAt, row.createdAt);
});

test('an unknown meter kind is refused, never invented', () => {
  withQuietLog(() => {
    assert.equal(outbox.enqueue({ kind: 'nonsense', orgId: 'org-a', runId: 'r', quantity: 1 }, ON), null);
  });
  assert.ok(logged.length >= 1);
});

test('the quantity and the key of a row are immutable, even to the drain', () => {
  const row = outbox.enqueueLlmCost(record({
    runId: 'run-frozen', costTokenCredits: 111, inrCost: '111.00', providerCost: '0.1',
  }), ON);
  const sent = outbox.markSent(row);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.attempts, 1);
  const tampered = store.updateBillingOutboxRow(row.id, {
    quantityTokenCredits: 999999,
    idempotencyKey: 'ev:org-a:hacked:llm-token-credits',
    orgId: 'org-victim',
    meter: 'actor-compute',
    inrCost: '9999.00',
  });
  assert.equal(tampered.quantityTokenCredits, 111);
  assert.equal(tampered.idempotencyKey, 'ev:org-a:run-frozen:llm-token-credits');
  assert.equal(tampered.orgId, 'org-a');
  assert.equal(tampered.meter, 'llm-token-credits');
  assert.equal(tampered.inrCost, '111.00', 'the audit payload is frozen with the quantity it describes');
});

test('a failing row stays retryable, and only gives up after the ceiling', () => {
  const row = outbox.enqueueLlmCost(record({ runId: 'run-fail', costTokenCredits: 222 }), ON);
  let current = row;
  for (let i = 1; i < outbox.FAILED_AFTER_ATTEMPTS; i += 1) {
    current = outbox.markFailed(current, 'flexprice 503');
    assert.equal(current.status, 'pending', `attempt ${i} must stay retryable`);
  }
  current = outbox.markFailed(current, 'flexprice 503');
  assert.equal(current.status, 'failed');
  assert.match(current.lastError, /503/);
});

test('enqueue never throws at a run that already happened', () => {
  const original = store.addBillingOutboxRow;
  store.addBillingOutboxRow = () => { throw new Error('store is on fire'); };
  try {
    withQuietLog(() => {
      assert.equal(outbox.enqueueLlmCost(record({ runId: 'run-throw' }), ON), null);
    });
  } finally {
    store.addBillingOutboxRow = original;
  }
});

test('an outbox full of undelivered rows alarms instead of dropping a quantity', () => {
  const original = store.addBillingOutboxRow;
  store.addBillingOutboxRow = () => {
    throw Object.assign(new Error('billing outbox is over its cap with undelivered rows'), {
      code: 'billing_outbox_overflow',
      rows: 50001,
      cap: 50000,
    });
  };
  try {
    withQuietLog(() => {
      assert.equal(outbox.enqueueLlmCost(record({ runId: 'run-overflow' }), ON), null);
    });
  } finally {
    store.addBillingOutboxRow = original;
  }
  assert.ok(logged.some((l) => l.level === 'error' && l.msg.includes('overflow')), JSON.stringify(logged));
});

test('pruning clears terminal rows and never touches an undelivered one', () => {
  const kept = outbox.enqueueLlmCost(record({ runId: 'run-keep', costTokenCredits: 333 }), ON);
  const done = outbox.enqueueLlmCost(record({ runId: 'run-done', costTokenCredits: 444 }), ON);
  const sent = outbox.enqueueLlmCost(record({ runId: 'run-sent', costTokenCredits: 555 }), ON);
  outbox.markVerified(outbox.markSent(done));
  outbox.markSent(sent);
  // A cutoff past every row: what goes is decided by status, not by age alone.
  const removed = outbox.prune(new Date(Date.now() + 60000).toISOString());
  assert.ok(removed >= 1, `expected at least one terminal row to go, saw ${removed}`);
  const rows = store.listBillingOutboxRows({});
  assert.ok(rows.some((r) => r.id === kept.id), 'a pending row is never pruned');
  assert.ok(rows.some((r) => r.id === sent.id), 'a sent-but-unverified row is never pruned');
  assert.ok(!rows.some((r) => r.id === done.id));
});

test('rows come back oldest first, so a backlog drains in arrival order', () => {
  const a = outbox.enqueue({ kind: 'llmTokenCredits', orgId: 'org-order', runId: 'o1', quantity: 10 }, ON);
  const b = outbox.enqueue({ kind: 'llmTokenCredits', orgId: 'org-order', runId: 'o2', quantity: 10 }, ON);
  const pending = outbox.pending(1000).filter((r) => r.orgId === 'org-order');
  assert.ok(pending.findIndex((r) => r.id === a.id) < pending.findIndex((r) => r.id === b.id));
});

test('the drain asks for a bounded batch, and the ceiling is honoured', () => {
  for (let i = 0; i < 5; i += 1) {
    outbox.enqueue({ kind: 'llmTokenCredits', orgId: 'org-batch', runId: `b${i}`, quantity: 10 }, ON);
  }
  assert.equal(outbox.pending(3).length, 3);
  assert.equal(outbox.pending(1000).filter((r) => r.orgId === 'org-batch').length, 5);
});
