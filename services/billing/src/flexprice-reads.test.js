'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate the store BEFORE anything reads config, and turn FlexPrice on: these
// routes are only supposed to answer on a deployment that has a wallet to read,
// and `guard()` short-circuits with zero calls when it is off.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flexprice-reads-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.FLEXPRICE_ENABLED = 'true';
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const express = require('express');
const store = require('@software-factory/shared-core/store');
const gate = require('@software-factory/shared-core/billing/gate');
const { SHARED_ORG_ID } = require('@software-factory/shared-core/billing/org-context');
const { createFlexpriceReadsRouter, bucketCreditRows, CREDIT_METER } = require('./flexprice-reads');

const WALLET = 'wallet_test_1';
// A fixed clock keeps "settled day" and the calendar-month presets deterministic.
const NOW = Date.parse('2026-11-20T12:00:00.000Z');

/**
 * A FlexPrice that records what was asked rather than answering from a stack.
 * Every default here is the shape measured in docs/FLEXPRICE_FINDINGS.md.
 */
function fakeFlexprice(overrides = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const record = (name, arg) => {
    calls.push({ name, arg });
    return calls.filter((c) => c.name === name).length;
  };
  const client = {
    calls,
    get maxInFlight() { return maxInFlight; },
    getCustomerByExternalId: async (externalId) => {
      record('getCustomerByExternalId', externalId);
      return overrides.customer === undefined ? { id: 'cus_1' } : overrides.customer;
    },
    listWalletsByCustomer: async (customerId) => {
      record('listWalletsByCustomer', customerId);
      return {
        items: overrides.wallets === undefined
          ? [{ id: WALLET, currency: 'INR', walletType: 'PRE_PAID' }]
          : overrides.wallets,
      };
    },
    walletRealTimeBalance: async (walletId) => {
      record('walletRealTimeBalance', walletId);
      return overrides.balance === undefined
        ? { realTimeCreditBalance: '3760.00', unpaidInvoicesAmount: '0' }
        : overrides.balance;
    },
    walletTransactionsSearch: async (query) => {
      record('walletTransactionsSearch', query);
      return typeof overrides.transactions === 'function'
        ? overrides.transactions(query)
        : { items: overrides.transactions || [] };
    },
    // The only usage read the routes are allowed to make. `results` is what
    // `windowSize: "DAY"` answers with, and a windowed SUM leaves the top-level
    // `value` at zero — which `omitempty` drops — so a fake that returned a scalar
    // would let a per-day bug hide.
    eventsUsage: async (query) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      record('eventsUsage', query);
      try {
        const out = payloadFor(query);
        // A real read is a round trip: without yielding here, every call would
        // finish before the next started and `maxInFlight` could never exceed 1,
        // so the concurrency bound would be untestable.
        await new Promise((resolve) => setImmediate(resolve));
        return out;
      } finally {
        inFlight -= 1;
      }
    },
  };
  return client;

  function payloadFor(query) {
    if (typeof overrides.usage === 'function') return overrides.usage(query);
    if (overrides.usage && overrides.usage.fail) throw new Error('usage read refused');
    if (overrides.usage && overrides.usage.scalarOnly) {
      return { value: overrides.usage.value ?? 5000, eventName: 'fleet.llm_cost', type: 'SUM' };
    }
    if (overrides.usage && overrides.usage.results) return { results: overrides.usage.results };
    return {
      results: windowDays(query).map((iso) => ({
        windowSize: `${iso}T00:00:00.000Z`,
        value: dayOf(iso).getTime() % (7 * 86400000) === 0 ? 700 : 100,
      })),
      eventName: 'fleet.llm_cost',
      type: 'SUM',
    };
  }
}

/** Every UTC day in a `[startTime, endTime)` window, as FlexPrice buckets them. */
function windowDays(query) {
  const out = [];
  const end = Date.parse(query.endTime);
  for (let ms = dayOf(query.startTime).getTime(); ms < end; ms += 86400000) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

const dayOf = (value) => {
  const iso = typeof value === 'number' ? new Date(value).toISOString() : String(value);
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
};
const dayStr = (value) => dayOf(value).toISOString().slice(0, 10);

function serve(router) {
  const app = express();
  app.use('/flexprice', router);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/flexprice`,
      close: () => new Promise((res) => server.close(res)),
    }));
  });
}

/** Mount a router over a fake FlexPrice for one org. */
async function withRoutes({ orgId, client, ttlMs, now = NOW, isAdmin = true, trusted = true, enabled } = {}, run) {
  gate.invalidate(orgId);
  const router = createFlexpriceReadsRouter({
    // `trusted: true` is what `trusted-caller.js` sets once a request has proved it
    // came from the gateway; `flexprice-reads-isolation.test.js` covers the other
    // side of that flag.
    resolveCallerOrg: () => ({ orgId, isAdmin, userId: 'u1', trusted }),
    deps: {
      client,
      now: () => now,
      ...(ttlMs === undefined ? {} : { ttlMs }),
      ...(enabled === undefined ? {} : { flexpriceEnabled: enabled }),
    },
  });
  const server = await serve(router);
  try {
    return await run({
      server,
      router,
      get: async (path) => {
        const res = await fetch(`${server.url}${path}`);
        assert.equal(res.status, 200, `a read always answers 200, even when degraded (${path})`);
        return res.json();
      },
    });
  } finally {
    await server.close();
  }
}

/**
 * A `WalletTransactionResponse`. The money fields are decimal-as-string because
 * FlexPrice sends them that way and the model keeps them so; the timestamps are
 * `Date` objects because that is what the model parses them into — the reads
 * normalise both back to the ISO strings the page and the store use.
 */
const creditRow = (id, reason, { amount, remaining, expiresAt, meta } = {}) => ({
  id,
  transactionReason: reason,
  creditAmount: amount,
  creditsAvailable: remaining,
  createdAt: new Date('2026-11-01T09:00:00.000Z'),
  ...(expiresAt ? { expiryDate: new Date(expiresAt) } : {}),
  ...(meta ? { metadata: meta } : {}),
});

test('overview buckets live credit rows by transaction reason', async () => {
  const orgId = 'org-overview-buckets';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });
  const client = fakeFlexprice({
    transactions: [
      // 5,000 granted, 3,760 left ⇒ 1,240 used ⇒ 24.8% — the mock's plan numbers.
      creditRow('g1', 'FREE_CREDIT_GRANT', { amount: '5000.00', remaining: '3760.00', expiresAt: '2026-12-14T00:00:00.000Z' }),
      creditRow('g2', 'SUBSCRIPTION_CREDIT_GRANT', { amount: '2000.00', remaining: '2000.00', expiresAt: '2026-12-01T00:00:00.000Z' }),
      // An add-on purchase, and a fully consumed one: dropping spent rows would
      // report the plan as smaller every time an org finishes it.
      creditRow('p1', 'PURCHASED_CREDIT_DIRECT', { amount: '2200.00', remaining: '791.00', meta: { fleet_order_id: 'order_org_1', provider: 'cashfree' } }),
      creditRow('p2', 'PURCHASED_CREDIT_DIRECT', { amount: '0.50', remaining: '0' }),
      creditRow('p3', 'PURCHASED_CREDIT_DIRECT', { amount: '1000.00', remaining: '1000.00' }),
      creditRow('x1', 'REFUND', { amount: '10.00', remaining: '10.00' }),
    ],
  });

  await withRoutes({ orgId, client }, async ({ get }) => {
    const body = await get('/overview');
    assert.equal(body.degraded, false);
    assert.equal(body.walletResolved, true);
    // 3760 + 2000 remaining, 7000 granted ⇒ 3240 used.
    assert.equal(body.planCredits.total.credits, '7000.00');
    assert.equal(body.planCredits.remaining.credits, '5760.00');
    assert.equal(body.planCredits.used.credits, '1240.00');
    assert.equal(body.planCredits.pctUsed, 17.7);
    // `resetsOn` is the earliest expiry, which is what the quota label claims.
    assert.equal(body.planCredits.resetsOn, '2026-12-01T00:00:00.000Z');
    assert.equal(body.addOnCredits.total.credits, '3200.50');
    assert.equal(body.addOnCredits.used.credits, '1409.50');
    assert.equal(body.addOnCredits.pctUsed, 44);
    assert.equal(body.addOnCredits.packCount, 2, 'only rows with a remaining balance count as packs');
    assert.equal(body.otherCredits.total.credits, '10.00');
    // The headline balance is the gate's number, never a re-derivation of it.
    assert.equal(body.balance.credits, '3760.00');
    assert.equal(body.fundState, 'available');
    // The recharge order is carried on the row's own metadata, set at settle time.
    assert.equal(body.creditPacks.find((p) => p.id === 'p1').orderId, 'order_org_1');
    // A credit that expires is the only "dedicated package" FlexPrice can name.
    assert.deepEqual(body.packages.map((p) => p.id), ['g2', 'g1'], 'soonest expiry first');
    assert.equal(body.creditPacks[0].expiresAt, '2026-12-14T00:00:00.000Z');
  });
});

test('an empty bucket is zero credit, not an unreadable one', () => {
  const buckets = bucketCreditRows([]);
  assert.equal(buckets.plan.rowCount, 0);
  assert.equal(buckets.plan.total.paise, 0);
  assert.equal(buckets.plan.pctUsed, null, 'no percentage of nothing, but no error either');
  assert.equal(buckets.plan.resetsOn, null);
  assert.deepEqual(buckets.packages, []);
  // A row this code cannot read is reported, never guessed at.
  const unreadable = bucketCreditRows([{ id: 'r1', transactionReason: 'FREE_CREDIT_GRANT' }]);
  assert.equal(unreadable.plan.unreadableRows, 1);
  assert.equal(unreadable.plan.total.paise, 0, 'and it contributes nothing to the totals');
});

test('overview reports a missing wallet as nulls, not as zero credit', async () => {
  const orgId = 'org-overview-no-wallet';
  const client = fakeFlexprice({ customer: { id: 'cus_1' }, wallets: [] });
  await withRoutes({ orgId, client }, async ({ get }) => {
    const body = await get('/overview');
    assert.equal(body.degraded, true);
    assert.equal(body.reason, 'wallet_missing');
    assert.equal(body.walletResolved, false);
    assert.equal(body.planCredits, null);
    assert.equal(body.addOnCredits, null);
    assert.deepEqual(body.creditPacks, []);
    // A customer lookup happened; a transaction search on wallet `undefined` did not.
    assert.equal(client.calls.filter((c) => c.name === 'walletTransactionsSearch').length, 0);
  });
});

test('an unparseable balance is unknown, and unknown is not zero', async () => {
  const orgId = 'org-overview-bad-balance';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });
  await withRoutes({ orgId, client: fakeFlexprice({ balance: { realTimeCreditBalance: 'not-a-number' } }) }, async ({ get }) => {
    const body = await get('/overview');
    assert.equal(body.balance.paise, null);
    assert.equal(body.fundState, 'unknown');
  });
});

test('heatmap is ONE windowed read for 91 cells and clamps the window', async () => {
  const orgId = 'org-heatmap';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });
  const client = fakeFlexprice();
  const usageCalls = () => client.calls.filter((c) => c.name === 'eventsUsage');
  await withRoutes({ orgId, client }, async ({ get }) => {
    const body = await get('/heatmap?weeks=13');
    assert.equal(body.days.length, 91, '13 weeks of cells');
    assert.equal(body.weeks, 13);
    assert.equal(usageCalls().length, 1, 'the grid is one request, not ninety-one');
    assert.equal(body.days[0].date, '2026-08-22');
    assert.equal(body.days[90].date, '2026-11-20');
    // The window covers every cell's full day, and is scoped server-side.
    const arg = usageCalls()[0].arg;
    assert.equal(arg.externalCustomerId, orgId, 'the org is never taken from the request');
    assert.equal(arg.windowSize, 'DAY', 'per-day buckets come from FlexPrice, not from 91 reads');
    assert.equal(arg.timezone, 'UTC', 'a day cell must not straddle two days in the stack’s timezone');
    assert.equal(arg.startTime, '2026-08-22T00:00:00.000Z');
    assert.equal(arg.endTime, '2026-11-21T00:00:00.000Z');
    assert.equal(arg.filters, undefined, 'an unfiltered grid sends no filter object');
    assert.equal(arg.eventName, 'fleet.llm_cost');
    assert.equal(arg.propertyName, 'cost_paise');
    assert.equal(arg.aggregationType, 'SUM');
    // The header number and the grid are the same response, so they cannot differ.
    assert.equal(body.total.paise, body.days.reduce((sum, d) => sum + d.paise, 0));
    assert.equal(body.partial, false);

    const clamped = await get('/heatmap?weeks=999');
    assert.equal(clamped.weeks, 13, 'a bigger window than the page draws is refused, not queued');
    assert.equal((await get('/heatmap?weeks=0')).weeks, 1);
    assert.equal(usageCalls().length, 2, 'the clamped 13-week ask is the window already read, so it costs nothing');
  });
});

test('a window FlexPrice did not bucket is reported, never drawn as an empty grid', async () => {
  const orgId = 'org-heatmap-shapes';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });

  // A scalar with no `results` means the server ignored `windowSize`. Drawing
  // that as 91 zero cells would claim the org used nothing on 90 days.
  await withRoutes({ orgId, client: fakeFlexprice({ usage: { scalarOnly: true, value: 5000 } }) }, async ({ get }) => {
    const body = await get('/heatmap?weeks=13');
    assert.equal(body.degraded, true);
    assert.equal(body.reason, 'read_failed');
    assert.equal(body.days.length, 0);
    assert.equal(body.total.paise, 5000, 'the money is still reported — it just has no days');
  });

  // `results: []` is a real answer: nothing used in this window.
  await withRoutes({ orgId: 'org-heatmap-none', client: fakeFlexprice({ usage: { results: [] } }) }, async ({ get }) => {
    store.upsertBillingAccount('org-heatmap-none', { flexprice: { walletId: WALLET } });
    const body = await get('/heatmap?weeks=1');
    assert.equal(body.degraded, false);
    assert.equal(body.days.length, 7);
    assert.equal(body.days[0].paise, 0);
    assert.equal(body.total.paise, 0);
  });

  // A bucket that will not parse is unreadable, so the sum is null: a partial
  // total is not the period total.
  await withRoutes({
    orgId: 'org-heatmap-badrow',
    client: fakeFlexprice({ usage: { results: [{ windowSize: '2026-11-19T00:00:00.000Z', value: 'not-a-number' }] } }),
  }, async ({ get }) => {
    store.upsertBillingAccount('org-heatmap-badrow', { flexprice: { walletId: WALLET } });
    const body = await get('/heatmap?weeks=1');
    assert.equal(body.partial, true);
    assert.equal(body.unreadableBuckets, 1);
    assert.equal(body.total.paise, null, 'a sum missing a bucket is not the period total');
    assert.equal(body.days.find((d) => d.date === '2026-11-19').paise, 0, 'no bucket landed on that day; the partial flag above is what says why');
  });
});

test('a closed window is read once, so a re-render costs nothing', async () => {
  const orgId = 'org-heatmap-cache';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });
  const client = fakeFlexprice();
  const usageCalls = () => client.calls.filter((c) => c.name === 'eventsUsage').length;
  await withRoutes({ orgId, client }, async ({ get }) => {
    // Ending 8 weeks ago keeps the whole window in the past, where it is history
    // and therefore cacheable.
    const end = dayStr(NOW - 8 * 7 * 86400000 - 86400000);
    const first = await get(`/heatmap?weeks=13&end=${end}`);
    assert.equal(usageCalls(), 1);
    const second = await get(`/heatmap?weeks=13&end=${end}`);
    assert.deepEqual(second.days, first.days);
    assert.equal(usageCalls(), 1, 'the second heatmap re-reads nothing');
    assert.equal(client.calls.filter((c) => c.name === 'getCustomerByExternalId').length, 0, 'the cached account skips the customer lookup');
  });
});

test('trend filters by bare property names and never by a dotted path', async () => {
  const orgId = 'org-trend-filters';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });
  const client = fakeFlexprice();
  await withRoutes({ orgId, client }, async ({ get }) => {
    const body = await get('/trend?range=7d&project=p-1&agent=a-2');
    const usage = client.calls.filter((c) => c.name === 'eventsUsage');
    assert.equal(usage.length, 1, 'one windowed read serves both the cells and the total');
    // A dotted filter matches nothing and `property_filters` silently answers the
    // tenant total (findings §7c): the exact keys are the whole correctness here.
    assert.deepEqual(usage[0].arg.filters, { project_id: ['p-1'], agent_id: ['a-2'] });
    assert.equal(usage[0].arg.propertyName, 'cost_paise');
    assert.equal(usage[0].arg.eventName, 'fleet.llm_cost');
    assert.equal(usage[0].arg.aggregationType, 'SUM');
    assert.equal(usage[0].arg.externalCustomerId, orgId);
    assert.equal(usage[0].arg.windowSize, 'DAY');
    assert.deepEqual(body.filters, { project_id: ['p-1'], agent_id: ['a-2'] });
    assert.deepEqual(body.filterableDimensions, ['project', 'user', 'agent', 'tier']);
    const ignored = await get('/trend?range=7d&model=gpt-5');
    assert.ok(!('model' in ignored.filters), 'events carry no model property, so no model filter exists');
  });

  // A filtered window must never be served from the unfiltered cache: that would
  // print the org total under a project label.
  const shared = fakeFlexprice();
  await withRoutes({ orgId: 'org-trend-cache', client: shared }, async ({ get }) => {
    store.upsertBillingAccount('org-trend-cache', { flexprice: { walletId: WALLET } });
    await get('/trend?range=7d');
    await get('/trend?range=7d&project=p-1');
    assert.equal(shared.calls.filter((c) => c.name === 'eventsUsage').length, 2);
    const second = shared.calls.filter((c) => c.name === 'eventsUsage')[1].arg;
    assert.deepEqual(second.filters, { project_id: ['p-1'] });
  });
});

test('mtd and last-month are calendar months, not sliding windows', async () => {
  const orgId = 'org-trend-months';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });
  await withRoutes({ orgId, client: fakeFlexprice(), now: NOW }, async ({ get }) => {
    const mtd = await get('/trend?range=mtd');
    assert.equal(mtd.window.startUtc, '2026-11-01T00:00:00.000Z');
    assert.equal(mtd.window.endUtc, '2026-12-01T00:00:00.000Z');
    assert.equal(mtd.window.days, 30);
    const last = await get('/trend?range=last-month');
    assert.equal(last.window.startUtc, '2026-10-01T00:00:00.000Z');
    assert.equal(last.window.endUtc, '2026-11-01T00:00:00.000Z');
    assert.equal(last.window.days, 31);
  });
});

test('the trend headline is the sum of the cells it draws', async () => {
  const orgId = 'org-trend-total';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });
  await withRoutes({ orgId, client: fakeFlexprice() }, async ({ get }) => {
    const body = await get('/trend?range=7d');
    assert.equal(body.points.length, 7);
    assert.equal(body.bucketed, true);
    assert.equal(body.total.paise, body.points.reduce((sum, p) => sum + p.paise, 0),
      'one response, so the headline cannot disagree with the chart');
    assert.equal(body.peak.paise, Math.max(...body.points.map((p) => p.paise)));
    assert.equal(body.unreadableBuckets, 0);
  });

  // Un-bucketed: the total survives, the series does not, and the page says so.
  await withRoutes({ orgId: 'org-trend-flat', client: fakeFlexprice({ usage: { scalarOnly: true, value: 900 } }) }, async ({ get }) => {
    store.upsertBillingAccount('org-trend-flat', { flexprice: { walletId: WALLET } });
    const body = await get('/trend?range=7d');
    assert.equal(body.bucketed, false);
    assert.equal(body.points.length, 0);
    assert.equal(body.total.paise, 900);
  });
});

test('usage-breakdown reads one window per value, bounded, and never calls an unreadable value zero', async () => {
  const orgId = 'org-breakdown';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });
  // Our own records decide WHICH values are worth a read; FlexPrice never learns
  // the candidate list, so a model- or gateway-created id cannot appear here.
  const day = '2026-11-19T09:00:00.000Z';
  store.addUsageRecord({ orgId, projectId: 'p-big', costPaise: 900, createdAt: day });
  store.addUsageRecord({ orgId, projectId: 'p-big', costPaise: 100, createdAt: day });
  store.addUsageRecord({ orgId, projectId: 'p-small', costPaise: 5, createdAt: day });
  store.addUsageRecord({ orgId, projectId: 'p-old', costPaise: 9999, createdAt: '2025-01-01T00:00:00.000Z' });
  store.addUsageRecord({ orgId: 'org-other', projectId: 'p-big', costPaise: 7, createdAt: day });

  const client = fakeFlexprice({
    usage: (query) => (query.filters.project_id[0] === 'p-small'
      ? { results: [{ windowSize: '2026-11-19T00:00:00.000Z', value: 'oops' }] }
      : { results: [{ windowSize: '2026-11-19T00:00:00.000Z', value: 1000 }] }),
  });
  await withRoutes({ orgId, client }, async ({ get }) => {
    const body = await get('/usage-breakdown?dimension=project&range=7d');
    assert.equal(body.source, 'fleet_usage_records');
    assert.deepEqual(body.values.map((v) => v.value), ['p-big', 'p-small'], 'ordered by usage, stale id excluded');
    assert.equal(body.values[0].total.paise, 1000);
    assert.equal(body.values[1].unreadable, true, 'an unparseable read is null, not 0');
    assert.equal(body.values[1].total.paise, null);
    const args = client.calls.filter((c) => c.name === 'eventsUsage').map((c) => c.arg);
    assert.equal(args.length, 2, 'one read per value');
    assert.deepEqual(args.map((a) => a.filters).sort((a, b) => String(a.project_id).localeCompare(String(b.project_id))),
      [{ project_id: ['p-big'] }, { project_id: ['p-small'] }]);
    assert.equal(args[0].windowSize, 'DAY');
    assert.equal(args[0].externalCustomerId, orgId);
  });

  // A dimension the events do not carry is refused before any read is spent.
  const strict = fakeFlexprice();
  await withRoutes({ orgId, client: strict }, async ({ get }) => {
    const body = await get('/usage-breakdown?dimension=model');
    assert.equal(body.degraded, true);
    assert.equal(body.reason, 'unknown_dimension');
    assert.equal(strict.calls.filter((c) => c.name === 'eventsUsage').length, 0);
  });
});

test('breakdown fans out at most eight values at a time', async () => {
  const orgId = 'org-breakdown-fan';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });
  const day = '2026-11-19T09:00:00.000Z';
  for (let i = 0; i < 20; i += 1) store.addUsageRecord({ orgId, userId: `u${i}`, costPaise: 100 + i, createdAt: day });
  const client = fakeFlexprice();
  await withRoutes({ orgId, client }, async ({ get }) => {
    const body = await get('/usage-breakdown?dimension=user&range=7d&limit=20');
    assert.equal(body.values.length, 20);
    assert.equal(client.maxInFlight, 8, 'twenty values, eight reads in flight, no more');
    assert.equal(client.calls.filter((c) => c.name === 'eventsUsage').length, 20);
  });
});

test('the log asks debit rows for the used tab and explains why they are sparse', async () => {
  const orgId = 'org-log';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });
  const client = fakeFlexprice({
    transactions: (query) => (query.type === 'debit'
      ? {
        items: [
          // A debit row carries its magnitude in `amount` — there is no
          // `debit_amount` on this route (measured live in phase5-verify).
          { id: 'd1', transactionReason: 'MANUAL_BALANCE_DEBIT', amount: '150.00', createdAt: new Date('2026-11-10T08:00:00.000Z') },
          { id: 'd2', transactionReason: 'CREDIT_EXPIRED', amount: '40.00', creditBalanceAfter: '3610.00', createdAt: new Date('2026-11-11T08:00:00.000Z') },
        ],
        pagination: { total: 3 },
      }
      : { items: [creditRow('c1', 'PURCHASED_CREDIT_DIRECT', { amount: '500.00', remaining: '410.00', meta: { provider: 'cashfree', fleet_order_id: 'order_9' } })] }),
  });
  await withRoutes({ orgId, client }, async ({ get }) => {
    const used = await get('/log?tab=used&limit=12&offset=24');
    const query = client.calls.find((c) => c.name === 'walletTransactionsSearch' && c.arg.type === 'debit').arg;
    assert.deepEqual(query, { id: WALLET, type: 'debit', limit: 12, offset: 24 });
    assert.equal(used.rows[0].amount.credits, '150.00');
    assert.equal(used.rows[0].reasonLabel, 'Platform charge', 'the page never shows the raw enum');
    assert.equal(used.rows[0].kind, 'movement', 'a manual debit is spend-attributed');
    assert.equal(used.rows[0].balanceAfter.paise, null, 'a row with no balance-after field is unknown, never 0');
    assert.equal(used.rows[1].kind, 'adjustment', 'credits expiring are not consumption');
    assert.equal(used.rows[1].reasonLabel, 'Expired credits');
    assert.equal(used.rows[1].balanceAfter.credits, '3610.00', 'the running balance comes from the row, not our arithmetic');
    assert.equal(used.total, 3, 'pagination.total is passed through when FlexPrice supplies it');
    assert.match(used.note, /finalized/, 'an empty used tab must come with the reason why');

    const earned = await get('/log?tab=earned');
    assert.equal(earned.rows[0].amount.credits, '500.00');
    assert.equal(earned.rows[0].remaining.credits, '410.00');
    assert.equal(earned.rows[0].orderId, 'order_9');
    assert.equal(earned.rows[0].kind, 'movement');
    assert.equal(earned.nextOffset, null, 'a short page means the end of the list');
    assert.equal(earned.note, null);
  });
});

test('a failed read answers with the last known view, marked stale', async () => {
  const orgId = 'org-degraded';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });
  let failing = false;
  const client = fakeFlexprice({
    transactions: () => {
      if (failing) throw Object.assign(new Error('flexprice unavailable'), { status: 503 });
      return { items: [creditRow('g1', 'FREE_CREDIT_GRANT', { amount: '5000.00', remaining: '3760.00' })] };
    },
  });
  // A long TTL keeps the first view in the cache across the two requests; without
  // it the second request would be a fresh read rather than a failed one.
  await withRoutes({ orgId, client, ttlMs: 60 * 60 * 1000 }, async ({ get }) => {
    const good = await get('/overview');
    assert.equal(good.degraded, false);
    assert.equal(good.planCredits.remaining.credits, '3760.00');
    failing = true;
    const bad = await get('/overview');
    assert.equal(bad.degraded, true);
    assert.equal(bad.reason, 'read_failed');
    assert.equal(bad.stale, true);
    assert.equal(bad.planCredits.remaining.credits, '3760.00', 'the outage shows the last known numbers');
    assert.notEqual(bad.planCredits.remaining.credits, '0.00');
  });
});

test('a read with no cache at all degrades to nulls rather than 500', async () => {
  const orgId = 'org-degraded-cold';
  store.upsertBillingAccount(orgId, { flexprice: { walletId: WALLET } });
  const client = fakeFlexprice({ usage: { fail: true } });
  await withRoutes({ orgId, client }, async ({ get }) => {
    const body = await get('/heatmap?weeks=1');
    assert.equal(body.degraded, true);
    assert.equal(body.reason, 'read_failed');
    // The read failed outright, so there is no grid and no total — but there is
    // also no ₹0, which the page would read as "this org used nothing".
    assert.deepEqual(body.days, []);
    assert.equal(body.total.paise, null);
    assert.equal(body.total.credits, null);

    const trend = await get('/trend?range=30d');
    assert.equal(trend.degraded, true);
    assert.equal(trend.points.length, 0);
    assert.equal(trend.total.paise, null);
    assert.deepEqual(trend.filters, {}, 'a cold answer still has the shape the page renders');

    const breakdown = await get('/usage-breakdown?dimension=agent');
    assert.deepEqual(breakdown.values, [], 'no records for this org means no candidate values, and no reads spent');
    assert.equal(breakdown.degraded, false, 'an empty picker is not an outage');
    assert.ok(client.calls.filter((c) => c.name === 'eventsUsage').length >= 1, 'the reads that were asked for did fail');
  });
});

test('a disabled stack and the free-tier org cost zero FlexPrice calls', async () => {
  const client = fakeFlexprice({});
  await withRoutes({ orgId: SHARED_ORG_ID, client }, async ({ get }) => {
    const body = await get('/overview');
    assert.equal(body.degraded, true);
    assert.equal(body.reason, 'not_provisioned');
    assert.equal(client.calls.length, 0, 'the free-tier account never reaches the stack');
    assert.equal(body.orgId, SHARED_ORG_ID, 'the route answers for the caller it was given');
  });

  const off = fakeFlexprice({});
  await withRoutes({ orgId: 'org-no-flexprice', client: off, enabled: false }, async ({ get }) => {
    const body = await get('/heatmap?weeks=13');
    assert.equal(body.degraded, true);
    assert.equal(body.reason, 'flexprice_disabled');
    assert.deepEqual(body.days, [], 'a blocked read still answers with the shape the page renders');
    assert.equal(off.calls.length, 0, 'an unconfigured deployment reads nothing');

    // The tab is part of the answer, not only of the query: a degraded log that
    // dropped it would snap the page's selected pill back to "Earned" under a
    // user who had just clicked "Used".
    const used = await get('/log?tab=used&limit=12');
    assert.equal(used.tab, 'used');
    assert.deepEqual(used.rows, []);
    assert.equal(used.total, null);
    assert.equal((await get('/log')).tab, 'earned', 'no tab parameter means the earned tab');
  });
});

test('invalidate drops the cached reads for that org and only that org', async () => {
  const orgId = 'org-invalidate';
  // No stored account, so resolving the wallet is a customer lookup this route caches.
  const client = fakeFlexprice({ transactions: () => ({ items: [] }) });
  const lookups = () => client.calls.filter((c) => c.name === 'getCustomerByExternalId').length;
  await withRoutes({ orgId, client, ttlMs: 60 * 60 * 1000 }, async ({ get, router }) => {
    await get('/log?tab=earned');
    assert.equal(lookups(), 1);
    await get('/log?tab=earned');
    assert.equal(lookups(), 1, 'the wallet lookup is cached, so a page render is one read');
    router.invalidate('some-other-org');
    await get('/log?tab=earned');
    assert.equal(lookups(), 1, 'another org does not clear this one');
    // Without this, a settle would leave the page on the pre-payment numbers for
    // the rest of the TTL — indistinguishable from a payment that did not land.
    router.invalidate(orgId);
    await get('/log?tab=earned');
    assert.equal(lookups(), 2, 'after a settle the wallet is resolved again');
    assert.deepEqual(router.invalidate(''), { cleared: null });
  });
});
