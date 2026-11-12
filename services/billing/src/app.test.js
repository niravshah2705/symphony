'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate the file store BEFORE the store is required: without this the suite
// writes real JSON into the repo's ./data directory.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-app-test-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
// A quote needs a supplier state to compute CGST/SGST at all. FLEXPRICE_ENABLED
// stays off on purpose: it is the state every local test runs in, and "nothing is
// credited while there is no wallet" is itself one of the assertions below.
process.env.FLEXPRICE_SUPPLIER_STATE_CODE = '24';
delete process.env.FLEXPRICE_ENABLED;
delete process.env.FLEXPRICE_API_KEY_MONEY;
delete process.env.FLEXPRICE_API_KEY_INGEST;
delete process.env.BILLING_ALLOW_MOCK_PAYMENTS;
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

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
  const QUOTE_ORG = 'org-quote-only';
  const admin = { 'x-ai-fleet-billing-org-id': QUOTE_ORG, 'x-ai-fleet-billing-org-role': 'ORG_ADMIN' };
  const member = { 'x-ai-fleet-billing-org-id': QUOTE_ORG, 'x-ai-fleet-billing-org-role': 'ORG_MEMBER' };
  try {
    const denied = await fetch(`${server.url}/api/billing/recharge`, {
      method: 'POST',
      headers: { ...member, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 500 }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'access_denied');

    const allowed = await fetch(`${server.url}/api/billing/recharge`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 500 }),
    });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();

    // POST /recharge used to move money with no payment behind it. It is a quote
    // now, and the proof is that the org still has no account and no ledger row.
    assert.equal(body.settled, false);
    const account = store.getBillingAccount(QUOTE_ORG);
    assert.ok(!account || account.balancePaise == null, 'a quote must not create or move a balance');
    assert.equal(store.listLedgerEntries({ orgId: QUOTE_ORG }).length, 0);
    assert.equal(store.listRechargeIntents({ orgId: QUOTE_ORG }).length, 0, 'and must not create an order either');
  } finally {
    await server.close();
  }
});

test('the quote is the GST breakdown the customer is shown before paying', async () => {
  const server = await listen(createApp());
  try {
    const body = await (await fetch(`${server.url}/api/billing/recharge`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 500 }),
    })).json();
    assert.deepEqual(body.quote, {
      subtotalPaise: 50000,
      subtotalInr: '500.00',
      components: [
        { name: 'CGST', rateBps: 900, paise: 4500, inr: '45.00' },
        { name: 'SGST', rateBps: 900, paise: 4500, inr: '45.00' },
      ],
      gstPaise: 9000,
      gstInr: '90.00',
      totalPaise: 59000,
      totalInr: '590.00',
      bonusPaise: 0,
      bonusInr: '0.00',
      credits: 500,
      placeOfSupply: body.quote.placeOfSupply,
    }, '₹500 + ₹45 + ₹45 = ₹590 for 500 credits — every number on one screen');
    assert.equal(body.quote.credits, 500, 'credits follow the subtotal, never the ₹590');
    assert.equal(body.quote.placeOfSupply.stateCode, '24');
    assert.equal(body.quote.placeOfSupply.assumed, true, 'with no GSTIN the split is assumed, and the UI has to say so');
    assert.equal(body.warnings, undefined);
  } finally {
    await server.close();
  }
});

test('an amount that is not a whole number of rupees is refused on the way in', async () => {
  const server = await listen(createApp());
  try {
    for (const amountInr of [500.5, '500.50', 0, -500, 'abc', null]) {
      const res = await fetch(`${server.url}/api/billing/recharge`, {
        method: 'POST',
        headers: { ...ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({ amountInr }),
      });
      assert.equal(res.status, 400, `${amountInr} must not be quotable`);
      assert.equal((await res.json()).code, 'invalid_amount');
    }
    const exact = await fetch(`${server.url}/api/billing/recharge`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: '500.00' }),
    });
    assert.equal(exact.status, 200, 'a decimal string that lands on whole rupees is fine');
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
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
    // The tick owns the outbox drain too, and with FlexPrice disabled — the state
    // every local suite runs in — the drain must report that it skipped rather
    // than reaching for a client it has no keys for.
    assert.deepEqual(body.outbox, { skipped: 'disabled' });
    assert.equal(typeof body.reconciliation.orgs, 'number');
  } finally {
    await server.close();
  }
});

test('billing tick reconciles after actor sweep and outbox drain without coupling failures', async () => {
  const order = [];
  const server = await listen(createApp({
    sweepActorSessions: async () => { order.push('actors'); return { swept: 1 }; },
    drainOutbox: async () => { order.push('outbox'); return { delivered: 1 }; },
    reconcileGatewaySpend: async () => {
      order.push('reconcile');
      throw new Error('meter unavailable');
    },
  }));
  try {
    const res = await fetch(`${server.url}/pubsub/billing-tick`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(order, ['actors', 'outbox', 'reconcile']);
    assert.deepEqual(body.actorSessions, { swept: 1 });
    assert.deepEqual(body.outbox, { delivered: 1 });
    assert.equal(body.reconciliation, null);
  } finally {
    await server.close();
  }
});

test('create-order persists the quote as an intent, and verify-order settles it or refuses', async () => {
  // Cashfree has no keys in this suite, so the order is synthesized — which is
  // the point: the gateway is not what defines the money here, the intent is.
  const ORDER_ORG = 'org-order-flow';
  const orderAdmin = { 'x-ai-fleet-billing-org-id': ORDER_ORG, 'x-ai-fleet-billing-org-role': 'ORG_ADMIN' };
  const otherAdmin = { 'x-ai-fleet-billing-org-id': 'org-attacker', 'x-ai-fleet-billing-org-role': 'ORG_ADMIN' };
  const prevAppId = process.env.CASHFREE_APP_ID;
  const prevKey = process.env.CASHFREE_SECRET_KEY;
  delete process.env.CASHFREE_APP_ID;
  delete process.env.CASHFREE_SECRET_KEY;
  process.env.BILLING_ALLOW_MOCK_PAYMENTS = 'true';
  const server = await listen(createApp());
  try {
    const created = await (await fetch(`${server.url}/api/billing/cashfree/create-order`, {
      method: 'POST',
      headers: { ...orderAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 500 }),
    })).json();
    assert.match(created.orderId, new RegExp(`^order_${ORDER_ORG}_`));
    assert.equal(created.provider, 'cashfree');
    assert.equal(created.checkout.mode, 'mock');
    assert.equal(created.paymentSessionId, null, 'no keys means no session to hand the browser');
    assert.equal(created.quote.totalInr, '590.00');

    const intent = store.getRechargeIntent(created.orderId);
    assert.deepEqual(
      {
        org: intent.orgId, provider: intent.provider, status: intent.status,
        subtotal: intent.subtotalPaise, coupon: intent.couponBps, bonus: intent.bonusPaise,
        gst: intent.gstPaise, total: intent.totalPaise, credits: intent.creditCount,
        supplierState: intent.supplierStateCode,
      },
      {
        org: ORDER_ORG, provider: 'cashfree', status: 'QUOTED',
        subtotal: 50000, coupon: 0, bonus: 0, gst: 9000, total: 59000, credits: 500,
        supplierState: '24',
      },
      'the settlement authority is the record, so it has to carry the whole quote',
    );

    // FLEXPRICE_ENABLED is off for this suite, which is the state a deployment
    // without a wallet is in. The refusal must be the typed one and must leave the
    // order settleable later, not settled and not credited.
    const verify = await fetch(`${server.url}/api/billing/cashfree/verify-order`, {
      method: 'POST',
      headers: { ...orderAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: created.orderId }),
    });
    assert.equal(verify.status, 503);
    assert.equal((await verify.json()).code, 'flexprice_disabled');
    assert.equal(store.getRechargeIntent(created.orderId).status, 'QUOTED');
    assert.equal(store.listLedgerEntries({ orgId: ORDER_ORG }).length, 0, 'nothing is credited behind settle()');

    const crossOrg = await fetch(`${server.url}/api/billing/cashfree/verify-order`, {
      method: 'POST',
      headers: { ...otherAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: created.orderId }),
    });
    assert.equal(crossOrg.status, 403, 'this is the hole the old verify-order left open');
    assert.equal((await crossOrg.json()).code, 'order_not_mine');
    assert.equal(store.getRechargeIntent(created.orderId).status, 'QUOTED');

    const ghost = await fetch(`${server.url}/api/billing/cashfree/verify-order`, {
      method: 'POST',
      headers: { ...orderAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: 'order_org_victim_1' }),
    });
    assert.equal(ghost.status, 404);
    assert.equal((await ghost.json()).code, 'intent_not_found');

    const noId = await fetch(`${server.url}/api/billing/recharge/settle`, {
      method: 'POST',
      headers: { ...orderAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noId.status, 400);
    assert.equal((await noId.json()).code, 'missing_order_id');
  } finally {
    await server.close();
    delete process.env.BILLING_ALLOW_MOCK_PAYMENTS;
    if (prevAppId !== undefined) process.env.CASHFREE_APP_ID = prevAppId;
    if (prevKey !== undefined) process.env.CASHFREE_SECRET_KEY = prevKey;
  }
});

test('the Razorpay path picks its gateway, proves its signature, and settles nothing without it', async () => {
  const RZP_ORG = 'org-razorpay-flow';
  const rzpAdmin = { 'x-ai-fleet-billing-org-id': RZP_ORG, 'x-ai-fleet-billing-org-role': 'ORG_ADMIN' };
  const prevFlag = process.env.BILLING_ALLOW_MOCK_PAYMENTS;
  process.env.BILLING_ALLOW_MOCK_PAYMENTS = 'true';
  const server = await listen(createApp());
  try {
    const created = await (await fetch(`${server.url}/api/billing/razorpay/create-order`, {
      method: 'POST',
      headers: { ...rzpAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 500 }),
    })).json();
    assert.equal(created.provider, 'razorpay');
    assert.equal(store.getRechargeIntent(created.orderId).provider, 'razorpay', 'settle() asks Razorpay, not whoever the browser claims');

    const badSignature = await fetch(`${server.url}/api/billing/razorpay/verify-order`, {
      method: 'POST',
      headers: { ...rzpAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({
        orderId: created.orderId,
        razorpayOrderId: 'order_Rzp1',
        razorpayPaymentId: 'pay_Rzp1',
        razorpayPaymentSignature: 'deadbeef',
      }),
    });
    assert.equal(badSignature.status, 400);
    assert.equal((await badSignature.json()).code, 'payment_signature_invalid');
    assert.equal(store.getRechargeIntent(created.orderId).status, 'QUOTED');

    const unknown = await fetch(`${server.url}/api/billing/recharge/create-order`, {
      method: 'POST',
      headers: { ...rzpAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 500, provider: 'paypal' }),
    });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).code, 'unknown_provider');
  } finally {
    await server.close();
    if (prevFlag !== undefined) process.env.BILLING_ALLOW_MOCK_PAYMENTS = prevFlag; else delete process.env.BILLING_ALLOW_MOCK_PAYMENTS;
  }
});

test('a gateway with no keys creates no order unless the dev mock flag is on', async () => {
  const prevAppId = process.env.CASHFREE_APP_ID;
  const prevKey = process.env.CASHFREE_SECRET_KEY;
  delete process.env.CASHFREE_APP_ID;
  delete process.env.CASHFREE_SECRET_KEY;
  delete process.env.BILLING_ALLOW_MOCK_PAYMENTS;
  const server = await listen(createApp());
  try {
    const before = store.listRechargeIntents().length;
    const res = await fetch(`${server.url}/api/billing/cashfree/create-order`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 500 }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'provider_not_configured');
    assert.equal(store.listRechargeIntents().length, before, 'an unpayable order must not be left behind');
  } finally {
    await server.close();
    if (prevAppId !== undefined) process.env.CASHFREE_APP_ID = prevAppId;
    if (prevKey !== undefined) process.env.CASHFREE_SECRET_KEY = prevKey;
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

test('the Cashfree webhook is signature-gated everywhere and never prices an order', async () => {
  const prevKey = process.env.CASHFREE_SECRET_KEY;
  const prevEnv = process.env.NODE_ENV;
  const prevFlag = process.env.BILLING_ALLOW_MOCK_PAYMENTS;
  const secret = 'wh-secret-for-test';
  process.env.CASHFREE_SECRET_KEY = secret;
  // NODE_ENV deliberately stays unset: the gate used to be
  // `if (!isValid && NODE_ENV === 'production')`, i.e. it failed open exactly
  // where every test and every local stack runs.
  delete process.env.NODE_ENV;
  delete process.env.BILLING_ALLOW_MOCK_PAYMENTS;

  const WH_ORG = 'org-webhook-flow';
  const whAdmin = { 'x-ai-fleet-billing-org-id': WH_ORG, 'x-ai-fleet-billing-org-role': 'ORG_ADMIN' };
  const sign = (timestamp, payload) => crypto.createHmac('sha256', secret).update(`${timestamp}${payload}`).digest('base64');
  const post = (server, payload, signature, timestamp) => fetch(`${server.url}/api/billing/cashfree/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(timestamp ? { 'x-webhook-timestamp': timestamp } : {}),
      ...(signature ? { 'x-webhook-signature': signature } : {}),
    },
    body: payload,
  });
  const signed = (server, payload) => {
    const timestamp = new Date().toISOString();
    return post(server, payload, sign(timestamp, payload), timestamp);
  };

  const server = await listen(createApp());
  try {
    const orderId = `order_${WH_ORG}_wh_${Date.now()}`;
    // An event naming an order this server never quoted, priced by the event
    // itself. That is the payload the deleted prefix-scan path used to honour.
    const forged = JSON.stringify({
      type: 'ORDER_PAID_SUCCESS',
      data: { order: { order_id: orderId, order_amount: 250 } },
    });

    const wrongTs = new Date().toISOString();
    const unsigned = await post(server, forged,
      crypto.createHmac('sha256', 'wrong-secret').update(`${wrongTs}${forged}`).digest('base64'), wrongTs);
    assert.equal(unsigned.status, 401, 'an unsigned webhook is refused outside production too');
    assert.equal((await unsigned.json()).code, 'webhook_signature_invalid');
    assert.equal(store.listLedgerEntries({ orgId: WH_ORG }).length, 0);

    const noIntent = await signed(server, forged);
    assert.equal(noIntent.status, 200, 'a valid event for an unknown order is acknowledged, not retried');
    assert.equal(store.getRechargeIntent(orderId), null);
    assert.equal(store.listLedgerEntries({ orgId: WH_ORG }).length, 0, 'and it credits nothing');

    // Now a real order. settle() cannot reach a wallet in this suite, so the
    // route must fail loudly enough that Cashfree retries the event.
    process.env.BILLING_ALLOW_MOCK_PAYMENTS = 'true';
    const created = await (await fetch(`${server.url}/api/billing/cashfree/create-order`, {
      method: 'POST',
      headers: { ...whAdmin, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 500 }),
    })).json();
    const paid = JSON.stringify({
      type: 'ORDER_PAID_SUCCESS',
      data: { order: { order_id: created.orderId, order_amount: '590.00' } },
    });
    const retry = await signed(server, paid);
    assert.equal(retry.status, 503, 'any 5xx makes the gateway retry the event');
    assert.equal((await retry.json()).code, 'flexprice_disabled');
    assert.equal(store.getRechargeIntent(created.orderId).status, 'QUOTED');
    delete process.env.BILLING_ALLOW_MOCK_PAYMENTS;

    const replayUnsigned = await post(server, paid, null, null);
    assert.equal(replayUnsigned.status, 401, 'replay without a signature is refused before anything is read');
    assert.equal(store.getRechargeIntent(created.orderId).status, 'QUOTED');
  } finally {
    await server.close();
    if (prevKey !== undefined) process.env.CASHFREE_SECRET_KEY = prevKey; else delete process.env.CASHFREE_SECRET_KEY;
    if (prevEnv !== undefined) process.env.NODE_ENV = prevEnv; else delete process.env.NODE_ENV;
    if (prevFlag !== undefined) process.env.BILLING_ALLOW_MOCK_PAYMENTS = prevFlag; else delete process.env.BILLING_ALLOW_MOCK_PAYMENTS;
  }
});

test('the Razorpay webhook needs its secret and settles only an order we quoted', async () => {
  const prevWebhook = process.env.RAZORPAY_WEBHOOK_SECRET;
  const prevFlag = process.env.BILLING_ALLOW_MOCK_PAYMENTS;
  const secret = 'whsec_test';
  process.env.RAZORPAY_WEBHOOK_SECRET = secret;
  delete process.env.BILLING_ALLOW_MOCK_PAYMENTS;
  const server = await listen(createApp());
  try {
    const payload = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_org_victim_1', amount: 59000, status: 'captured' } } },
    });
    const bad = await fetch(`${server.url}/api/billing/razorpay/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'nope' },
      body: payload,
    });
    assert.equal(bad.status, 401);
    assert.equal((await bad.json()).code, 'webhook_signature_invalid');

    const good = await fetch(`${server.url}/api/billing/razorpay/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', secret).update(payload).digest('hex') },
      body: payload,
    });
    assert.equal(good.status, 200);
    assert.equal(await good.text(), JSON.stringify({ status: 'ok' }), 'a signed event for an order we never quoted does nothing');

    const noSecret = await (async () => {
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
      return fetch(`${server.url}/api/billing/razorpay/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', secret).update(payload).digest('hex') },
        body: payload,
      });
    })();
    assert.equal(noSecret.status, 401, 'with no secret configured, nothing verifies — the check never passes by default');
  } finally {
    await server.close();
    if (prevWebhook !== undefined) process.env.RAZORPAY_WEBHOOK_SECRET = prevWebhook; else delete process.env.RAZORPAY_WEBHOOK_SECRET;
    if (prevFlag !== undefined) process.env.BILLING_ALLOW_MOCK_PAYMENTS = prevFlag; else delete process.env.BILLING_ALLOW_MOCK_PAYMENTS;
  }
});

test('a saved GSTIN is validated on the way in and decides the tax split on the way out', async () => {
  const GST_ORG = 'org-gstin';
  const gstAdmin = { 'x-ai-fleet-billing-org-id': GST_ORG, 'x-ai-fleet-billing-org-role': 'ORG_ADMIN' };
  const server = await listen(createApp());
  const putConfig = (body) => fetch(`${server.url}/api/billing/config`, {
    method: 'PUT', headers: { ...gstAdmin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const recharge = () => fetch(`${server.url}/api/billing/recharge`, {
    method: 'POST', headers: { ...gstAdmin, 'content-type': 'application/json' }, body: JSON.stringify({ amountInr: 500 }),
  });
  try {
    const garbage = await putConfig({ paymentInfo: { taxId: 'not-a-gstin' } });
    assert.equal(garbage.status, 400);
    assert.equal((await garbage.json()).code, 'invalid_gstin');

    const interstate = await putConfig({ paymentInfo: { billingName: 'Karnataka Co', taxId: '29AAAAA0000A1Z5', provider: ' Razorpay ' } });
    assert.equal(interstate.status, 200);
    const saved = store.getBillingAccount(GST_ORG).paymentInfo;
    assert.equal(saved.taxId, '29AAAAA0000A1Z5');
    assert.equal(saved.provider, 'razorpay', 'the provider preference is normalized and persisted');

    const quote = await (await recharge()).json();
    assert.deepEqual(quote.quote.components.map((c) => [c.name, c.paise]), [['IGST', 9000]]);
    assert.equal(quote.quote.placeOfSupply.type, 'interstate');
    assert.equal(quote.quote.placeOfSupply.stateCode, '29');
    assert.equal(quote.quote.placeOfSupply.assumed, false);
    assert.equal(quote.quote.totalInr, '590.00', 'same total, different split — 18% either way');

    const blank = await putConfig({ paymentInfo: { taxId: '' } });
    assert.equal(blank.status, 200);
    const assumed = await (await recharge()).json();
    assert.equal(assumed.quote.placeOfSupply.assumed, true, 'a cleared GSTIN goes back to an assumed intrastate split, visibly');
  } finally {
    await server.close();
  }
});

// --- hourly auto-recharge tick ------------------------------------------------
// The route is the only thing between a scheduler tick and real money, so its two
// branches are pinned: in the cloud it must LAUNCH the one-shot Job and do nothing
// else; locally (no Job to launch) it must run the entrypoint in-process.
test('billing recharge tick launches the Cloud Run Job instead of sweeping in-request', async () => {
  const launched = [];
  let ranInProcess = 0;
  const server = await listen(createApp({
    rechargeTrigger: {
      isCloudJobEnabled: () => true,
      runRechargeJob: async (params) => {
        launched.push(params);
        return { execution: 'projects/p/locations/r/jobs/billing-auto-recharge/executions/e', job: 'jobs/billing-auto-recharge' };
      },
    },
    runAutoRechargeJob: async () => { ranInProcess += 1; return {}; },
  }));
  try {
    const res = await fetch(`${server.url}/pubsub/billing-recharge-tick`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'launched');
    assert.match(body.execution, /executions\/e$/);
    assert.equal(ranInProcess, 0, 'the cloud path must never charge inside the service');
    assert.equal(launched.length, 1);
  } finally {
    await server.close();
  }
});

test('billing recharge tick runs the sweep in-process when no Job is configured', async () => {
  let jobOptions = null;
  const server = await listen(createApp({
    rechargeTrigger: { isCloudJobEnabled: () => false, runRechargeJob: async () => { throw new Error('must not launch'); } },
    runAutoRechargeJob: async (opts) => {
      jobOptions = opts;
      return { checked: 2, charged: 1, alerted: 1, skipped: 0, dryRun: false };
    },
  }));
  try {
    const res = await fetch(`${server.url}/pubsub/billing-recharge-tick`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: 'completed', checked: 2, charged: 1, alerted: 1, skipped: 0, dryRun: false,
    });
    // The entrypoint exits the process on a fully-failed sweep, so a request handler
    // must hand it a no-op: one bad org cannot kill the serving container.
    assert.equal(typeof jobOptions.exit, 'function');
    jobOptions.exit(1);
  } finally {
    await server.close();
  }
});

test('billing recharge tick reports a launch failure as 500 so the scheduler retries', async () => {
  const server = await listen(createApp({
    rechargeTrigger: {
      isCloudJobEnabled: () => true,
      runRechargeJob: async () => { throw new Error('run.jobs.run denied'); },
    },
  }));
  try {
    const res = await fetch(`${server.url}/pubsub/billing-recharge-tick`, { method: 'POST' });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /run\.jobs\.run denied/);
  } finally {
    await server.close();
  }
});

test('a Cashfree credential rejection surfaces as a typed 502, not an opaque 500', async () => {
  // Regression: with no error handler the express default returned an HTML 500,
  // so Cashfree's 401 authentication_failed reached the browser as an
  // unattributable Internal Server Error.
  const prevAppId = process.env.CASHFREE_APP_ID;
  const prevKey = process.env.CASHFREE_SECRET_KEY;
  const realFetch = global.fetch;
  process.env.CASHFREE_APP_ID = 'TEST_probe_app_id';
  process.env.CASHFREE_SECRET_KEY = 'cfsk_probe_wrong_key';
  global.fetch = async (url, init) => {
    if (String(url).includes('cashfree.com')) {
      return {
        ok: false,
        status: 401,
        json: async () => ({
          message: 'authentication Failed',
          code: 'request_failed',
          type: 'authentication_error',
        }),
      };
    }
    return realFetch(url, init);
  };
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/api/billing/cashfree/create-order`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amountInr: 500 }),
    });
    assert.equal(res.status, 502);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.code, 'cashfree_authentication_failed');
    assert.match(body.error, /rejected the configured API credentials/);
    assert.doesNotMatch(JSON.stringify(body), /cfsk_probe_wrong_key|TEST_probe_app_id/, 'never echoes the key');
  } finally {
    global.fetch = realFetch;
    await server.close();
    if (prevAppId !== undefined) process.env.CASHFREE_APP_ID = prevAppId; else delete process.env.CASHFREE_APP_ID;
    if (prevKey !== undefined) process.env.CASHFREE_SECRET_KEY = prevKey; else delete process.env.CASHFREE_SECRET_KEY;
  }
});
