'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  roundHalfUpPaise,
  parseGstin,
  resolvePlaceOfSupply,
  quote,
  toCashfreeOrderAmount,
} = require('./gst');

// The headline case from the product spec: a ₹500 recharge charges ₹590 and
// credits ₹500. Pinned here first so a future refactor cannot quietly move it.
test('quote: ₹500 recharge collects 18% GST as CGST + SGST', () => {
  const q = quote({ subtotalPaise: 50000, supplierStateCode: '27', customerStateCode: '27' });
  assert.equal(q.subtotalPaise, 50000);
  assert.deepEqual(q.components.map((c) => [c.name, c.rateBps, c.paise]), [
    ['CGST', 900, 4500],
    ['SGST', 900, 4500],
  ]);
  assert.equal(q.gstPaise, 9000);
  assert.equal(q.totalPaise, 59000);
  assert.equal(q.creditPaise, 50000, 'credit is the taxable value, never the collected total');
  assert.equal(q.placeOfSupply.type, 'intrastate');
  assert.equal(toCashfreeOrderAmount(q.totalPaise), '590.00');
});

test('quote: a different state is IGST in one component, same total', () => {
  const q = quote({ subtotalPaise: 50000, supplierStateCode: '27', customerStateCode: '29' });
  assert.equal(q.placeOfSupply.type, 'interstate');
  assert.deepEqual(q.components.map((c) => [c.name, c.rateBps, c.paise]), [['IGST', 1800, 9000]]);
  assert.equal(q.totalPaise, 59000);
});

test('quote: a customer GSTIN decides the place of supply', () => {
  const q = quote({ subtotalPaise: 50000, supplierStateCode: '27', customerGstin: '29AAAAA0000A1Z5' });
  assert.equal(q.placeOfSupply.type, 'interstate');
  assert.equal(q.placeOfSupply.stateCode, '29');
  assert.equal(q.placeOfSupply.assumed, false);
});

// The total is the sum of the parts, so the collected amount can always be tied
// back to the invoice line by line. Rounding the total independently is what
// makes a charge and an invoice disagree by a paise.
test('quote: total is always subtotal + the rounded components', () => {
  for (let subtotalPaise = 0; subtotalPaise < 4000; subtotalPaise += 7) {
    const q = quote({ subtotalPaise, supplierStateCode: '27', customerStateCode: '27' });
    const sum = q.components.reduce((acc, c) => acc + c.paise, 0);
    assert.equal(q.gstPaise, sum, `components must add up to gstPaise at ${subtotalPaise}`);
    assert.equal(q.totalPaise, subtotalPaise + sum, `total must equal subtotal + components at ${subtotalPaise}`);
  }
});

test('quote: halves round up per component, even when that over-collects', () => {
  // ₹0.50 at 9% is 4.5 paise per component. Half-up makes it 5 + 5 = 10, so a
  // 50p recharge collects 20% GST. That is the visible cost of rounding each
  // component rather than the total; recorded as a test because it surprises
  // everyone the first time and must be a decision, not an accident.
  const q = quote({ subtotalPaise: 50, supplierStateCode: '27', customerStateCode: '27' });
  assert.deepEqual(q.components.map((c) => c.paise), [5, 5]);
  assert.equal(q.totalPaise, 60);

  const odd = quote({ subtotalPaise: 999, supplierStateCode: '27', customerStateCode: '27' });
  assert.deepEqual(odd.components.map((c) => c.paise), [90, 90]);
  assert.equal(odd.gstPaise, 180);
});

test('quote: zero subtotal is zero everything', () => {
  const q = quote({ subtotalPaise: 0, supplierStateCode: '27', customerStateCode: '27' });
  assert.equal(q.totalPaise, 0);
  assert.deepEqual(q.components, []);
  assert.equal(q.gstPaise, 0);
});

test('quote: a coupon bonus does not reduce the taxable value', () => {
  const withCoupon = quote({ subtotalPaise: 50000, couponBps: 1000, supplierStateCode: '27', customerStateCode: '27' });
  const without = quote({ subtotalPaise: 50000, supplierStateCode: '27', customerStateCode: '27' });
  assert.equal(withCoupon.bonusPaise, 5000, 'bonus credit is paid on top, as promotional wallet');
  assert.equal(withCoupon.taxablePaise, without.taxablePaise, 'bonus is not a discount');
  assert.equal(withCoupon.gstPaise, without.gstPaise, 'GST still applies to the whole amount received');
  assert.equal(withCoupon.totalPaise, 59000);
});

test('quote: rejects input that could not be a paise amount', () => {
  assert.throws(() => quote({ subtotalPaise: 50000.5, supplierStateCode: '27' }), TypeError);
  assert.throws(() => quote({ subtotalPaise: -100, supplierStateCode: '27' }), TypeError);
  assert.throws(() => quote({ subtotalPaise: '50000', supplierStateCode: '27' }), TypeError);
  assert.throws(() => quote({ subtotalPaise: 50000, couponBps: 99999, supplierStateCode: '27' }), TypeError);
  assert.throws(() => quote({ subtotalPaise: 50000, supplierStateCode: '27', mode: 'nonsense' }), TypeError);
  assert.throws(
    () => quote({ subtotalPaise: 50000, supplierStateCode: '27', customerGstin: 'NOTAGSTIN' }),
    /not a valid GSTIN/,
  );
});

test('parseGstin: shape is checked, the check digit deliberately is not', () => {
  assert.deepEqual(
    (({ present, valid, stateCode, pan, entityCode, checkDigitVerified }) =>
      ({ present, valid, stateCode, pan, entityCode, checkDigitVerified }))(parseGstin('27ABCDE1234F1Z5')),
    { present: true, valid: true, stateCode: '27', pan: 'ABCDE1234F', entityCode: '1', checkDigitVerified: false },
  );
  assert.equal(parseGstin('').present, false);
  assert.equal(parseGstin(' 27ABCDE1234F1Z5 ').valid, true, 'surrounding space and case are the customer’s problem, not a rejection');
  assert.equal(parseGstin('27ABCDE1234F1Z').valid, false);
  assert.match(parseGstin('27ABCDE1234F1Z').reason, /15 characters/);
  assert.equal(parseGstin('27ABCD1234F1Z5X').valid, false, 'PAN block must be 10 chars');
  assert.equal(parseGstin('99ABCDE1234F1Z5').valid, false);
  assert.equal(parseGstin('99ABCDE1234F1Z5').reason, 'unknown state code');
  assert.equal(parseGstin('01ABCDE1234F1Z5').valid, true);
});

test('resolvePlaceOfSupply: an unknown customer falls back to the supplier state, and says so', () => {
  const assumed = resolvePlaceOfSupply({ supplierStateCode: 27 });
  assert.deepEqual(assumed, { code: '27', assumed: true, basis: 'supplier-state-default' }, 'a numeric state code is zero-padded before comparison');
  assert.deepEqual(resolvePlaceOfSupply({ supplierStateCode: '27', customerStateCode: '27' }), {
    code: '27', assumed: false, basis: 'customer-gstin',
  });
  const q = quote({ subtotalPaise: 50000, supplierStateCode: '27' });
  assert.equal(q.placeOfSupply.type, 'intrastate');
  assert.equal(q.placeOfSupply.assumed, true, 'so a B2C recharge that is really inter-state is visible, not hidden');
});

test('roundHalfUpPaise: symmetric, and never returns NaN', () => {
  assert.equal(roundHalfUpPaise(0.5), 1);
  assert.equal(roundHalfUpPaise(1.5), 2);
  assert.equal(roundHalfUpPaise(2.4999), 2);
  assert.equal(roundHalfUpPaise(-0.5), -1, 'halves go away from zero, so a refund rounds like the charge it reverses');
  assert.equal(roundHalfUpPaise(-1.5), -2);
  assert.equal(roundHalfUpPaise('nope'), 0);
  assert.equal(roundHalfUpPaise(undefined), 0);
});

test('toCashfreeOrderAmount: rupees with two decimals, no float artifacts', () => {
  assert.equal(toCashfreeOrderAmount(59000), '590.00');
  assert.equal(toCashfreeOrderAmount(1179), '11.79');
  assert.equal(toCashfreeOrderAmount(1), '0.01');
  assert.equal(toCashfreeOrderAmount(0), '0.00');
  assert.equal(toCashfreeOrderAmount(123456789), '1234567.89', 'a large amount must not go exponential');
});
