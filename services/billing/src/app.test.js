'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const store = require('@ai-fleet/shared-core/store');
const { createApp } = require('./app');

const ORG = 'org-test-svc';
const ADMIN = { 'x-ai-fleet-billing-org-id': ORG, 'x-ai-fleet-billing-org-role': 'ORG_ADMIN' };
const MEMBER = { 'x-ai-fleet-billing-org-id': ORG, 'x-ai-fleet-billing-org-role': 'ORG_MEMBER' };

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

test('billing service health probes', async () => {
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/healthz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).service, 'billing');
  } finally {
    await server.close();
  }
});

test('billing standalone UI dashboard serves HTML', async () => {
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /AI Fleet · Billing Control Center/);
  } finally {
    await server.close();
  }
});

// The Firestore store backend throws on any read until initStore() has hydrated
// its mirror, and billing's records are read synchronously inside the handlers —
// so hydration must happen ahead of them. Unhydrated reads are what blanked the
// Cost screen in production.
test('billing routes hydrate the store before reading it; probes do not', async () => {
  const calls = [];
  const server = await listen(createApp({ initStore: async () => { calls.push('init'); } }));
  try {
    await fetch(`${server.url}/healthz`);
    assert.deepEqual(calls, [], 'readiness probes must not depend on the store');

    const summary = await fetch(`${server.url}/api/billing/summary`, { headers: ADMIN });
    assert.equal(summary.status, 200);
    assert.deepEqual(calls, ['init']);

    await fetch(`${server.url}/`);
    assert.equal(calls.length, 2, 'the dashboard reads the store too');
  } finally {
    await server.close();
  }
});

test('a store that will not hydrate fails closed instead of reading stale state', async () => {
  const server = await listen(createApp({
    initStore: async () => { throw new Error('firestore unavailable'); },
  }));
  try {
    const res = await fetch(`${server.url}/api/billing/summary`, { headers: ADMIN });
    assert.equal(res.status, 500);
  } finally {
    await server.close();
  }
});

test('reads scope to the injected org and report isAdmin from the injected role', async () => {
  const server = await listen(createApp());
  try {
    const admin = await (await fetch(`${server.url}/api/billing/summary`, { headers: ADMIN })).json();
    assert.equal(admin.orgId, ORG);
    assert.equal(admin.isAdmin, true);

    const member = await (await fetch(`${server.url}/api/billing/summary`, { headers: MEMBER })).json();
    assert.equal(member.orgId, ORG);
    assert.equal(member.isAdmin, false);
  } finally {
    await server.close();
  }
});

test('a client-controlled org header is ignored without the trusted billing header', async () => {
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/api/billing/summary`, {
      headers: { 'x-ai-fleet-organization-id': 'org-victim' },
    });
    const body = await res.json();
    assert.notEqual(body.orgId, 'org-victim');
    assert.equal(body.isAdmin, false);
  } finally {
    await server.close();
  }
});

test('mutations require the admin role on the trusted header', async () => {
  const server = await listen(createApp());
  try {
    const denied = await fetch(`${server.url}/api/billing/recharge`, {
      method: 'POST',
      headers: { ...MEMBER, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 50 }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'access_denied');

    const allowed = await fetch(`${server.url}/api/billing/recharge`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 50 }),
    });
    assert.equal(allowed.status, 200);
    const account = store.getBillingAccount(ORG);
    assert.ok(Number(account.balancePaise) >= 5000);
  } finally {
    await server.close();
  }
});

test('config update with percentage mode keeps Cashfree mandate fields', async () => {
  const server = await listen(createApp());
  try {
    store.upsertBillingAccount(ORG, {
      autoRecharge: { enabled: true, cashfreeSubscriptionId: 'sub_keep_me', paymentMethodType: 'upi' },
    });
    const res = await fetch(`${server.url}/api/billing/config`, {
      method: 'PUT',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ autoRecharge: { enabled: true, mode: 'percentage', thresholdPercent: 25, amountInr: 1500 } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.autoRecharge.mode, 'percentage');
    assert.equal(body.autoRecharge.thresholdPercent, 25);
    assert.equal(body.autoRecharge.cashfreeSubscriptionId, 'sub_keep_me');
    assert.equal(store.getBillingAccount(ORG).autoRecharge.cashfreeSubscriptionId, 'sub_keep_me');
  } finally {
    await server.close();
  }
});

test('billing /pubsub/billing-tick runs sweep', async () => {
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/pubsub/billing-tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  } finally {
    await server.close();
  }
});

test('cashfree order flow credits the wallet once and stays idempotent', async () => {
  const prevEnv = process.env.CASHFREE_ENV;
  delete process.env.CASHFREE_APP_ID;
  delete process.env.CASHFREE_SECRET_KEY;
  const server = await listen(createApp());
  try {
    const created = await (await fetch(`${server.url}/api/billing/cashfree/create-order`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 1000 }),
    })).json();
    assert.ok(created.paymentSessionId, 'mock client still returns a session id');
    assert.ok(created.orderId.startsWith(`order_${ORG}_`));

    const verified = await (await fetch(`${server.url}/api/billing/cashfree/verify-order`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: created.orderId }),
    })).json();
    assert.equal(verified.orderStatus, 'PAID');
    const afterFirst = Number(store.getBillingAccount(ORG).balancePaise);

    const again = await (await fetch(`${server.url}/api/billing/cashfree/verify-order`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: created.orderId }),
    })).json();
    assert.equal(again.alreadyProcessed, true);
    assert.equal(Number(store.getBillingAccount(ORG).balancePaise), afterFirst);
  } finally {
    await server.close();
    if (prevEnv !== undefined) process.env.CASHFREE_ENV = prevEnv;
  }
});

test('cashfree mandate creation fails closed when Cashfree is not configured', async () => {
  const prevAppId = process.env.CASHFREE_APP_ID;
  const prevKey = process.env.CASHFREE_SECRET_KEY;
  delete process.env.CASHFREE_APP_ID;
  delete process.env.CASHFREE_SECRET_KEY;
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/api/billing/cashfree/create-mandate`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not configured/);
  } finally {
    await server.close();
    if (prevAppId !== undefined) process.env.CASHFREE_APP_ID = prevAppId;
    if (prevKey !== undefined) process.env.CASHFREE_SECRET_KEY = prevKey;
  }
});

// The live failure this guards: sandbox base URL + production keys → Cashfree 401.
// It must reach the browser as a stated credential mismatch, not an opaque 500.
test('a Cashfree credential rejection surfaces as a 502 with the reason', async () => {
  const prevAppId = process.env.CASHFREE_APP_ID;
  const prevKey = process.env.CASHFREE_SECRET_KEY;
  const prevBase = process.env.CASHFREE_BASE_URL;
  const realFetch = globalThis.fetch;
  process.env.CASHFREE_APP_ID = 'PROD12345678';
  process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_prod_abc';
  process.env.CASHFREE_BASE_URL = 'https://sandbox.cashfree.com';
  const server = await listen(createApp());
  const upstream = () => new Response(JSON.stringify({ message: 'authentication Failed', code: 'UNAUTHORIZED' }), {
    status: 401, headers: { 'content-type': 'application/json' },
  });
  try {
    globalThis.fetch = (url, options) => (String(url).startsWith(server.url)
      ? realFetch(url, options)
      : Promise.resolve(upstream()));

    const res = await realFetch(`${server.url}/api/billing/cashfree/create-order`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 500 }),
    });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /credentials for the sandbox environment/);

    const mandate = await realFetch(`${server.url}/api/billing/cashfree/create-mandate`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(mandate.status, 502);
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
    for (const [key, value] of Object.entries({
      CASHFREE_APP_ID: prevAppId, CASHFREE_SECRET_KEY: prevKey, CASHFREE_BASE_URL: prevBase,
    })) {
      if (value !== undefined) process.env[key] = value;
      else delete process.env[key];
    }
  }
});

test('cashfree webhook rejects a bad signature in production and credits a good one', async () => {
  const prevKey = process.env.CASHFREE_SECRET_KEY;
  const prevEnv = process.env.NODE_ENV;
  const secret = 'wh-secret-for-test';
  process.env.CASHFREE_SECRET_KEY = secret;
  process.env.NODE_ENV = 'production';
  const server = await listen(createApp());
  try {
    const orderId = `order_${ORG}_wh_${Date.now()}`;
    const payload = JSON.stringify({
      type: 'ORDER_PAID_SUCCESS',
      data: { order: { order_id: orderId, order_amount: 250 } },
    });

    const timestamp = new Date().toISOString();
    const bad = await fetch(`${server.url}/api/billing/cashfree/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': crypto.createHmac('sha256', 'wrong').update(`${timestamp}${payload}`).digest('base64'),
      },
      body: payload,
    });
    assert.equal(bad.status, 401);

    const goodTs = new Date().toISOString();
    const good = await fetch(`${server.url}/api/billing/cashfree/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': goodTs,
        'x-webhook-signature': crypto.createHmac('sha256', secret).update(`${goodTs}${payload}`).digest('base64'),
      },
      body: payload,
    });
    assert.equal(good.status, 200);

    const entry = store.listLedgerEntries({ orgId: ORG }).find((e) => e.meta && e.meta.cashfreeOrderId === orderId);
    assert.ok(entry, 'the webhook credited the matching org');
    assert.equal(Number(entry.amountPaise), 25000);

    const replay = await fetch(`${server.url}/api/billing/cashfree/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(replay.status, 401, 'an unsigned replay is rejected before crediting');
    const count = store.listLedgerEntries({ orgId: ORG }).filter((e) => e.meta && e.meta.cashfreeOrderId === orderId).length;
    assert.equal(count, 1, 'replay does not double-credit');
  } finally {
    await server.close();
    if (prevKey !== undefined) process.env.CASHFREE_SECRET_KEY = prevKey; else delete process.env.CASHFREE_SECRET_KEY;
    if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv; else delete process.env.NODE_ENV;
  }
});
