'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The store is the real one, pointed at a temp dir: the intent lifecycle (created
// once, settled once, money frozen after) is part of what is being proved, and a
// mocked store would prove the mock instead.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-settle-'));
process.env.AI_FLEET_DATA_DIR = TMP_DIR;
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const store = require('@ai-fleet/shared-core/store');
const gst = require('@ai-fleet/shared-core/billing/gst');
const moneyWire = require('@ai-fleet/shared-core/billing/money-wire');
const { settle, allowsMockPayments } = require('./recharge-settle');

const ORG = 'org-a';
const OTHER = 'org-b';
const GUJARAT = '24';
const KARNATAKA = '29';
const QUIET = { info() {}, warn() {}, error() {} };

let seq = 0;

/** Build an intent exactly the way the quote route does: derived, never hand-typed. */
function makeIntent(overrides = {}) {
  const subtotalPaise = overrides.subtotalPaise == null ? 50000 : overrides.subtotalPaise;
  const couponBps = overrides.couponBps || 0;
  const quote = gst.quote({
    subtotalPaise,
    couponBps,
    supplierStateCode: GUJARAT,
    ...(overrides.customerGstin ? { customerGstin: overrides.customerGstin } : {}),
    ...(overrides.customerStateCode ? { customerStateCode: overrides.customerStateCode } : {}),
  });
  seq += 1;
  return store.addRechargeIntent({
    orderId: `order_${ORG}_${seq}`,
    orgId: ORG,
    provider: 'cashfree',
    subtotalPaise,
    couponBps,
    bonusPaise: quote.bonusPaise || 0,
    gstPaise: quote.gstPaise,
    totalPaise: quote.totalPaise,
    creditCount: moneyWire.paiseToCredits(subtotalPaise),
    supplierStateCode: GUJARAT,
    placeOfSupply: quote.placeOfSupply,
    ...overrides.record,
  });
}

function fakeProviders(adapter) {
  return { providerFor: () => adapter };
}

function fakeAdapter({ configured = true, status = 'PAID', amountDecimal = '590.00', providerOrderId = 'cf_9' } = {}) {
  const calls = [];
  const adapter = {
    name: 'cashfree',
    isConfigured: () => configured,
    verify: async (id) => { calls.push(id); return { status, amountDecimal, providerOrderId, mock: !configured }; },
    calls,
  };
  return adapter;
}

/**
 * A stand-in for the measured wallet: integer credits, a real-time balance read,
 * and idempotency-key replay returning `already_exists` the way FlexPrice does.
 */
function fakeFlexprice({ opening = 500, conversionRate = '1', creditOnTopUp = true, customerMissing = false } = {}) {
  const seen = new Set();
  const state = { balance: opening, topUps: [], grants: [], creates: { customers: 0, wallets: 0 } };
  return {
    state,
    getCustomerByExternalId: async (externalId) => {
      if (customerMissing) { const err = new Error('not found'); err.status = 404; throw err; }
      return { id: 'cust_1', external_id: externalId };
    },
    createCustomer: async (body) => { state.creates.customers += 1; state.customerBody = body; return { id: 'cust_1', ...body }; },
    listWalletsByCustomer: async () => ({
      // `currency` is reported lower-case by the live route, so the match that
      // decides "this org already has a wallet" has to be case-insensitive.
      items: conversionRate === null ? [] : [{ id: 'wallet_1', currency: 'inr', wallet_type: 'PRE_PAID', conversion_rate: conversionRate }],
    }),
    createWallet: async (body) => { state.creates.wallets += 1; return { id: 'wallet_1', ...body }; },
    walletRealTimeBalance: async () => ({ real_time_credit_balance: state.balance }),
    topUpWallet: async (walletId, body, opts = {}) => {
      state.topUps.push({ walletId, body, idempotencyKey: opts.idempotencyKey });
      if (seen.has(opts.idempotencyKey)) return { alreadyExists: true };
      seen.add(opts.idempotencyKey);
      if (creditOnTopUp) state.balance += Number(body.credits_to_add);
      return { id: 'wtxn_1' };
    },
    grantPromo: async (walletId, opts = {}) => {
      state.grants.push({ walletId, ...opts });
      if (seen.has(opts.idempotencyKey)) return { alreadyExists: true };
      seen.add(opts.idempotencyKey);
      if (creditOnTopUp) state.balance += Number(opts.credits);
      return { id: 'wtxn_2' };
    },
  };
}

function settleWith(intent, { adapter, client, config, env, callerOrgId = ORG, actor = 'test' } = {}) {
  return settle({ orderId: intent.orderId, orgId: callerOrgId, actor }, {
    store,
    providers: fakeProviders(adapter || fakeAdapter({ amountDecimal: moneyWire.decimalFromPaise(intent.totalPaise) })),
    flexpriceClient: client || fakeFlexprice(),
    flexpriceConfig: config || { enabled: true, supplierStateCode: GUJARAT },
    env: env || {},
    log: QUIET,
    now: () => '2026-11-12T10:00:00.000Z',
  });
}

const expectRefused = (promise, code, status) => assert.rejects(promise, (err) => {
  assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
  assert.equal(err.status, status);
  return true;
});

// --- the headline number ------------------------------------------------------

test('a ₹500 recharge collects ₹590 and credits 500 spendable credits', async () => {
  const intent = makeIntent({ customerStateCode: GUJARAT });
  assert.deepEqual(
    { subtotal: intent.subtotalPaise, gst: intent.gstPaise, total: intent.totalPaise, credits: intent.creditCount },
    { subtotal: 50000, gst: 9000, total: 59000, credits: 500 },
  );

  const client = fakeFlexprice({ opening: 500 });
  const adapter = fakeAdapter({ amountDecimal: '590.00' });
  const result = await settleWith(intent, { adapter, client });

  assert.deepEqual(result, {
    status: 'settled',
    orderId: intent.orderId,
    orgId: ORG,
    provider: 'cashfree',
    subtotalPaise: 50000,
    gstPaise: 9000,
    totalPaise: 59000,
    collectedPaise: 59000,
    creditCount: 500,
    promoCredits: 0,
    balanceCredits: 1000,
    walletId: 'wallet_1',
    mock: false,
    settledAt: '2026-11-12T10:00:00.000Z',
  });

  // The credit base is the subtotal, and the only way to see that the ₹90 stayed
  // out of it is to look at what was sent and what the balance became.
  assert.equal(client.state.topUps.length, 1);
  assert.equal(client.state.topUps[0].body.credits_to_add, '500');
  assert.notEqual(client.state.topUps[0].body.credits_to_add, String(moneyWire.paiseToCredits(intent.totalPaise)),
    'crediting the taxed total would hand back the ₹90 as spendable credit');
  assert.equal(client.state.balance, 1000, '500 in, not 590 — the tax is collected, never credited');
  assert.equal(client.state.topUps[0].idempotencyKey, `recharge:${intent.orderId}`);
  assert.equal(client.state.topUps[0].body.transaction_reason, 'PURCHASED_CREDIT_DIRECT');
  assert.equal(client.state.topUps[0].body.metadata.gst_paise, '9000', 'the tax rides along with the credit for the audit trail');

  const settled = store.getRechargeIntent(intent.orderId);
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.settledAt, '2026-11-12T10:00:00.000Z');
  assert.equal(settled.providerOrderId, 'cf_9');
  assert.equal(settled.flexprice_settlement.balanceAfterCredits, 1000);
  assert.equal(store.getBillingAccount(ORG).flexprice.walletId, 'wallet_1', 'the wallet ids are cached for the next settle and for the Phase 3 gate');
});

test('the org is provisioned in FlexPrice on first settle, with the flat address fields', async () => {
  store.upsertBillingAccount(ORG, {
    paymentInfo: {
      billingName: 'Acme Pvt Ltd',
      taxId: '24AAAAA0000A1Z5',
      address: { line1: '5 Cross Rd', city: 'Ahmedabad', state: 'Gujarat', postalCode: '380001', country: 'IN' },
    },
  });
  const intent = makeIntent();
  const client = fakeFlexprice({ customerMissing: true, conversionRate: null });
  await settleWith(intent, { client });

  assert.equal(client.state.creates.customers, 1);
  assert.equal(client.state.creates.wallets, 1);
  const body = client.state.customerBody;
  assert.equal(body.address_state, 'Gujarat', 'the place of supply is read from the FLAT address_state; nested billing_address is accepted at 201 and silently dropped');
  assert.equal(body.address_line1, '5 Cross Rd');
  assert.equal(body.address_country, 'IN');
  assert.equal(body.external_id, ORG);
  assert.equal(body.metadata.gstin, '24AAAAA0000A1Z5', 'the GSTIN reaches FlexPrice, which is where Zoho reads it from');
  assert.equal(body.billing_address, undefined);
});

test('a second recharge for the same org reuses its wallet rather than creating one', async () => {
  // The live `GET /v1/customers/:id/wallets` answers a bare array with lower-case
  // currency, and a wallet that already exists answers 409 `already_exists` — which
  // the client maps to `{alreadyExists:true}` with NO id. Missing the existing
  // wallet therefore does not fail: it credits wallet `undefined`, and the second
  // recharge of any org would die at the balance read. This is the regression the
  // first live run of scripts/flexprice-recharge-verify.js caught.
  const client = fakeFlexprice({ opening: 0 });
  const first = await settleWith(makeIntent(), { client });
  const second = await settleWith(makeIntent({ subtotalPaise: 100000 }), { client });

  assert.equal(client.state.creates.wallets, 0, 'the provisioned wallet is found, not re-created');
  assert.deepEqual(
    { firstWallet: first.walletId, secondWallet: second.walletId, firstCredits: first.creditCount, secondCredits: second.creditCount },
    { firstWallet: 'wallet_1', secondWallet: 'wallet_1', firstCredits: 500, secondCredits: 1000 },
  );
  assert.equal(second.balanceCredits, 1500, 'the two recharges land in one wallet');
});

// An org that has never opened the billing page has no account document, so
// `account && account.paymentInfo` is `null` — which a `= {}` default parameter
// does not replace. The first `npm run billing:usage:verify` run hit exactly this
// and died with a 500 on `paymentInfo.address`.
test('an org with no billing account at all still settles, with placeholder address fields', async () => {
  const freshOrg = 'org-never-opened-billing';
  assert.equal(store.getBillingAccount(freshOrg), null, 'the precondition: no account document');
  const intent = makeIntent({ record: { orgId: freshOrg } });
  const client = fakeFlexprice({ customerMissing: true });

  const r = await settle({ orderId: intent.orderId, orgId: freshOrg }, {
    store,
    providers: fakeProviders(fakeAdapter({ amountDecimal: '590.00' })),
    flexpriceClient: client,
    flexpriceConfig: { enabled: true, supplierStateCode: GUJARAT },
    env: {},
    log: QUIET,
  });

  assert.equal(r.status, 'settled');
  assert.equal(r.creditCount, 500);
  assert.equal(client.state.customerBody.address_line1, 'Not provided');
  assert.equal(client.state.customerBody.address_country, 'IN');
  assert.equal(client.state.customerBody.metadata.gstin, '', 'an absent GSTIN is an empty string, never "undefined"');
});

test('a wallet that cannot be resolved is a refusal, not a credit to wallet undefined', async () => {
  const client = fakeFlexprice({ conversionRate: null });
  client.createWallet = async () => ({ alreadyExists: true, status: 409, detail: {} });
  await assert.rejects(settleWith(makeIntent(), { client }), (err) => {
    assert.equal(err.code, 'flexprice_wallet_unresolved');
    assert.equal(err.status, 502);
    return true;
  });
  assert.equal(client.state.topUps.length, 0, 'nothing is credited when there is no wallet to credit');
});

// --- exactly once -------------------------------------------------------------

test('replaying the settlement credits once', async () => {
  const intent = makeIntent();
  const client = fakeFlexprice();
  const adapter = fakeAdapter({ amountDecimal: '590.00' });

  const first = await settleWith(intent, { adapter, client });
  const second = await settleWith(intent, { adapter, client });

  assert.equal(first.status, 'settled');
  assert.deepEqual(
    { status: second.status, creditCount: second.creditCount, totalPaise: second.totalPaise },
    { status: 'already_processed', creditCount: 500, totalPaise: 59000 },
  );
  assert.equal(client.state.topUps.length, 1);
  assert.equal(adapter.calls.length, 1, 'a settled order is not re-verified either');
  assert.equal(client.state.balance, 1000);
});

test('a retry after FlexPrice took the credit but before we recorded it does not double-credit', async () => {
  const intent = makeIntent();
  const client = fakeFlexprice();
  const adapter = fakeAdapter({ amountDecimal: '590.00' });
  await settleWith(intent, { adapter, client });

  // Simulate the crash: the wallet has the credit, the intent says QUOTED again.
  store.updateRechargeIntent(intent.orderId, { status: 'QUOTED', settledAt: null });
  const retry = await settleWith(intent, { adapter, client });

  assert.equal(retry.status, 'settled');
  assert.equal(client.state.topUps.length, 2, 'the write was attempted twice — that is what the key is for');
  assert.equal(client.state.balance, 1000, 'and FlexPrice answered already_exists, so it landed once');
  assert.equal(store.getRechargeIntent(intent.orderId).flexprice_settlement.replayTopUp, true);
});

// --- the security hole this closes -------------------------------------------

test('another org cannot settle my order', async () => {
  const intent = makeIntent();
  const client = fakeFlexprice();
  const adapter = fakeAdapter({ amountDecimal: '590.00' });
  await expectRefused(settleWith(intent, { adapter, client, callerOrgId: OTHER }), 'order_not_mine', 403);
  assert.equal(adapter.calls.length, 0, 'refused before anything is asked of the gateway');
  assert.equal(client.state.topUps.length, 0);
  assert.equal(store.getRechargeIntent(intent.orderId).status, 'QUOTED');
});

test('an order this server never quoted is refused', async () => {
  const ghost = { orderId: 'order_org_victim_1', totalPaise: 59000 };
  await expectRefused(
    settle({ orderId: ghost.orderId, orgId: ORG }, {
      store, providers: fakeProviders(fakeAdapter()), flexpriceClient: fakeFlexprice(),
      flexpriceConfig: { enabled: true, supplierStateCode: GUJARAT }, env: {}, log: QUIET,
    }),
    'intent_not_found', 404,
  );
});

test('the webhook settles the intent owner, not whoever delivered the event', async () => {
  const intent = makeIntent();
  const client = fakeFlexprice();
  const result = await settleWith(intent, { client, callerOrgId: null });
  assert.equal(result.orgId, ORG);
  assert.equal(client.state.balance, 1000);
});

// --- the amount is the intent's ----------------------------------------------

test('a gateway that collected a different amount settles nothing', async () => {
  const intent = makeIntent();
  const client = fakeFlexprice();
  await expectRefused(
    settleWith(intent, { client, adapter: fakeAdapter({ amountDecimal: '100.00' }) }),
    'amount_mismatch', 402,
  );
  assert.equal(client.state.topUps.length, 0, 'the old path credited whatever the provider echoed');
  assert.equal(store.getRechargeIntent(intent.orderId).status, 'QUOTED');
});

test('a payment the provider has not captured settles nothing', async () => {
  const intent = makeIntent();
  await expectRefused(
    settleWith(intent, { adapter: fakeAdapter({ status: 'PENDING', amountDecimal: '0.00' }) }),
    'payment_not_captured', 402,
  );
});

test('an intent whose totals no longer recompute is refused rather than repriced', async () => {
  const intent = makeIntent();
  const tampered = store.addRechargeIntent({
    ...intent,
    orderId: `${intent.orderId}_drift`,
    id: undefined,
    totalPaise: 54500, // as if GST had been discounted after the quote
  });
  await expectRefused(settleWith(tampered), 'quote_drift', 500);
});

test('a GST that cannot be recomputed without config fails closed, not as untaxed', async () => {
  // The intent normally carries its own supplier state, so this is the record
  // made before that field existed: the only place to look is config, and config
  // is empty.
  const quoted = makeIntent();
  const noSupplier = store.addRechargeIntent({
    ...quoted,
    id: undefined,
    orderId: `${quoted.orderId}_legacy`,
    supplierStateCode: undefined,
  });
  await expectRefused(
    settleWith(noSupplier, { config: { enabled: true, supplierStateCode: '' } }),
    'supplier_state_not_configured', 503,
  );
});

test('a subtotal that is not a whole number of rupees is refused', async () => {
  // 1 credit = ₹1 (D6), so 50050p has no representation in the wallet. The route
  // rejects such an amount on the way in; this is the guard for a record that
  // arrived some other way.
  const odd = gst.quote({ subtotalPaise: 50050, supplierStateCode: GUJARAT, customerStateCode: GUJARAT });
  const intent = makeIntent();
  const bad = store.addRechargeIntent({
    ...intent,
    id: undefined,
    orderId: `${intent.orderId}_odd`,
    subtotalPaise: 50050,
    gstPaise: odd.gstPaise,
    totalPaise: odd.totalPaise,
    creditCount: 500,
  });
  await expectRefused(settleWith(bad), 'not_whole_credit', 400);
});

test('the store freezes an intent money, so a settled order cannot be repriced', () => {
  const intent = makeIntent();
  const after = store.updateRechargeIntent(intent.orderId, {
    subtotalPaise: 59000, gstPaise: 0, totalPaise: 59000, creditCount: 590, couponBps: 5000, bonusPaise: 25000, orgId: OTHER,
  });
  assert.deepEqual(
    { subtotal: after.subtotalPaise, gst: after.gstPaise, total: after.totalPaise, credits: after.creditCount, coupon: after.couponBps, bonus: after.bonusPaise, org: after.orgId },
    { subtotal: 50000, gst: 9000, total: 59000, credits: 500, coupon: 0, bonus: 0, org: ORG },
  );
});

test('a GSTIN saved after the quote is only drift if it changes the money', async () => {
  // 18% is 9000p whether it arrives as CGST+SGST or as IGST, so an org that
  // completes its GSTIN between quoting and paying still settles the ₹590 it was
  // shown. The check compares amounts, not labels.
  const quoted = makeIntent({ customerStateCode: GUJARAT });
  const withGstin = store.addRechargeIntent({
    ...quoted,
    id: undefined,
    orderId: `${quoted.orderId}_interstate`,
    customerGstin: `${KARNATAKA}AAAAA0000A1Z5`,
  });
  const result = await settleWith(withGstin);
  assert.equal(result.status, 'settled');
  assert.equal(result.totalPaise, 59000);
});

// --- the two gates ------------------------------------------------------------

test('the mock flag is read as a value, not as mere presence', () => {
  // `BILLING_ALLOW_MOCK_PAYMENTS=false` in a compose file is an operator saying
  // no; treating it as truthy would turn the one dev-only gate into a default on.
  assert.equal(allowsMockPayments({}), false);
  assert.equal(allowsMockPayments({ BILLING_ALLOW_MOCK_PAYMENTS: '' }), false);
  assert.equal(allowsMockPayments({ BILLING_ALLOW_MOCK_PAYMENTS: 'false' }), false);
  assert.equal(allowsMockPayments({ BILLING_ALLOW_MOCK_PAYMENTS: '0' }), false);
  assert.equal(allowsMockPayments({ BILLING_ALLOW_MOCK_PAYMENTS: ' TRUE ' }), true);
});

test('an unconfigured gateway is refused unless the dev mock flag is on', async () => {
  const intent = makeIntent();
  const refused = fakeFlexprice();
  await expectRefused(
    settleWith(intent, { client: refused, adapter: fakeAdapter({ configured: false }) }),
    'mock_payment_not_accepted', 402,
  );
  assert.equal(refused.state.topUps.length, 0);

  // With the flag, the intent — not the mock's canned ₹100 — is the amount.
  const client = fakeFlexprice();
  const result = await settleWith(intent, {
    client,
    adapter: fakeAdapter({ configured: false }),
    env: { BILLING_ALLOW_MOCK_PAYMENTS: 'true' },
  });
  assert.equal(result.mock, true);
  assert.equal(result.collectedPaise, 59000, 'the mock reports the intent total, so the amount check still means something');
  assert.equal(client.state.topUps[0].body.credits_to_add, '500');
});

test('with FlexPrice disabled there is no credit at all — and the gateway is not consulted', async () => {
  const intent = makeIntent();
  const adapter = fakeAdapter({ amountDecimal: '590.00' });
  const client = fakeFlexprice();
  await expectRefused(
    settleWith(intent, { adapter, client, config: { enabled: false, supplierStateCode: GUJARAT }, env: { BILLING_ALLOW_MOCK_PAYMENTS: 'true' } }),
    'flexprice_disabled', 503,
  );
  assert.equal(adapter.calls.length, 0, 'no point verifying a payment this deployment cannot credit');
  assert.equal(client.state.topUps.length, 0);
});

test('a wallet whose conversion_rate is not 1 is refused before the credit', async () => {
  const intent = makeIntent();
  const client = fakeFlexprice({ conversionRate: '2' });
  await expectRefused(settleWith(intent, { client }), 'wallet_conversion_rate', 500);
  assert.equal(client.state.topUps.length, 0, 'at rate 2 a 500-credit top-up is ₹1,000 of value');
});

test('a read-back that disagrees with the credit is not marked settled', async () => {
  const intent = makeIntent();
  const client = fakeFlexprice({ creditOnTopUp: false });
  await expectRefused(settleWith(intent, { client }), 'flexprice_credit_readback_mismatch', 502);
  assert.equal(store.getRechargeIntent(intent.orderId).status, 'QUOTED');
});

// --- coupons -----------------------------------------------------------------

test('a 10% coupon credits a second, expiring row and charges the same ₹590', async () => {
  const intent = makeIntent({ couponBps: 1000, record: { promoExpiresAt: '2027-03-31T23:59:59.000Z' } });
  assert.equal(intent.bonusPaise, 5000);
  assert.equal(intent.totalPaise, 59000, 'a bonus is given away, not discounted out of the tax');

  const client = fakeFlexprice();
  const result = await settleWith(intent, { client, adapter: fakeAdapter({ amountDecimal: '590.00' }) });

  assert.equal(result.creditCount, 500);
  assert.equal(result.promoCredits, 50);
  assert.equal(client.state.topUps[0].body.credits_to_add, '500');
  assert.deepEqual(
    client.state.grants.map((g) => [g.credits, g.expiresAt, g.idempotencyKey]),
    [[50, '2027-03-31T23:59:59.000Z', `recharge:${intent.orderId}:promo`]],
    'the bonus is a FREE_CREDIT_GRANT with its own key, never bonus_credits_to_add',
  );
  assert.equal(client.state.balance, 1050);
});

// --- inter-state -------------------------------------------------------------

test('an interstate customer is IGST at the same total, and settles identically', async () => {
  const intent = makeIntent({ customerGstin: `${KARNATAKA}AAAAA0000A1Z5` });
  assert.equal(intent.gstPaise, 9000);
  assert.equal(intent.totalPaise, 59000);
  const client = fakeFlexprice();
  const result = await settleWith(intent, { client, adapter: fakeAdapter({ amountDecimal: '590.00' }) });
  assert.equal(result.creditCount, 500);
  assert.equal(client.state.balance, 1000);
});
