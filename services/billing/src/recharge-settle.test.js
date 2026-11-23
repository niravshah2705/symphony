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
process.env.SOFTWARE_FACTORY_DATA_DIR = TMP_DIR;
test.after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const store = require('@software-factory/shared-core/store');
const gst = require('@software-factory/shared-core/billing/gst');
const moneyWire = require('@software-factory/shared-core/billing/money-wire');
const { settle, allowsMockPayments } = require('./recharge-settle');

const ORG = 'org-a';
const OTHER = 'org-b';
const GUJARAT = '24';
const KARNATAKA = '29';
const QUIET = { info() {}, warn() {}, error() {} };
const DAY_MS = 86400000;

let seq = 0;

/**
 * The card's two offers, restated here as the numbers a settled order must reproduce
 * (deploy/billing/credit-rates.yaml). They are DERIVED below from `gst.quote`, never
 * copied from it by hand — the literal constants are the assertion that the derivation
 * matches what the purchase page advertises.
 *
 *   credits-3500:  ₹2,000 + CGST ₹180 + SGST ₹180 = ₹2,360 charged, 3,500 credits landed
 *   credits-10000: ₹4,000 + IGST/CGST+SGST ₹720    = ₹4,720 charged, 10,000 credits landed
 */
const PKG = Object.freeze({
  id: 'credits-3500', priceInr: 2000, subtotalPaise: 200000, couponBps: 7500,
  bonusTokenCredits: 150000, gstPaise: 36000, totalPaise: 236000, amountDecimal: '2360.00',
  prepaidCredits: 2000, bonusCredits: 1500, totalCredits: 3500, bonusValidDays: 30,
});
const PKG_10K = Object.freeze({
  id: 'credits-10000', priceInr: 4000, subtotalPaise: 400000, couponBps: 15000,
  bonusTokenCredits: 600000, gstPaise: 72000, totalPaise: 472000, amountDecimal: '4720.00',
  prepaidCredits: 4000, bonusCredits: 6000, totalCredits: 10000, bonusValidDays: 45,
});

// `settleWith` fixes the clock at 10:00 on 2026-11-12, so an order quoted at 09:00 the
// same morning has a bonus window that is comfortably open — and one whose expiry an
// expiry test can push before or after that minute deliberately.
const ORDERED_AT = '2026-11-12T09:00:00.000Z';

/**
 * Build an intent exactly the way `createRechargeOrder` does: from a package, with the
 * offer's identity (id, window, expiry) frozen onto the record alongside the money.
 */
function makeIntent(overrides = {}) {
  const pkg = overrides.pkg || PKG;
  const subtotalPaise = overrides.subtotalPaise == null ? pkg.subtotalPaise : overrides.subtotalPaise;
  const couponBps = overrides.couponBps == null ? pkg.couponBps : overrides.couponBps;
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
    createdAt: ORDERED_AT,
    packageId: pkg.id,
    bonusValidDays: pkg.bonusValidDays,
    promoExpiresAt: new Date(Date.parse(ORDERED_AT) + pkg.bonusValidDays * DAY_MS).toISOString(),
    subtotalPaise,
    couponBps,
    bonusTokenCredits: quote.bonusTokenCredits || 0,
    gstPaise: quote.gstPaise,
    totalPaise: quote.totalPaise,
    creditCount: moneyWire.tokenCreditsToCredits(subtotalPaise),
    supplierStateCode: GUJARAT,
    // The same two conditionals `createRechargeOrder` writes: a GSTIN is recorded only
    // when there was one, and a customer state only when the place of supply was a fact
    // rather than the supplier-state default. `requote` reads both back.
    ...(overrides.customerGstin ? { customerGstin: overrides.customerGstin } : {}),
    ...(!quote.placeOfSupply.assumed ? { customerStateCode: quote.placeOfSupply.stateCode } : {}),
    placeOfSupply: quote.placeOfSupply,
    ...overrides.record,
  });
}

/** A second intent that shares one record's inputs but tampers with others. */
function tamper(intent, suffix, fields) {
  return store.addRechargeIntent({
    ...intent,
    id: undefined,
    orderId: `${intent.orderId}_${suffix}`,
    ...fields,
  });
}

function fakeProviders(adapter) {
  return { providerFor: () => adapter };
}

function fakeAdapter({ configured = true, status = 'PAID', amountDecimal = PKG.amountDecimal, providerOrderId = 'cf_9' } = {}) {
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
function fakeFlexprice({ opening = 1000, conversionRate = '1', creditOnTopUp = true, customerMissing = false } = {}) {
  const seen = new Set();
  const state = { balance: opening, topUps: [], grants: [], creates: { customers: 0, wallets: 0 } };
  return {
    state,
    getCustomerByExternalId: async (externalId) => {
      if (customerMissing) { const err = new Error('not found'); err.status = 404; throw err; }
      return { id: 'cust_1', externalId: externalId };
    },
    createCustomer: async (body) => { state.creates.customers += 1; state.customerBody = body; return { id: 'cust_1', ...body }; },
    listWalletsByCustomer: async () => ({
      // `currency` is reported lower-case by the live route, so the match that
      // decides "this org already has a wallet" has to be case-insensitive.
      items: conversionRate === null ? [] : [{ id: 'wallet_1', currency: 'inr', walletType: 'PRE_PAID', conversionRate: conversionRate }],
    }),
    createWallet: async (body) => { state.creates.wallets += 1; return { id: 'wallet_1', ...body }; },
    walletRealTimeBalance: async () => ({ realTimeCreditBalance: state.balance }),
    topUpWallet: async (walletId, body, opts = {}) => {
      state.topUps.push({ walletId, body, idempotencyKey: opts.idempotencyKey });
      if (seen.has(opts.idempotencyKey)) return { alreadyExists: true };
      seen.add(opts.idempotencyKey);
      if (creditOnTopUp) state.balance += Number(body.creditsToAdd);
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

test('a ₹2,000 package collects ₹2,360 incl. GST and credits 3,500 spendable credits', async () => {
  const intent = makeIntent({ customerStateCode: GUJARAT });
  assert.deepEqual(
    {
      package: intent.packageId, subtotal: intent.subtotalPaise, coupon: intent.couponBps,
      bonus: intent.bonusTokenCredits, gst: intent.gstPaise, total: intent.totalPaise,
      prepaid: intent.creditCount, validDays: intent.bonusValidDays,
    },
    {
      package: PKG.id, subtotal: PKG.subtotalPaise, coupon: PKG.couponBps,
      bonus: PKG.bonusTokenCredits, gst: PKG.gstPaise, total: PKG.totalPaise,
      prepaid: PKG.prepaidCredits, validDays: PKG.bonusValidDays,
    },
    'the card advertises ₹2,000 → 3,500 credits; the intent must freeze exactly that offer',
  );
  assert.equal(intent.promoExpiresAt, '2026-12-12T09:00:00.000Z', 'the window is the package\'s 30 days from the order');

  const client = fakeFlexprice({ opening: 1000 });
  const adapter = fakeAdapter({ amountDecimal: PKG.amountDecimal });
  const result = await settleWith(intent, { adapter, client });

  assert.deepEqual(result, {
    status: 'settled',
    orderId: intent.orderId,
    orgId: ORG,
    provider: 'cashfree',
    packageId: PKG.id,
    subtotalPaise: PKG.subtotalPaise,
    gstPaise: PKG.gstPaise,
    totalPaise: PKG.totalPaise,
    collectedPaise: PKG.totalPaise,
    creditCount: PKG.prepaidCredits,
    promoCredits: PKG.bonusCredits,
    bonusSkipped: null,
    promoExpiresAt: intent.promoExpiresAt,
    balanceCredits: 1000 + PKG.totalCredits,
    walletId: 'wallet_1',
    mock: false,
    settledAt: '2026-11-12T10:00:00.000Z',
  });

  // The credit base is the subtotal, and the only way to see that the ₹360 stayed
  // out of it is to look at what was sent and what the balance became.
  assert.equal(client.state.topUps.length, 1);
  assert.equal(client.state.topUps[0].body.creditsToAdd, '2000');
  assert.notEqual(client.state.topUps[0].body.creditsToAdd, String(moneyWire.tokenCreditsToCredits(intent.totalPaise)),
    'crediting the taxed total would hand back the ₹360 as spendable credit');
  assert.deepEqual(
    client.state.grants.map((g) => [g.credits, g.expiresAt, g.idempotencyKey]),
    [[PKG.bonusCredits, intent.promoExpiresAt, `recharge:${intent.orderId}:promo`]],
    'the bonus is a separate expiring grant with its own idempotency key',
  );
  assert.equal(client.state.balance, 4500, '3,500 in — the two credit rows are the advertised total, not ₹2,360');
  assert.equal(intent.totalPaise - intent.gstPaise, PKG.prepaidCredits * 100,
    'collected minus GST is the prepaid credit base, with the bonus outside the identity');
  assert.equal(client.state.topUps[0].idempotencyKey, `recharge:${intent.orderId}`);
  assert.equal(client.state.topUps[0].body.transactionReason, 'PURCHASED_CREDIT_DIRECT');
  assert.equal(client.state.topUps[0].body.metadata.gst_paise, '36000', 'the tax rides along with the credit for the audit trail');

  const settled = store.getRechargeIntent(intent.orderId);
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.settledAt, '2026-11-12T10:00:00.000Z');
  assert.equal(settled.providerOrderId, 'cf_9');
  assert.equal(settled.flexprice_settlement.balanceAfterCredits, 4500);
  assert.equal(settled.flexprice_settlement.promoCredits, PKG.bonusCredits);
  assert.equal(store.getBillingAccount(ORG).flexprice.walletId, 'wallet_1', 'the wallet ids are cached for the next settle and for the Phase 3 gate');
});

test('the ₹4,000 package needs the 150% bonus the pre-package GST cap refused', async () => {
  const intent = makeIntent({ pkg: PKG_10K, customerStateCode: GUJARAT });
  assert.deepEqual(
    { coupon: intent.couponBps, bonus: intent.bonusTokenCredits, gst: intent.gstPaise, total: intent.totalPaise },
    { coupon: PKG_10K.couponBps, bonus: PKG_10K.bonusTokenCredits, gst: PKG_10K.gstPaise, total: PKG_10K.totalPaise },
  );
  const client = fakeFlexprice({ opening: 0 });
  const result = await settleWith(intent, { client });
  assert.equal(result.creditCount, PKG_10K.prepaidCredits);
  assert.equal(result.promoCredits, PKG_10K.bonusCredits);
  assert.equal(client.state.balance, PKG_10K.totalCredits, 'the whole advertised 10,000 lands');
  assert.equal(PKG_10K.totalPaise - PKG_10K.gstPaise, PKG_10K.prepaidCredits * 100);
});

test('a legacy intent with no coupon credits one row and grants no bonus', async () => {
  // What a pre-package order looks like: no package identity, no bonus, no expiry.
  const intent = makeIntent({ couponBps: 0, record: { packageId: null, bonusValidDays: null, promoExpiresAt: null } });
  assert.equal(intent.bonusTokenCredits, 0);
  const client = fakeFlexprice({ opening: 1000 });
  const result = await settleWith(intent, { client });
  assert.equal(result.packageId, null, 'an order that predates packages reports no package, not an invented one');
  assert.equal(result.promoCredits, 0);
  assert.equal(result.creditCount, 2000, '₹2,000 of prepaid credit still settles at ₹2,360 collected');
  assert.equal(client.state.grants.length, 0);
  assert.equal(client.state.balance, 3000);
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
  assert.equal(body.addressState, 'Gujarat', 'the place of supply is read from the FLAT addressState; nested billing_address is accepted at 201 and silently dropped');
  assert.equal(body.addressLine1, '5 Cross Rd');
  assert.equal(body.addressCountry, 'IN');
  assert.equal(body.externalId, ORG);
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
  const first = await settleWith(makeIntent({ pkg: PKG }), { client });
  const second = await settleWith(makeIntent({ pkg: PKG_10K }), { client });

  assert.equal(client.state.creates.wallets, 0, 'the provisioned wallet is found, not re-created');
  assert.deepEqual(
    { firstWallet: first.walletId, secondWallet: second.walletId, firstPackage: first.packageId, secondPackage: second.packageId, firstCredits: first.creditCount + first.promoCredits, secondCredits: second.creditCount + second.promoCredits },
    { firstWallet: 'wallet_1', secondWallet: 'wallet_1', firstPackage: PKG.id, secondPackage: PKG_10K.id, firstCredits: PKG.totalCredits, secondCredits: PKG_10K.totalCredits },
  );
  assert.equal(second.balanceCredits, PKG.totalCredits + PKG_10K.totalCredits, 'the two packages land in one wallet');
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
    providers: fakeProviders(fakeAdapter({ amountDecimal: PKG.amountDecimal })),
    flexpriceClient: client,
    flexpriceConfig: { enabled: true, supplierStateCode: GUJARAT },
    env: {},
    log: QUIET,
  });

  assert.equal(r.status, 'settled');
  assert.equal(r.creditCount, PKG.prepaidCredits);
  assert.equal(client.state.customerBody.addressLine1, 'Not provided');
  assert.equal(client.state.customerBody.addressCountry, 'IN');
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

test('replaying the settlement credits once, and reports what landed', async () => {
  const intent = makeIntent();
  const client = fakeFlexprice({ opening: 1000 });
  const adapter = fakeAdapter({ amountDecimal: PKG.amountDecimal });

  const first = await settleWith(intent, { adapter, client });
  const second = await settleWith(intent, { adapter, client });

  assert.equal(first.status, 'settled');
  assert.deepEqual(
    {
      status: second.status, package: second.packageId, creditCount: second.creditCount,
      promoCredits: second.promoCredits, totalPaise: second.totalPaise,
    },
    { status: 'already_processed', package: PKG.id, creditCount: PKG.prepaidCredits, promoCredits: PKG.bonusCredits, totalPaise: PKG.totalPaise },
  );
  assert.equal(client.state.topUps.length, 1);
  assert.equal(client.state.grants.length, 1, 'the bonus is not re-granted either');
  assert.equal(adapter.calls.length, 1, 'a settled order is not re-verified either');
  assert.equal(client.state.balance, 4500);
});

test('a retry after FlexPrice took the credit but before we recorded it does not double-credit', async () => {
  const intent = makeIntent();
  const client = fakeFlexprice({ opening: 1000 });
  const adapter = fakeAdapter({ amountDecimal: PKG.amountDecimal });
  await settleWith(intent, { adapter, client });

  // Simulate the crash: the wallet has the credit, the intent says QUOTED again.
  store.updateRechargeIntent(intent.orderId, { status: 'QUOTED', settledAt: null });
  const retry = await settleWith(intent, { adapter, client });

  assert.equal(retry.status, 'settled');
  assert.equal(client.state.topUps.length, 2, 'the write was attempted twice — that is what the key is for');
  assert.equal(client.state.balance, 4500, 'and FlexPrice answered already_exists, so it landed once');
  assert.equal(store.getRechargeIntent(intent.orderId).flexprice_settlement.replayTopUp, true);
});

// --- the security hole this closes -------------------------------------------

test('another org cannot settle my order', async () => {
  const intent = makeIntent();
  const client = fakeFlexprice();
  const adapter = fakeAdapter({ amountDecimal: PKG.amountDecimal });
  await expectRefused(settleWith(intent, { adapter, client, callerOrgId: OTHER }), 'order_not_mine', 403);
  assert.equal(adapter.calls.length, 0, 'refused before anything is asked of the gateway');
  assert.equal(client.state.topUps.length, 0);
  assert.equal(store.getRechargeIntent(intent.orderId).status, 'QUOTED');
});

test('an order this server never quoted is refused', async () => {
  const ghost = { orderId: 'order_org_victim_1', totalPaise: PKG.totalPaise };
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
  const client = fakeFlexprice({ opening: 1000 });
  const result = await settleWith(intent, { client, callerOrgId: null });
  assert.equal(result.orgId, ORG);
  assert.equal(client.state.balance, 4500);
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
  const tampered = tamper(intent, 'drift', { totalPaise: PKG.totalPaise - 10000 });
  await expectRefused(settleWith(tampered), 'quote_drift', 500);
});

test('an intent whose advertised bonus no longer re-derives is refused', async () => {
  // The bonus is the third money number on an order, and it is what the invoice
  // discloses and what the wallet gains. A subtotal + GST pair that still matches
  // while the bonus moved is the customer being handed a different offer than the
  // one they paid for — `quote_drift` cannot see it, so this gate exists.
  const intent = makeIntent();
  const tampered = tamper(intent, 'bonus_drift', { bonusTokenCredits: 100000 });
  await expectRefused(settleWith(tampered), 'bonus_drift', 500);
  const client = fakeFlexprice();
  assert.equal(client.state.grants.length, 0);
});

test('a GST that cannot be recomputed without config fails closed, not as untaxed', async () => {
  // The intent normally carries its own supplier state, so this is the record
  // made before that field existed: the only place to look is config, and config
  // is empty.
  const quoted = makeIntent();
  const noSupplier = tamper(quoted, 'legacy', { supplierStateCode: undefined });
  await expectRefused(
    settleWith(noSupplier, { config: { enabled: true, supplierStateCode: '' } }),
    'supplier_state_not_configured', 503,
  );
});

test('a subtotal that is not a whole number of rupees is refused', async () => {
  // 1 credit = ₹1 (D6), so 50050p has no representation in the wallet. The route
  // rejects a custom amount outright now; this is the guard for a record that
  // arrived some other way.
  const odd = gst.quote({ subtotalPaise: 50050, supplierStateCode: GUJARAT, customerStateCode: GUJARAT });
  const intent = makeIntent();
  const bad = tamper(intent, 'odd', {
    subtotalPaise: 50050, couponBps: 0, bonusTokenCredits: 0,
    gstPaise: odd.gstPaise, totalPaise: odd.totalPaise, creditCount: 500,
  });
  await expectRefused(settleWith(bad), 'not_whole_credit', 400);
});

test('the store freezes intent money and offer identity, so a settled order cannot be repriced', () => {
  const intent = makeIntent({ customerStateCode: GUJARAT });
  const after = store.updateRechargeIntent(intent.orderId, {
    subtotalPaise: 59000, gstPaise: 0, totalPaise: 59000, creditCount: 590,
    couponBps: 5000, bonusTokenCredits: 25000, packageId: 'credits-other',
    bonusValidDays: 365, promoExpiresAt: '2099-01-01T00:00:00.000Z',
    supplierStateCode: KARNATAKA, customerGstin: `${KARNATAKA}AAAAA0000A1Z5`,
    customerStateCode: KARNATAKA, orgId: OTHER,
  });
  assert.deepEqual(
    {
      subtotal: after.subtotalPaise, gst: after.gstPaise, total: after.totalPaise,
      credits: after.creditCount, coupon: after.couponBps, bonus: after.bonusTokenCredits,
      package: after.packageId, validDays: after.bonusValidDays,
      expiresAt: after.promoExpiresAt, supplierState: after.supplierStateCode,
      customerGstin: after.customerGstin ?? null, customerState: after.customerStateCode,
      org: after.orgId,
    },
    {
      subtotal: PKG.subtotalPaise, gst: PKG.gstPaise, total: PKG.totalPaise,
      credits: PKG.prepaidCredits, coupon: PKG.couponBps, bonus: PKG.bonusTokenCredits,
      package: PKG.id, validDays: PKG.bonusValidDays,
      expiresAt: intent.promoExpiresAt, supplierState: GUJARAT,
      customerGstin: null, customerState: GUJARAT,
      org: ORG,
    },
    'the place-of-supply fields decide the CGST/SGST-vs-IGST split, and an interstate swap leaves totalPaise identical — so freezing the totals alone does not freeze the tax',
  );
});

test('a GSTIN saved after the quote is only drift if it changes the money', async () => {
  // 18% is ₹360 whether it arrives as CGST+SGST or as IGST, so an org that
  // completes its GSTIN between quoting and paying still settles the ₹2,360 it was
  // shown. The check compares amounts, not labels.
  const quoted = makeIntent({ customerStateCode: GUJARAT });
  const withGstin = tamper(quoted, 'interstate', { customerGstin: `${KARNATAKA}AAAAA0000A1Z5` });
  const result = await settleWith(withGstin);
  assert.equal(result.status, 'settled');
  assert.equal(result.totalPaise, PKG.totalPaise);
});

// --- the card is not on the settle path --------------------------------------

/**
 * `settle()` must not read the rate card. The card is what a customer is SHOWN; the
 * intent is what they AGREED to and what the gateway already collected. A defensive
 * "let me re-check the package still exists" here would strand a paid order the moment
 * an operator retired or repriced it — a refund and a support ticket, for the sake of a
 * check that cannot make the money more correct.
 */
test('settle() never consults the rate card, in code', () => {
  const source = fs.readFileSync(path.join(__dirname, 'recharge-settle.js'), 'utf8')
    // Comments are prose: the docblock NAMES the card to explain that it is not read.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.equal(/credit-rates/i.test(source), false, 'no require of the card loader');
  for (const name of ['rateCard', 'listPackages', 'packageById', 'packageQuote', 'CREDIT_RATES_FILE']) {
    assert.equal(new RegExp(`\\b${name}\\b`).test(source), false, `settle() must not call ${name}`);
  }
});

test('a package repriced or retired after the order still settles at the frozen numbers', async () => {
  // The behavioral half of the gate above: point CREDIT_RATES_FILE at a card where
  // `credits-3500` is ₹3,000 → 6,000 credits AND retired, then settle an order quoted
  // against the published one. If any of this read the card, the order would reprice to
  // ₹3,540 or strand a payment that has already been collected.
  const creditRates = require('@software-factory/shared-core/billing/credit-rates');
  const published = '  - id: credits-3500\n    price_inr: "2000"\n    credits: 3500\n    bonus_valid_days: 30\n    enabled: true\n';
  const edited = '  - id: credits-3500\n    price_inr: "3000"\n    credits: 6000\n    bonus_valid_days: 30\n    enabled: false\n';
  const card = fs.readFileSync(creditRates.DEFAULT_CARD_PATH, 'utf8');
  assert.ok(card.includes(published), 'the shipped card still spells the offer this test quotes');
  const fixture = path.join(TMP_DIR, 'card-edited.yaml');
  fs.writeFileSync(fixture, card.replace(published, edited));
  const prev = process.env.CREDIT_RATES_FILE;
  process.env.CREDIT_RATES_FILE = fixture;
  creditRates.resetCard();
  try {
    assert.equal(creditRates.packageById(PKG.id).priceInr, 3000, 'precondition: the card the process would read has moved');
    assert.equal(creditRates.packageById(PKG.id).enabled, false, 'precondition: and the offer is retired');
    const intent = makeIntent();
    const client = fakeFlexprice({ opening: 0 });
    const result = await settleWith(intent, { client });
    assert.equal(result.totalPaise, PKG.totalPaise, 'the ₹2,360 that was collected is the price, not the ₹3,540 the edited card would say');
    assert.equal(result.creditCount, PKG.prepaidCredits);
    assert.equal(result.promoCredits, PKG.bonusCredits);
    assert.equal(client.state.balance, PKG.totalCredits);
  } finally {
    if (prev === undefined) delete process.env.CREDIT_RATES_FILE; else process.env.CREDIT_RATES_FILE = prev;
    creditRates.resetCard();
  }
});

// --- the bonus window belongs to the package ---------------------------------

test('an expired bonus credits the prepaid half and skips the promo', async () => {
  const intent = makeIntent({ record: { promoExpiresAt: '2026-11-01T00:00:00.000Z' } });
  const client = fakeFlexprice({ opening: 1000 });
  const logged = [];
  const result = await settle({ orderId: intent.orderId, orgId: ORG, actor: 'test' }, {
    store,
    providers: fakeProviders(fakeAdapter({ amountDecimal: PKG.amountDecimal })),
    flexpriceClient: client,
    flexpriceConfig: { enabled: true, supplierStateCode: GUJARAT },
    env: {},
    log: { info() {}, error() {}, warn: (event, fields) => logged.push([event, fields]) },
    now: () => '2026-11-12T10:00:00.000Z',
  });

  assert.equal(result.status, 'settled', 'money collected is never held hostage by a lapsed offer');
  assert.equal(result.creditCount, PKG.prepaidCredits);
  assert.equal(result.promoCredits, 0);
  assert.equal(result.bonusSkipped, 'expired');
  assert.equal(client.state.topUps.length, 1);
  assert.equal(client.state.grants.length, 0, 'the expired bonus is not granted');
  assert.equal(client.state.balance, 1000 + PKG.prepaidCredits);
  const warning = logged.find(([event]) => event === 'recharge_bonus_expired');
  assert.ok(warning, 'a skipped bonus is a support question, so it is logged with the order');
  assert.deepEqual(
    { orderId: warning[1].orderId, package: warning[1].packageId, skipped: warning[1].bonusCredits },
    { orderId: intent.orderId, package: PKG.id, skipped: PKG.bonusCredits },
  );
  assert.equal(store.getRechargeIntent(intent.orderId).flexprice_settlement.bonusSkipped, 'expired',
    'and the receipt records it, so a replay reports what landed rather than what was offered');

  const replay = await settle({ orderId: intent.orderId, orgId: ORG }, {
    store, providers: fakeProviders(fakeAdapter()), flexpriceClient: client,
    flexpriceConfig: { enabled: true, supplierStateCode: GUJARAT }, env: {}, log: QUIET,
  });
  assert.deepEqual(
    { status: replay.status, promo: replay.promoCredits, skipped: replay.bonusSkipped },
    { status: 'already_processed', promo: 0, skipped: 'expired' },
  );
});

test('an order quoted with no expiry never skips the bonus', async () => {
  const intent = makeIntent({ record: { promoExpiresAt: null } });
  const client = fakeFlexprice({ opening: 0 });
  const result = await settleWith(intent, { client });
  assert.equal(result.promoCredits, PKG.bonusCredits);
  assert.equal(result.bonusSkipped, null);
  assert.equal(client.state.grants[0].expiresAt, null, 'no deadline on the intent means no deadline on the grant');
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
  assert.equal(result.collectedPaise, PKG.totalPaise, 'the mock reports the intent total, so the amount check still means something');
  assert.equal(client.state.topUps[0].body.creditsToAdd, '2000');
});

test('with FlexPrice disabled there is no credit at all — and the gateway is not consulted', async () => {
  const intent = makeIntent();
  const adapter = fakeAdapter({ amountDecimal: PKG.amountDecimal });
  const client = fakeFlexprice();
  await expectRefused(
    settleWith(intent, { adapter, client, config: { enabled: false, supplierStateCode: GUJARAT }, env: { BILLING_ALLOW_MOCK_PAYMENTS: 'true' } }),
    'flexprice_disabled', 503,
  );
  assert.equal(adapter.calls.length, 0, 'no point verifying a payment this deployment cannot credit');
  assert.equal(client.state.topUps.length, 0);
});

test('a wallet whose conversionRate is not 1 is refused before the credit', async () => {
  const intent = makeIntent();
  const client = fakeFlexprice({ conversionRate: '2' });
  await expectRefused(settleWith(intent, { client }), 'wallet_conversion_rate', 500);
  assert.equal(client.state.topUps.length, 0, 'at rate 2 a 2,000-credit top-up is ₹4,000 of value');
});

test('a read-back that disagrees with the credit is not marked settled', async () => {
  const intent = makeIntent();
  const client = fakeFlexprice({ creditOnTopUp: false });
  await expectRefused(settleWith(intent, { client }), 'flexprice_credit_readback_mismatch', 502);
  assert.equal(store.getRechargeIntent(intent.orderId).status, 'QUOTED');
});

// --- inter-state -------------------------------------------------------------

test('an interstate customer is IGST at the same total, and settles identically', async () => {
  const intent = makeIntent({ customerGstin: `${KARNATAKA}AAAAA0000A1Z5` });
  assert.equal(intent.gstPaise, PKG.gstPaise);
  assert.equal(intent.totalPaise, PKG.totalPaise);
  const client = fakeFlexprice({ opening: 1000 });
  const result = await settleWith(intent, { client });
  assert.equal(result.creditCount, PKG.prepaidCredits);
  assert.equal(result.promoCredits, PKG.bonusCredits);
  assert.equal(client.state.balance, 4500);
});
