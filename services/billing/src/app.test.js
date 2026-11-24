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
process.env.SOFTWARE_FACTORY_DATA_DIR = TMP_DIR;
// A quote needs a supplier state to compute CGST/SGST at all. FLEXPRICE_ENABLED
// stays off on purpose: it is the state every local test runs in, and "nothing is
// credited while there is no wallet" is itself one of the assertions below.
process.env.FLEXPRICE_SUPPLIER_STATE_CODE = '24';
delete process.env.FLEXPRICE_ENABLED;
delete process.env.FLEXPRICE_API_KEY_MONEY;
delete process.env.FLEXPRICE_API_KEY_INGEST;
delete process.env.BILLING_ALLOW_MOCK_PAYMENTS;
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const creditRates = require('@software-factory/shared-core/billing/credit-rates');

// Recharges are fixed packages, so this suite needs a card that also holds a RETIRED
// offer — the real card has none, and a retired package is the case that must still
// settle (risk 6). The fixture is the shipped card plus one disabled row appended to its
// `packages` block, so every other identity here (₹2000 → 3,500 credits, ₹4000 → 10,000)
// is the number an operator actually published, not a test-local invention.
const PACKAGE_ID = 'credits-3500';
const PACKAGE_PRICE_INR = 2000;
const PACKAGE_CREDITS = 3500;
const PACKAGE_BONUS_TOKEN_CREDITS = 150000; // 1,500 credits at 7500 bps on ₹2,000
const PACKAGE_SUBTOTAL_PAISE = 200000;
const PACKAGE_GST_PAISE = 36000;            // CGST 18000 + SGST 18000
const PACKAGE_TOTAL_PAISE = 236000;         // the string the gateway charges: "2360.00"
const RETIRED_ID = 'credits-retired-fixture';

const CARD_FIXTURE = path.join(TMP_DIR, 'credit-rates.yaml');
fs.writeFileSync(CARD_FIXTURE, `${fs.readFileSync(creditRates.DEFAULT_CARD_PATH, 'utf8')
}  - id: ${RETIRED_ID}
    price_inr: "1000"
    credits: 1000
    bonus_valid_days: 30
    enabled: false
`);
process.env.CREDIT_RATES_FILE = CARD_FIXTURE;
creditRates.resetCard();
test.after(() => {
  delete process.env.CREDIT_RATES_FILE;
  creditRates.resetCard();
});

const store = require('@software-factory/shared-core/store');
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
    assert.match(await res.text(), /Software Factory · Billing Control Center/);
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
      body: JSON.stringify({ packageId: PACKAGE_ID }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'access_denied');

    const allowed = await fetch(`${server.url}/api/billing/recharge`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ packageId: PACKAGE_ID }),
    });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();

    // POST /recharge used to move money with no payment behind it. It is a quote
    // now, and the proof is that the org still has no account and no ledger row.
    assert.equal(body.settled, false);
    const account = store.getBillingAccount(QUOTE_ORG);
    assert.ok(!account || account.balanceTokenCredits == null, 'a quote must not create or move a balance');
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
      body: JSON.stringify({ packageId: PACKAGE_ID }),
    })).json();
    assert.deepEqual(body.package, {
      packageId: PACKAGE_ID,
      priceInr: PACKAGE_PRICE_INR,
      credits: PACKAGE_CREDITS,
      prepaidCredits: PACKAGE_PRICE_INR,
      bonusCredits: PACKAGE_CREDITS - PACKAGE_PRICE_INR,
      bonusValidDays: 30,
    }, 'the panel renders this row, so it must name the offer the card sells');
    assert.deepEqual(body.quote, {
      subtotalPaise: PACKAGE_SUBTOTAL_PAISE,
      subtotalInr: '2000.00',
      components: [
        { name: 'CGST', rateBps: 900, paise: 18000, inr: '180.00' },
        { name: 'SGST', rateBps: 900, paise: 18000, inr: '180.00' },
      ],
      gstPaise: PACKAGE_GST_PAISE,
      gstInr: '360.00',
      totalPaise: PACKAGE_TOTAL_PAISE,
      totalInr: '2360.00',
      bonusTokenCredits: PACKAGE_BONUS_TOKEN_CREDITS,
      bonusCredits: '1500.00',
      prepaidCredits: 2000,
      placeOfSupply: body.quote.placeOfSupply,
    }, '₹2,000 + ₹180 + ₹180 = ₹2,360 for 3,500 credits — every number on one screen');
    assert.equal(body.quote.prepaidCredits, 2000, 'credits follow the ₹2,000 subtotal, never the ₹2,360 charged');
    assert.equal(2000 + Number(body.quote.bonusCredits), PACKAGE_CREDITS, 'the two credit columns are the advertised total');
    assert.equal(body.quote.placeOfSupply.stateCode, '24');
    assert.equal(body.quote.placeOfSupply.assumed, true, 'with no GSTIN the split is assumed, and the UI has to say so');
    assert.equal(body.warnings, undefined);
  } finally {
    await server.close();
  }
});

test('the summary lists the card offers, and only the card offers', async () => {
  const server = await listen(createApp());
  try {
    const body = await (await fetch(`${server.url}/api/billing/summary`, { headers: ADMIN })).json();
    assert.deepEqual(body.rechargePackages.map((p) => p.packageId), ['credits-3500', 'credits-10000'],
      'a retired package is not offered for a NEW order, though settle() still honors it');
    assert.deepEqual(body.rechargePackages[0], {
      packageId: PACKAGE_ID, priceInr: PACKAGE_PRICE_INR, credits: PACKAGE_CREDITS,
      prepaidCredits: PACKAGE_PRICE_INR, bonusCredits: 1500, bonusValidDays: 30,
    });
    assert.equal(JSON.stringify(body.rechargePackages).includes('amountInr'), false,
      'the browser composes no amount, so nothing in the offer list reads like one');
  } finally {
    await server.close();
  }
});

test('a client-composed price is refused on the way in, not ignored', async () => {
  const server = await listen(createApp());
  const post = (route, body) => fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: { ...ADMIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    // Each of these used to be a price the caller chose. Now they are a 400 naming the
    // field: a stale SPA bundle that still posts `amountInr` must fail loudly rather
    // than quietly buy something else.
    for (const sent of [
      { amountInr: 500 },
      { amountInr: 500.5 },
      { couponBps: 0 },
      { bonusExpiresAt: '2027-01-01T00:00:00.000Z' },
      { packageId: PACKAGE_ID, amountInr: PACKAGE_PRICE_INR },
    ]) {
      for (const route of ['/api/billing/recharge', '/api/billing/cashfree/create-order']) {
        const res = await post(route, sent);
        assert.equal(res.status, 400, `${JSON.stringify(sent)} on ${route} must not be orderable`);
        assert.equal((await res.json()).code, 'amount_not_accepted', route);
      }
    }

    const omitted = await post('/api/billing/recharge', {});
    assert.equal(omitted.status, 400);
    assert.equal((await omitted.json()).code, 'missing_package_id');

    const unknown = await post('/api/billing/recharge', { packageId: 'credits-999999' });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).code, 'unknown_package');

    // Retirement refuses a NEW order only. The same id still settles below.
    const retired = await post('/api/billing/cashfree/create-order', { packageId: RETIRED_ID });
    assert.equal(retired.status, 400);
    assert.equal((await retired.json()).code, 'package_retired');

    const padded = await post('/api/billing/recharge', { packageId: `  ${PACKAGE_ID}  ` });
    assert.equal(padded.status, 200, 'surrounding whitespace is not a bad request');
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
      body: JSON.stringify({ autoRecharge: { enabled: true, mode: 'percentage', thresholdPercent: 25, amountCredits: 1500 } }),
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

test('auto-recharge stores a package preference and refuses one that does not exist', async () => {
  const AR_ORG = 'org-auto-recharge-pref';
  const arAdmin = { 'x-ai-fleet-billing-org-id': AR_ORG, 'x-ai-fleet-billing-org-role': 'ORG_ADMIN' };
  const putConfig = (body) => fetch(`${server.url}/api/billing/config`, {
    method: 'PUT', headers: { ...arAdmin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const server = await listen(createApp());
  try {
    const saved = await (await putConfig({ autoRecharge: { enabled: true, thresholdCredits: 40, amountCredits: 500, packageId: 'credits-10000' } })).json();
    assert.equal(saved.autoRecharge.packageId, 'credits-10000');
    assert.equal(saved.unit, 'credits');
    assert.equal(saved.autoRecharge.thresholdCredits, '40.00', 'the wire speaks credits');
    assert.equal(store.getBillingAccount(AR_ORG).autoRecharge.thresholdTokenCredits, 4000,
      'the store keeps the integer subunit, which is the same number two decimals to the right');
    assert.equal(store.getBillingAccount(AR_ORG).autoRecharge.amountPaise, 50000,
      'and the reload amount keeps its rupee name, because it is what the card is charged');
    assert.equal(store.getBillingAccount(AR_ORG).autoRecharge.packageId, 'credits-10000',
      'the reload offer the org picked is stored; nothing settles it yet');

    const kept = await (await putConfig({ autoRecharge: { enabled: false } })).json();
    assert.equal(kept.autoRecharge.packageId, 'credits-10000', 'an unrelated edit keeps the preference');

    const unknown = await putConfig({ autoRecharge: { packageId: 'credits-999999' } });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).code, 'unknown_package');

    const retired = await putConfig({ autoRecharge: { packageId: RETIRED_ID } });
    assert.equal(retired.status, 400);
    assert.equal((await retired.json()).code, 'package_retired');

    const cleared = await (await putConfig({ autoRecharge: { packageId: '' } })).json();
    assert.equal(cleared.autoRecharge.packageId, null, 'clearing is allowed; an invented id is not');
  } finally {
    await server.close();
  }
});

// `autoRecharge` is rewritten wholesale from the request, so a threshold that arrives under
// the old rupee name is a threshold that arrives as 0. On the order path a wrong field is a
// wrong price; here it is an alert that never fires and an auto-reload that never runs, on a
// balance that is falling. So the stale name is refused by name, and nothing is written.
test('a config posted in rupees is refused, not filed as zero', async () => {
  const RUPEE_ORG = 'org-config-rupees';
  const arAdmin = { 'x-ai-fleet-billing-org-id': RUPEE_ORG, 'x-ai-fleet-billing-org-role': 'ORG_ADMIN' };
  const server = await listen(createApp());
  try {
    const put = (body) => fetch(`${server.url}/api/billing/config`, {
      method: 'PUT', headers: { ...arAdmin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const good = await (await put({ autoRecharge: { enabled: true, thresholdCredits: 80, amountCredits: 500 } })).json();
    assert.equal(good.autoRecharge.thresholdCredits, '80.00');

    for (const [sent, named] of [
      [{ autoRecharge: { enabled: true, thresholdInr: 40 } }, 'autoRecharge.thresholdInr'],
      [{ autoRecharge: { enabled: true, amountInr: 500 } }, 'autoRecharge.amountInr'],
      [{ alertThresholdsInr: [100, 0] }, 'alertThresholdsInr'],
    ]) {
      const res = await put(sent);
      assert.equal(res.status, 400, JSON.stringify(sent));
      const body = await res.json();
      assert.equal(body.code, 'unit_not_accepted');
      assert.ok(body.error.includes(named), `${named} is named in the refusal: ${body.error}`);
    }

    const after = store.getBillingAccount(RUPEE_ORG).autoRecharge;
    assert.equal(after.thresholdTokenCredits, 8000, 'the refused write left the stored threshold alone');
    assert.equal(after.amountPaise, 50000);
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
    assert.equal('reconciliation' in body, false);
  } finally {
    await server.close();
  }
});

test('billing tick runs actor sweep then outbox drain, and no longer reconciles', async () => {
  const order = [];
  const server = await listen(createApp({
    sweepActorSessions: async () => { order.push('actors'); throw new Error('sweep down'); },
    drainOutbox: async () => { order.push('outbox'); return { delivered: 1 }; },
  }));
  try {
    const res = await fetch(`${server.url}/pubsub/billing-tick`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(order, ['actors', 'outbox']);
    assert.equal(body.actorSessions, null);
    assert.deepEqual(body.outbox, { delivered: 1 });
    assert.equal('reconciliation' in body, false);
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
      body: JSON.stringify({ packageId: PACKAGE_ID }),
    })).json();
    assert.match(created.orderId, new RegExp(`^order_${ORDER_ORG}_`));
    assert.equal(created.provider, 'cashfree');
    assert.equal(created.checkout.mode, 'mock');
    assert.equal(created.paymentSessionId, null, 'no keys means no session to hand the browser');
    assert.equal(created.package.packageId, PACKAGE_ID);
    assert.equal(created.payableInr, '2360.00', 'the gross the gateway will charge');
    assert.equal(created.quote.totalInr, '2360.00');

    const intent = store.getRechargeIntent(created.orderId);
    assert.deepEqual(
      {
        org: intent.orgId, provider: intent.provider, status: intent.status,
        package: intent.packageId,
        subtotal: intent.subtotalPaise, coupon: intent.couponBps, bonus: intent.bonusTokenCredits,
        gst: intent.gstPaise, total: intent.totalPaise, credits: intent.creditCount,
        validDays: intent.bonusValidDays,
        supplierState: intent.supplierStateCode,
        customerGstin: intent.customerGstin ?? null,
        customerState: intent.customerStateCode ?? null,
      },
      {
        org: ORDER_ORG, provider: 'cashfree', status: 'QUOTED', package: PACKAGE_ID,
        subtotal: PACKAGE_SUBTOTAL_PAISE, coupon: 7500, bonus: PACKAGE_BONUS_TOKEN_CREDITS,
        gst: PACKAGE_GST_PAISE, total: PACKAGE_TOTAL_PAISE, credits: 2000,
        validDays: 30, supplierState: '24', customerGstin: null, customerState: null,
      },
      'the settlement authority is the record, so it has to carry the whole offer',
    );
    assert.ok(Math.abs((Date.parse(intent.promoExpiresAt) - Date.parse(intent.createdAt)) - 30 * 86400000) < 5000,
      'the bonus clock starts at the order, from the package window — not from anything the browser sent');
    assert.equal(intent.placeOfSupply.assumed, true);

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
      body: JSON.stringify({ packageId: PACKAGE_ID }),
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
      body: JSON.stringify({ packageId: PACKAGE_ID, provider: 'paypal' }),
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
      body: JSON.stringify({ packageId: PACKAGE_ID }),
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
      body: JSON.stringify({ packageId: PACKAGE_ID }),
    })).json();
    const paid = JSON.stringify({
      type: 'ORDER_PAID_SUCCESS',
      data: { order: { order_id: created.orderId, order_amount: '2360.00' } },
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
    method: 'POST', headers: { ...gstAdmin, 'content-type': 'application/json' }, body: JSON.stringify({ packageId: PACKAGE_ID }),
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
    assert.deepEqual(quote.quote.components.map((c) => [c.name, c.paise]), [['IGST', PACKAGE_GST_PAISE]]);
    assert.equal(quote.quote.placeOfSupply.type, 'interstate');
    assert.equal(quote.quote.placeOfSupply.stateCode, '29');
    assert.equal(quote.quote.placeOfSupply.assumed, false);
    assert.equal(quote.quote.totalInr, '2360.00', 'same total, different split — 18% either way');

    const blank = await putConfig({ paymentInfo: { taxId: '' } });
    assert.equal(blank.status, 200);
    const assumed = await (await recharge()).json();
    assert.equal(assumed.quote.placeOfSupply.assumed, true, 'a cleared GSTIN goes back to an assumed intrastate split, visibly');
  } finally {
    await server.close();
  }
});

// Recharge runs only as a scheduled Cloud Run Job; the service no longer exposes
// a route that can start a charge.
test('the service has no recharge tick route', async () => {
  const server = await listen(createApp());
  try {
    const res = await fetch(`${server.url}/pubsub/billing-recharge-tick`, { method: 'POST' });
    assert.notEqual(res.status, 200);
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
      body: JSON.stringify({ packageId: PACKAGE_ID }),
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
