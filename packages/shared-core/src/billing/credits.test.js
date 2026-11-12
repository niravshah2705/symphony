'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { quote } = require('./gst');
const {
  bonusPaise,
  topUpCrediting,
  assertNoTaxCredited,
  drawOrderForDebit,
  CREDIT_SOURCE_PREPAID,
  CREDIT_SOURCE_PROMOTIONAL,
} = require('./credits');

const RECHARGE = { subtotalPaise: 50000, supplierStateCode: '27', customerStateCode: '27' };

test('topUpCrediting: ₹590 collected credits ₹500 of prepaid wallet', () => {
  const crediting = topUpCrediting({ quote: quote(RECHARGE) });
  assert.equal(crediting.prepaidPaise, 50000);
  assert.equal(crediting.prepaidCredits, 50000, '1 credit = 1 paise of prepaid value');
  assert.equal(crediting.promoPaise, 0);
  assert.equal(crediting.collectedPaise, 59000);
  assert.equal(crediting.gstPaise, 9000);
  assert.equal(crediting.prepaidPaise + crediting.gstPaise, crediting.collectedPaise);
  assert.equal(crediting.instructions.length, 1);
  assert.deepEqual(crediting.instructions[0], { walletType: CREDIT_SOURCE_PREPAID, amountPaise: 50000, expiry: null });
});

test('topUpCrediting: a 10% bonus is a second, expiring wallet — not a new exchange rate', () => {
  const q = quote({ ...RECHARGE, couponBps: 1000 });
  const expiry = '2026-12-31T23:59:59.000Z';
  const crediting = topUpCrediting({ quote: q, expiresAt: expiry });
  assert.equal(crediting.prepaidPaise, 50000, 'the paid rupees still buy exactly 50000 credit');
  assert.equal(crediting.promoPaise, 5000);
  assert.equal(crediting.collectedPaise, 59000, 'GST applies to the ₹500 received, not to the bonus');
  assert.deepEqual(crediting.instructions.map((i) => [i.walletType, i.amountPaise]), [
    [CREDIT_SOURCE_PREPAID, 50000],
    [CREDIT_SOURCE_PROMOTIONAL, 5000],
  ]);
  assert.equal(crediting.instructions[1].expiry, expiry);
});

test('topUpCrediting: an explicit bonusBps overrides the quote, for a ratio set outside the coupon table', () => {
  const crediting = topUpCrediting({ quote: quote(RECHARGE), bonusBps: 500 });
  assert.equal(crediting.promoPaise, 2500);
});

test('topUpCrediting: refuses a quote-shaped object that is not one', () => {
  assert.throws(() => topUpCrediting({ quote: null }), TypeError);
  assert.throws(() => topUpCrediting({ quote: { subtotalPaise: 50000 } }), TypeError);
  assert.throws(() => topUpCrediting({ quote: { subtotalPaise: 50000, totalPaise: 40000 } }), /below its own subtotal/);
});

// This is the failure mode the whole recharge design is arranged around. It is
// silent by nature: the balance looks plausible, spending works, and 18% of
// every tax rupee has quietly become a discount.
test('assertNoTaxCredited: refuses to credit the GST-inclusive total', () => {
  const q = quote(RECHARGE);
  assert.throws(
    () => assertNoTaxCredited({ amountPaise: 59000, quote: q }),
    /GST-inclusive total/,
  );
  assert.throws(() => assertNoTaxCredited({ amountPaise: 60000, quote: q }), /more than the 50000p taxable value/);
  assert.equal(assertNoTaxCredited({ amountPaise: 50000, quote: q }), 50000);
});

test('assertNoTaxCredited: an untaxed quote has nothing to leak', () => {
  const zeroTax = { subtotalPaise: 50000, totalPaise: 50000, gstPaise: 0 };
  assert.equal(assertNoTaxCredited({ amountPaise: 50000, quote: zeroTax }), 50000);
});

test('bonusPaise: validates its inputs', () => {
  assert.equal(bonusPaise(50000, 1000), 5000);
  assert.equal(bonusPaise(50000, 0), 0);
  assert.equal(bonusPaise(1, 10000), 1, 'a 100% bonus on 1p of recharge is 1p of bonus credit');
  assert.throws(() => bonusPaise(-1, 100), TypeError);
  assert.throws(() => bonusPaise(50000, -1), TypeError);
  assert.throws(() => bonusPaise(1.5, 100), TypeError);
});

test('drawOrderForDebit: promotional credit is spent before real money, earliest expiry first', () => {
  const balances = [
    { walletId: 'w-prepaid', walletType: CREDIT_SOURCE_PREPAID, amountPaise: 50000 },
    { walletId: 'w-promo-late', walletType: CREDIT_SOURCE_PROMOTIONAL, amountPaise: 1000, expiresAt: '2027-06-01T00:00:00.000Z' },
    { walletId: 'w-promo-soon', walletType: CREDIT_SOURCE_PROMOTIONAL, amountPaise: 5000, expiresAt: '2026-12-01T00:00:00.000Z' },
  ];
  assert.deepEqual(
    drawOrderForDebit(balances, 56000).map((d) => [d.walletId, d.amountPaise]),
    [['w-promo-soon', 5000], ['w-promo-late', 1000], ['w-prepaid', 50000]],
    'the bonus about to lapse is drawn first, so it cannot expire unused',
  );
});

test('drawOrderForDebit: draws only what exists, so a shortfall is visible to the caller', () => {
  const balances = [
    { walletId: 'w-prepaid', walletType: CREDIT_SOURCE_PREPAID, amountPaise: 5000 },
    { walletId: 'w-promo', walletType: CREDIT_SOURCE_PROMOTIONAL, amountPaise: 500, expiresAt: '2026-12-01T00:00:00.000Z' },
  ];
  const draws = drawOrderForDebit(balances, 9000);
  const total = draws.reduce((acc, d) => acc + d.amountPaise, 0);
  assert.equal(total, 5500, 'never invents credit for a debit larger than the balance');
  assert.ok(total < 9000, 'the caller must be able to see the gap and decide to block');
});

test('drawOrderForDebit: ignores empty wallets and a zero or negative debit', () => {
  const balances = [
    { walletId: 'a', walletType: CREDIT_SOURCE_PREPAID, amountPaise: 0 },
    { walletId: 'b', walletType: CREDIT_SOURCE_PROMOTIONAL, amountPaise: -50 },
    { walletId: 'c', walletType: CREDIT_SOURCE_PREPAID, amountPaise: 100 },
  ];
  assert.deepEqual(drawOrderForDebit(balances, 10), [{ walletId: 'c', walletType: CREDIT_SOURCE_PREPAID, amountPaise: 10 }]);
  assert.deepEqual(drawOrderForDebit(balances, 0), []);
  assert.deepEqual(drawOrderForDebit(balances, -10), []);
  assert.deepEqual(drawOrderForDebit([], 10), []);
  assert.deepEqual(drawOrderForDebit(), []);
});
