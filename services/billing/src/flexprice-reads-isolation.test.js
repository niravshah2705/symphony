'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolated store before config is read, and FlexPrice ON: `guard()` short-circuits
// with zero calls when it is off, which would make every "no calls happened"
// assertion here true for the wrong reason.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flexprice-isolation-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
process.env.FLEXPRICE_ENABLED = 'true';
delete process.env.BILLING_GATE_POLICY;
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const express = require('express');
const store = require('@software-factory/shared-core/store');
const gate = require('@software-factory/shared-core/billing/gate');
const { SHARED_ORG_ID } = require('@software-factory/shared-core/billing/org-context');
const {
  createFlexpriceReadsRouter, scopeViolationOf, parseFilters, partition, DIMENSIONS,
} = require('./flexprice-reads');

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const ROUTES = ['/overview', '/heatmap', '/trend', '/usage-breakdown', '/log'];

/**
 * A FlexPrice that is a tenant, not a fixture: each org is a customer with its own
 * wallet, its own credit rows and its own usage, so a value in a response is proof
 * of which org the read actually addressed. Every id is derived from the org, the
 * same way `wallet-scope` derives it — a fake that answered one shared wallet for
 * two customers would hide exactly the bug this suite looks for.
 */
function tenantFlexprice(overrides = {}) {
  const calls = [];
  const orgOfWallet = new Map();
  const walletFor = (orgId) => (overrides.walletFor ? overrides.walletFor(orgId) : `wal_${orgId}`);
  for (const [orgId, wallets] of Object.entries(overrides.owned || {})) {
    for (const id of wallets) orgOfWallet.set(id, orgId);
  }

  const client = {
    calls,
    walletFor,
    getCustomerByExternalId: async (externalId) => {
      calls.push({ name: 'getCustomerByExternalId', arg: externalId });
      return { id: `cus_${externalId}`, externalId: externalId };
    },
    listWalletsByCustomer: async (customerId) => {
      calls.push({ name: 'listWalletsByCustomer', arg: customerId });
      const orgId = customerId.replace(/^cus_/, '');
      const ids = (overrides.owned && overrides.owned[orgId]) || [walletFor(orgId)];
      return { items: ids.map((id) => ({ id, currency: 'INR', walletType: 'PRE_PAID' })) };
    },
    walletRealTimeBalance: async (walletId) => {
      calls.push({ name: 'walletRealTimeBalance', arg: walletId });
      return { realTimeCreditBalance: String(creditsOfWallet(walletId)), unpaidInvoicesAmount: '0' };
    },
    walletTransactionsSearch: async (query) => {
      calls.push({ name: 'walletTransactionsSearch', arg: query });
      const orgId = String(query.id).replace(/^wal_/, '');
      return { items: overrides.transactions ? overrides.transactions(orgId) : [] };
    },
    eventsUsage: async (query) => {
      calls.push({ name: 'eventsUsage', arg: query });
      const orgId = query.externalCustomerId;
      return {
        results: [{
          windowSize: '2026-11-20T00:00:00.000Z',
          value: overrides.usage ? overrides.usage(orgId) : 100,
        }],
        type: 'SUM',
      };
    },
  };
  return client;

  function creditsOfWallet(walletId) {
    if (!overrides.balance) return 500;
    return typeof overrides.balance === 'function' ? overrides.balance(walletId) : overrides.balance;
  }
}

/**
 * One router, many callers. `resolveCallerOrg` is what `trusted-caller.js` feeds
 * the routes in production; here the caller is selected by `x-test-caller`, which
 * stands for whatever that middleware decided — the routes themselves are unchanged.
 */
async function mount({ client, callers, ttlMs }, run) {
  const router = createFlexpriceReadsRouter({
    resolveCallerOrg: (req) => {
      const key = String(req.headers['x-test-caller'] || '').trim();
      const caller = callers[key];
      if (!caller) throw new Error(`no caller fixture named '${key}'`);
      return caller;
    },
    deps: { client, now: () => NOW, ...(ttlMs === undefined ? {} : { ttlMs }) },
  });
  const app = express();
  app.use('/r', router);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/r`;
  try {
    return await run({
      router,
      get: async (who, path) => {
        const res = await fetch(`${base}${path}`, { headers: { 'x-test-caller': who } });
        assert.equal(res.status, 200, 'a read answers 200 even when it refuses to read');
        return res.json();
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const trusted = (orgId) => ({ orgId, isAdmin: true, userId: 'u1', trusted: true });
const untrusted = (orgId) => ({ orgId, isAdmin: false, userId: null, trusted: false });

const ofName = (client, name) => client.calls.filter((c) => c.name === name);
const walletOf = (orgId) => `wal_${orgId}`;

test.beforeEach(() => gate.invalidate(null));

test('a caller that proved nothing gets a degraded answer and costs zero FlexPrice reads', async () => {
  const orgA = 'org-iso-a';
  const client = tenantFlexprice();
  store.upsertBillingAccount(orgA, { flexprice: { walletId: client.walletFor(orgA) } });

  await mount({ client, callers: { victim: untrusted(orgA) } }, async ({ get }) => {
    for (const route of ROUTES) {
      const body = await get('victim', route);
      assert.equal(body.degraded, true, `${route} answered with data`);
      assert.equal(body.reason, 'unscoped_caller', `${route} named the wrong reason`);
      assert.match(body.note, /no organization's usage was read/);
      // The org it was *asked* for never appears as a resolved money figure.
      assert.equal(body.isAdmin, false);
      if (route === '/overview') assert.equal(body.balance.credits, null);
      if (route === '/log') assert.deepEqual(body.rows, []);
      if (route === '/heatmap') assert.deepEqual(body.days, []);
    }
    assert.deepEqual(client.calls, [], 'the endpoint refused before the network, not after the response');
  });
});

test('a trusted caller naming an org id that is not an id is refused too', async () => {
  const client = tenantFlexprice();
  const forged = ['a|overview', 'org/../x', 'org%20a', ' ', ''.padEnd(200, 'o')];
  const callers = {};
  forged.forEach((orgId, i) => { callers[`f${i}`] = trusted(orgId); });
  callers.ok = trusted('org-iso-ok');

  await mount({ client, callers }, async ({ get }) => {
    for (let i = 0; i < forged.length; i += 1) {
      const body = await get(`f${i}`, '/overview');
      assert.equal(body.reason, 'unscoped_org_id', `'${forged[i]}' is not an org id shape`);
      assert.equal(body.degraded, true);
    }
    assert.deepEqual(client.calls, []);
    // The one legal id in the same batch still works — the rule is a shape check,
    // not a refusal to serve.
    assert.equal((await get('ok', '/overview')).degraded, false);
    assert.ok(client.calls.length > 0);
  });

  for (const orgId of forged) assert.equal(scopeViolationOf(trusted(orgId)), 'unscoped_org_id');
  assert.equal(scopeViolationOf(untrusted('org-iso-a')), 'unscoped_caller');
  assert.equal(scopeViolationOf(trusted('org-iso-a')), null);
});

test('every upstream call a trusted request makes carries that org’s selector', async () => {
  const orgA = 'org-iso-full';
  const orgB = 'org-iso-other';
  const client = tenantFlexprice({ owned: { [orgA]: [walletOf(orgA)], [orgB]: [walletOf(orgB)] } });
  store.upsertBillingAccount(orgA, { flexprice: { walletId: walletOf(orgA) } });
  store.addUsageRecord({ orgId: orgA, projectId: 'proj-1', tier: 'pro', costPaise: 500, createdAt: new Date(NOW).toISOString() });

  await mount({ client, callers: { a: trusted(orgA) } }, async ({ get }) => {
    for (const route of ROUTES) assert.equal((await get('a', route)).degraded, false, route);
    assert.ok(client.calls.length > 4, 'the routes made real reads, not cached no-ops');

    const strays = client.calls.filter(({ name, arg }) => {
      switch (name) {
        case 'getCustomerByExternalId': return arg !== orgA;
        case 'listWalletsByCustomer': return arg !== `cus_${orgA}`;
        case 'walletRealTimeBalance': return arg !== walletOf(orgA);
        case 'walletTransactionsSearch': return !arg || arg.id !== walletOf(orgA);
        case 'eventsUsage': return !arg || arg.externalCustomerId !== orgA;
        default: return true; // an unlisted read is a read nobody scoped
      }
    });
    assert.deepEqual(strays, [], 'a call without this org in it is a call about somebody else');
    // The fan-out is the risky one: N reads, each a chance to drop the selector.
    assert.ok(ofName(client, 'eventsUsage').length >= 2, 'usage-breakdown fanned out as designed');
  });
});

test('a stored wallet that belongs to another org reads nothing of theirs and shows no numbers', async () => {
  const orgA = 'org-iso-victim';
  const orgB = 'org-iso-foreign';
  const walletB = walletOf(orgB);
  const client = tenantFlexprice({
    owned: { [orgA]: [], [orgB]: [walletB] },
    balance: (walletId) => (walletId === walletB ? 9_999_999 : 500),
  });
  // The mis-provisioned record: a real wallet id, somebody else's.
  store.upsertBillingAccount(orgA, { flexprice: { walletId: walletB } });
  gate.invalidate(orgA);

  await mount({ client, callers: { a: trusted(orgA) } }, async ({ get }) => {
    // The two routes that read the wallet fail closed: a balance and a ledger are
    // only meaningful for a wallet this org owns.
    for (const route of ['/overview', '/log']) {
      const body = await get('a', route);
      assert.equal(body.degraded, true, `${route} served a balance`);
      assert.equal(body.reason, 'wallet_org_mismatch', `${route} called the failure something else`);
      if (route === '/overview') assert.equal(body.balance.credits, null, 'org B money never prints under A');
      if (route === '/log') assert.deepEqual(body.rows, []);
    }
    // The three usage routes never name a wallet, so a wrong wallet id cannot reach
    // them — they are scoped by `external_customer_id`, which the server derives.
    // They answer A's own numbers, and the point of asserting it is that they answer
    // *only* A's: no call in this whole exchange addresses org B in any form.
    for (const route of ['/heatmap', '/trend', '/usage-breakdown']) {
      assert.equal((await get('a', route)).degraded, false, `${route} needlessly degraded`);
    }
    assert.ok(ofName(client, 'eventsUsage').every((c) => c.arg.externalCustomerId === orgA));
    assert.ok(ofName(client, 'getCustomerByExternalId').every((c) => c.arg === orgA));
    assert.ok(ofName(client, 'listWalletsByCustomer').every((c) => c.arg === `cus_${orgA}`));
    // Reading B's wallet was refused; so was reading B's balance or ledger at all.
    assert.deepEqual(ofName(client, 'walletRealTimeBalance'), []);
    assert.deepEqual(ofName(client, 'walletTransactionsSearch'), []);
    assert.equal(client.calls.some((c) => JSON.stringify(c.arg).includes(orgB)), false,
      'org B appears nowhere in the requests this org made');
  });
});

test('a mismatch is not answered from the cache either, and a good org is unaffected', async () => {
  const orgGood = 'org-iso-good';
  const orgBad = 'org-iso-bad-after-good';
  const client = tenantFlexprice({ owned: { [orgGood]: [walletOf(orgGood)] } });
  store.upsertBillingAccount(orgGood, { flexprice: { walletId: walletOf(orgGood) } });

  await mount({ client, callers: { good: trusted(orgGood), bad: trusted(orgBad) } }, async ({ get }) => {
    const first = await get('good', '/overview');
    assert.equal(first.degraded, false);
    const held = first.balance.credits;

    // Now the same router serves an org whose record points at a foreign wallet.
    store.upsertBillingAccount(orgBad, { flexprice: { walletId: walletOf(orgGood) } });
    gate.invalidate(orgBad);
    const bad = await get('bad', '/overview');
    assert.equal(bad.reason, 'wallet_org_mismatch');
    assert.equal(bad.degraded, true);
    assert.ok(!('stale' in bad) || bad.stale !== true, 'no last-known-view fallback across a scope failure');
    assert.notEqual(bad.orgId, undefined);

    // The org that is fine stays fine — the failure is scoped to the caller, not
    // to the shared client.
    assert.equal((await get('good', '/overview')).balance.credits, held);
  });
});

test('two orgs on one router never see each other’s numbers, and invalidating one leaves the other', async () => {
  const orgA = 'org-iso-cache-a';
  const orgB = 'org-iso-cache-b';
  const client = tenantFlexprice({
    owned: { [orgA]: [walletOf(orgA)], [orgB]: [walletOf(orgB)] },
    balance: (walletId) => (walletId === walletOf(orgA) ? 11 : 222),
    usage: (orgId) => (orgId === orgA ? 1000 : 20000),
  });
  store.upsertBillingAccount(orgA, { flexprice: { walletId: walletOf(orgA) } });
  store.upsertBillingAccount(orgB, { flexprice: { walletId: walletOf(orgB) } });

  await mount({ client, callers: { a: trusted(orgA), b: trusted(orgB) } }, async ({ get, router }) => {
    const bodies = {};
    for (const who of ['a', 'b']) {
      for (const route of ROUTES) {
        bodies[`${who}${route}`] = await get(who, route);
        assert.equal(bodies[`${who}${route}`].degraded, false, `${who} ${route}`);
      }
    }
    // Interleaved, because the failure this guards is a shared cache partition:
    // every figure must still belong to the org that asked.
    assert.equal(bodies['a/overview'].balance.credits, '11.00');
    assert.equal(bodies['b/overview'].balance.credits, '222.00');
    assert.equal(bodies['a/trend'].total.credits, '10.00');
    assert.equal(bodies['b/trend'].total.credits, '200.00');
    assert.equal(bodies['a/heatmap'].total.credits, '10.00');
    assert.equal(bodies['b/heatmap'].total.credits, '200.00');

    // A forgeable partition prefix is the other half: hashing means `a|overview`
    // cannot be made to collide with `a`.
    assert.notEqual(partition(orgA), partition(`${orgA}|overview`));
    assert.equal(partition(orgA), partition(orgA), 'and the segment is stable across requests');

    // A settle for A clears A's cached views, and B's keep serving from cache.
    // Measured on /heatmap rather than /overview: the overview re-reads the wallet
    // on every call by design, so it cannot show a cache being hit.
    const bUsage = () => ofName(client, 'eventsUsage')
      .filter((c) => c.arg.externalCustomerId === orgB).length;
    const before = bUsage();
    router.invalidate(orgA);
    assert.equal((await get('a', '/heatmap')).total.credits, '10.00');
    assert.equal(bUsage(), before, 'A’s settle re-read A, and never touched B’s partition');
    assert.equal((await get('b', '/heatmap')).total.credits, '200.00');
    assert.equal(bUsage(), before, 'B was still served from its own cache');
  });
});

test('the shared free-tier org answers degraded without a customer lookup', async () => {
  const client = tenantFlexprice();
  await mount({ client, callers: { s: trusted(SHARED_ORG_ID) } }, async ({ get }) => {
    for (const route of ROUTES) {
      const body = await get('s', route);
      assert.equal(body.degraded, true, route);
      assert.equal(body.reason, 'not_provisioned', route);
    }
    assert.deepEqual(client.calls, []);
  });
});

test('a browser-named filter can narrow the read, never select a customer', async () => {
  const orgA = 'org-iso-filters';
  const client = tenantFlexprice();
  store.upsertBillingAccount(orgA, { flexprice: { walletId: client.walletFor(orgA) } });
  const payloads = [
    '{"external_customer_id":"org-victim"}',
    'org-victim&external_customer_id=org-victim',
    '$or',
    'proj-1" OR "1"="1',
    encodeURIComponent('wal_org-victim'),
    'a'.repeat(300),
  ];

  await mount({ client, callers: { a: trusted(orgA) } }, async ({ get }) => {
    for (const value of payloads) {
      for (const param of Object.keys(DIMENSIONS)) {
        const body = await get('a', `/trend?${param}=${encodeURIComponent(value)}`);
        const usage = ofName(client, 'eventsUsage').slice(-1)[0].arg;
        // Whatever happened to the value, the selector is still this org and only
        // this org — that is the invariant, and it does not depend on the filter.
        assert.equal(usage.externalCustomerId, orgA, `${param}=${value} moved the selector`);
        const keys = Object.keys(usage.filters || {});
        assert.ok(keys.every((k) => Object.values(DIMENSIONS).includes(k)), `unknown filter key reached FlexPrice: ${keys}`);
        assert.ok(!('external_customer_id' in (usage.filters || {})));
        if (body.ignoredFilters.length) assert.deepEqual(body.filters, {}, 'a refused filter is also not applied');
      }
    }
    // A well-formed value does narrow, and arrives as a single-element list.
    const ok = await get('a', '/trend?project=proj_1&tier=pro');
    assert.deepEqual(ok.filters, { project_id: ['proj_1'], tier: ['pro'] });
    assert.deepEqual(ok.ignoredFilters, []);
    const last = ofName(client, 'eventsUsage').slice(-1)[0].arg;
    assert.deepEqual(last.filters, { project_id: ['proj_1'], tier: ['pro'] });
    assert.equal(last.externalCustomerId, orgA);
  });

  const parsed = parseFilters({ project: 'x'.repeat(200), user: 'ok-1', nope: 'ignored' });
  assert.deepEqual(parsed, { filters: { user_id: ['ok-1'] }, rejected: ['project'] });
});

test('a cold router answers the same degraded shape as a warm one', async () => {
  // The page must never have to guess whether `days`/`rows` is missing or empty:
  // a refusal carries the empty shape, so a client renders "no data" not "no layout".
  const orgA = 'org-iso-cold';
  const client = tenantFlexprice();
  await mount({ client, callers: { a: untrusted(orgA) } }, async ({ get }) => {
    const overview = await get('a', '/overview');
    assert.equal(overview.planCredits, null);
    assert.deepEqual(overview.creditPacks, []);
    assert.deepEqual((await get('a', '/heatmap')).days, []);
    assert.deepEqual((await get('a', '/trend')).points, []);
    assert.deepEqual((await get('a', '/log')).rows, []);
    assert.deepEqual((await get('a', '/usage-breakdown?dimension=project')).values, []);
    assert.equal(overview.asOf, new Date(NOW).toISOString(), 'even a refusal says when it answered');
    assert.equal(client.calls.length, 0);
  });
});
