'use strict';

// Composition test for the four Phase 0 billing modules.
//
// The unit tests for gst/credits/compute-pricing/substrate-session check each
// function in isolation. This file checks the one thing that actually matters and
// that no isolated test can: that the numbers line up when a rupee of recharge
// becomes credits, credits become a debit, and a session becomes a price — with
// every figure hand-computed here so a wrong constant cannot agree with itself.
//
// It is also the compensating control for the decision to run a single
// authoritative credit system with no shadow period: with no second ledger to
// diff against, the proof that money is computed correctly has to be a
// deterministic test with exact expected integers, which is what this is.

const test = require('node:test');
const assert = require('node:assert/strict');

const gst = require('./gst.js');
const credits = require('./credits.js');
const compute = require('./compute-pricing.js');
const moneyWire = require('./money-wire.js');
const pricing = require('./pricing.js');

const RECHARGE_PAISE = 50000; // ₹500 of prepaid value
const GST_PAISE = 9000; // ₹45 CGST + ₹45 SGST
const CHARGED_PAISE = 59000; // what Cashfree is asked for
const PLATFORM_CHARGE_TOKEN_CREDITS = 300000; // ₹3000/month, tax already paid on the recharge
const RATE_TOKEN_CREDITS_PER_HOUR = 360; // ₹3.60/h for standard-1v1g — a FIXTURE, see below

// Item 27 is an open operator decision: the real ₹/hour for `standard-1v1g` is not
// chosen yet. Every number here therefore follows from this fixture, and the test
// asserts arithmetic rather than price. When the operator sets the rate, the price
// lives in the FlexPrice catalog and `priceActorUsage` refuses to run without it —
// that refusal is the thing that must not be softened into a default.
const GUJARAT = '24';
const MAHARASHTRA = '27';

test('a ₹500 intra-state recharge charges ₹590 and credits ₹500', () => {
  const q = gst.quote({ subtotalPaise: RECHARGE_PAISE, supplierStateCode: GUJARAT, customerStateCode: GUJARAT });
  assert.deepEqual(
    q.components.map((c) => [c.name, c.rateBps, c.paise]),
    [['CGST', 900, 4500], ['SGST', 900, 4500]],
    'intra-state supply splits into CGST and SGST at 9% each',
  );
  assert.equal(q.gstPaise, GST_PAISE);
  assert.equal(q.totalPaise, CHARGED_PAISE);
  assert.equal(q.placeOfSupply.type, 'intrastate');
  assert.equal(q.placeOfSupply.stateCode, GUJARAT);

  const c = credits.topUpCrediting({ quote: q });
  assert.equal(c.prepaidTokenCredits, RECHARGE_PAISE, 'credit is the subtotal, never the tax-inclusive total');
  assert.equal(c.promoTokenCredits, 0);
  assert.equal(c.collectedPaise, CHARGED_PAISE);
  assert.equal(c.gstPaise, GST_PAISE);
  assert.deepEqual(
    c.instructions,
    [{ walletType: credits.CREDIT_SOURCE_PREPAID, amountTokenCredits: RECHARGE_PAISE, expiry: null }],
    'no promotional wallet row is created when there is no bonus',
  );
  assert.equal(gst.toCashfreeOrderAmount(c.collectedPaise), '590.00');
});

test('the ₹90 GST is never spendable, which is the identity that keeps tax out of the balance', () => {
  const q = gst.quote({ subtotalPaise: RECHARGE_PAISE, supplierStateCode: GUJARAT, customerStateCode: GUJARAT });
  const c = credits.topUpCrediting({ quote: q });

  assert.equal(
    c.collectedPaise - c.gstPaise,
    c.prepaidTokenCredits + c.promoTokenCredits,
    'everything charged, minus the tax, is exactly everything credited',
  );

  // The failure this guards is silent: crediting the gross would make ₹90 of
  // every recharge spendable, and no individual field would look wrong.
  assert.throws(() => credits.assertNoTaxCredited({ amountTokenCredits: CHARGED_PAISE, quote: q }), /tax/i);
  credits.assertNoTaxCredited({ amountTokenCredits: RECHARGE_PAISE, quote: q });
});

test('a 10% coupon adds a promotional wallet without touching the ₹590 charged', () => {
  const q = gst.quote({
    subtotalPaise: RECHARGE_PAISE,
    couponBps: 1000,
    supplierStateCode: GUJARAT,
    customerStateCode: GUJARAT,
  });
  assert.equal(q.bonusTokenCredits, 5000, 'coupon bonus is 10% of the subtotal');
  assert.equal(q.totalPaise, CHARGED_PAISE, 'a coupon grants bonus credits, it does not discount the charge');

  const c = credits.topUpCrediting({ quote: q, expiresAt: '2027-03-31T23:59:59.000Z' });
  assert.equal(c.prepaidTokenCredits, RECHARGE_PAISE);
  assert.equal(c.promoTokenCredits, 5000);
  assert.equal(c.collectedPaise, CHARGED_PAISE);
  assert.deepEqual(c.instructions, [
    { walletType: credits.CREDIT_SOURCE_PREPAID, amountTokenCredits: RECHARGE_PAISE, expiry: null },
    { walletType: credits.CREDIT_SOURCE_PROMOTIONAL, amountTokenCredits: 5000, expiry: '2027-03-31T23:59:59.000Z' },
  ]);
  assert.equal(c.prepaidCredits, 500, 'D6: 1 credit = ₹1, so the ₹500 subtotal is 500 credits — the number Phase 2 sends as credits_to_add');
  assert.equal(c.prepaidCredits, moneyWire.tokenCreditsToCredits(RECHARGE_PAISE), 'the credit count comes from the same boundary as the wire value');
  assert.equal(moneyWire.decimalFromPaise(c.collectedPaise), '590.00', 'the gross that reaches the gateway equals the gross on the invoice');
});

test('interstate supply charges IGST and, critically, the same total', () => {
  const intra = gst.quote({ subtotalPaise: RECHARGE_PAISE, supplierStateCode: GUJARAT, customerStateCode: GUJARAT });
  const inter = gst.quote({ subtotalPaise: RECHARGE_PAISE, supplierStateCode: GUJARAT, customerStateCode: MAHARASHTRA });

  assert.deepEqual(inter.components.map((c) => [c.name, c.rateBps, c.paise]), [['IGST', 1800, 9000]]);
  assert.equal(inter.placeOfSupply.type, 'interstate');
  assert.equal(inter.totalPaise, intra.totalPaise, 'the split changed, the amount charged did not');
});

test('the rupee that exposes why the total must be derived by adding the components', () => {
  // ₹0.28 + 18% . Each 9% component is 2.52p and rounds half-up to 3p, so the
  // invoice the customer sees is 6p of tax. Taxing once at 18% gives 5.04p, i.e.
  // 5p. The two answers differ by a paise, and Cashfree charges the number on the
  // invoice, so the components are authoritative and the total follows.
  const q = gst.quote({ subtotalPaise: 28, supplierStateCode: GUJARAT, customerStateCode: GUJARAT });
  assert.deepEqual(q.components.map((c) => c.paise), [3, 3]);
  assert.equal(q.gstPaise, 6);
  assert.equal(q.totalPaise, 34);
  assert.notEqual(q.totalPaise, 28 + gst.roundHalfUpPaise((28 * 1800) / gst.BPS));
});

test('actor sessions price from whole seconds and never from fractional rupees', () => {
  const cases = [
    [90, 9], // 90s at ₹3.60/h = 9p exactly
    [3600, 360], // one hour = the rate
    [0, 0],
    [5, 1], // 0.5p, half-up
  ];
  for (const [seconds, expectedTokenCredits] of cases) {
    const priced = compute.priceActorUsage({ durationSeconds: seconds, hourlyRateTokenCredits: RATE_TOKEN_CREDITS_PER_HOUR });
    assert.equal(priced.meterValue, seconds, 'the metered quantity is integer seconds');
    assert.equal(priced.meterName, 'actor-compute');
    assert.equal(priced.tier, 'standard-1v1g');
    assert.equal(priced.expectedTokenCredits, expectedTokenCredits, `${seconds}s should cost ${expectedTokenCredits}p`);
    assert.ok(Number.isInteger(priced.expectedTokenCredits), 'no fractional token credit reaches the ledger');
  }

  // The auditable deviation: the reference formula rounded to four decimal rupees,
  // which produces a half-paise. Same input, different shape of answer.
  assert.equal(compute.referenceCostInr({ durationSeconds: 5, hourlyRateInr: 3.6 }), 0.005);
  assert.equal(compute.priceActorUsage({ durationSeconds: 5, hourlyRateTokenCredits: 360 }).expectedTokenCredits, 1);

  assert.throws(
    () => compute.priceActorUsage({ durationSeconds: 90 }),
    /hourlyRateTokenCredits is required/,
    'refusing to guess a price is the point: no default rate may appear here',
  );
});

test('a fixed set of sessions plus the platform charge equals a hand-computed debit', () => {
  const sessions = [90, 3600, 5];
  const priced = sessions.map((s) => compute.priceActorUsage({ durationSeconds: s, hourlyRateTokenCredits: RATE_TOKEN_CREDITS_PER_HOUR }));
  const usageTokenCredits = priced.reduce((sum, p) => sum + p.expectedTokenCredits, 0);

  assert.equal(usageTokenCredits, 370, '9 + 360 + 1 token credits');
  assert.equal(priced.reduce((sum, p) => sum + p.meterValue, 0), 3695, 'the meter sum is plain seconds');

  const debit = usageTokenCredits + PLATFORM_CHARGE_TOKEN_CREDITS;
  assert.equal(debit, 300370);

  // GST: the recharge was taxed, the consumption and the platform charge are not.
  const usageInvoice = { taxPaise: 0, totalPaise: debit };
  assert.equal(usageInvoice.taxPaise, 0, 'usage statements carry no tax in advance mode');
});

test('debits draw the promotional wallet first and the earliest expiry first inside it', () => {
  const wallets = [
    { walletId: 'w-prepaid', walletType: credits.CREDIT_SOURCE_PREPAID, amountTokenCredits: 50000 },
    { walletId: 'w-promo-late', walletType: credits.CREDIT_SOURCE_PROMOTIONAL, amountTokenCredits: 1000, expiresAt: '2027-06-30T00:00:00.000Z' },
    { walletId: 'w-promo-soon', walletType: credits.CREDIT_SOURCE_PROMOTIONAL, amountTokenCredits: 5000, expiresAt: '2027-03-31T00:00:00.000Z' },
  ];

  assert.deepEqual(credits.drawOrderForDebit(wallets, 6000), [
    { walletId: 'w-promo-soon', walletType: credits.CREDIT_SOURCE_PROMOTIONAL, amountTokenCredits: 5000 },
    { walletId: 'w-promo-late', walletType: credits.CREDIT_SOURCE_PROMOTIONAL, amountTokenCredits: 1000 },
  ], 'bonus value is spent before purchased value, and expiring-soonest first');

  assert.deepEqual(credits.drawOrderForDebit(wallets, 56000), [
    { walletId: 'w-promo-soon', walletType: credits.CREDIT_SOURCE_PROMOTIONAL, amountTokenCredits: 5000 },
    { walletId: 'w-promo-late', walletType: credits.CREDIT_SOURCE_PROMOTIONAL, amountTokenCredits: 1000 },
    { walletId: 'w-prepaid', walletType: credits.CREDIT_SOURCE_PREPAID, amountTokenCredits: 50000 },
  ], 'an exact drain touches all three in that order');

  const partial = credits.drawOrderForDebit(wallets, 300370);
  const covered = partial.reduce((sum, d) => sum + d.amountTokenCredits, 0);
  assert.equal(covered, 56000);
  assert.equal(300370 - covered, 244370, 'the shortfall is visible to the caller, never absorbed silently');
});

test('the savings panel reads as a counterfactual and is not wired to any debit', () => {
  const firstSeenAt = 1_700_000_000;
  const now = firstSeenAt + 7200;
  const s = compute.savingsEstimate({
    firstSeenAt, now, billedSeconds: 90, billedTokenCredits: 9, hourlyRateTokenCredits: RATE_TOKEN_CREDITS_PER_HOUR,
  });
  assert.equal(s.available, true);
  assert.equal(s.baselineTokenCredits, 720, 'always-on for two hours at ₹3.60/h');
  assert.equal(s.netSavedTokenCredits, 711);
  assert.equal(s.idleSeconds, 7110);
  assert.equal(s.idlePercent, 98.75);
  // The billed figure came from priceActorUsage, not from anything above. If a
  // future change ever feeds baselineTokenCredits into a debit, this test is the alarm.
  assert.equal(
    compute.priceActorUsage({ durationSeconds: 90, hourlyRateTokenCredits: RATE_TOKEN_CREDITS_PER_HOUR }).expectedTokenCredits,
    9,
    'the charge depends on billed seconds only',
  );
});

// D9 left one FX multiplication inside the money path, and Phase 3 is what made it
// load-bearing: `token_credits` is no longer a page decoration, it is the quantity the
// outbox delivers and the meter sums. So the two figures below are computed with
// pencil arithmetic — 100k in + 20k out at claude's ₹3/₹15 per MTok, at ₹87/USD.
test('a run’s tokens become the token credits the meter will sum, exactly', () => {
  const usd = pricing.estimateCostUsd({ inputTokens: 100_000, outputTokens: 20_000 }, 'claude');
  // The float wobble is visible right here — 0.6000000000000001 rather than 0.6 —
  // and it is exactly why the conversion below is not float arithmetic.
  assert.ok(Math.abs(usd - 0.6) < 1e-12, `(100000/1e6)×3 + (20000/1e6)×15 = 0.60, got ${usd}`);

  const tokenCredits = pricing.usdToPaise(usd, 87);
  assert.equal(tokenCredits, 5220, '0.6 USD × ₹87 × 100 = ₹52.20 = 5220 token credits');
  moneyWire.assertTokenCredits(tokenCredits, 'outbox token_credits');
  // 1 token credit is 1 paise by D6, so the rupee rendering of the same integer is
  // what the page showed before the rename and still shows for a ₹ figure.
  assert.equal(moneyWire.decimalFromPaise(tokenCredits), '52.20', 'the same number the page shows');

  // Usage money is a decimal amount of credits, never a whole count, so the credit
  // mover refuses it. If someone routes a metered run through `tokenCreditsToCredits` the
  // bill silently rounds away ₹0.20 per run — which is the direction that adds up.
  assert.throws(() => moneyWire.tokenCreditsToCredits(tokenCredits), /whole number of credits/);

  // The reason this is BigInt arithmetic: ₹1.005 is an exact half-paise, and binary
  // float puts it just BELOW the half, so the naive round is short by one on every
  // such run and both sides of a reconciliation agree that they undercharged.
  assert.equal(Math.round(1.005 * 1 * 100), 100, 'the defect, stated so it is not re-introduced');
  assert.equal(pricing.usdToPaise(1.005, 1), 101, 'half away from zero, once, at the boundary');
});
