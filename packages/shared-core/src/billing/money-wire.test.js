'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAISE_PER_CREDIT,
  decimalToScaled,
  formatScaled,
  roundDiv,
  paiseFromDecimal,
  decimalFromPaise,
  paiseFromCredits,
  creditsFromPaise,
} = require('./money-wire');

// ---------------------------------------------------------------------------
// The headline invariant from the product spec, restated through the wire.
// ---------------------------------------------------------------------------

test('the ₹500 recharge crosses the wire as ₹590 charged and 500 credits', () => {
  // Node computes 59000 paise; Cashfree is told "590.00"; the wallet gets 500.
  assert.equal(decimalFromPaise(59000), '590.00');
  assert.equal(decimalFromPaise(50000), '500.00');
  assert.equal(creditsFromPaise(50000), '500.00');
});

test('PAISE_PER_CREDIT is 100 — ₹1 = 1 credit, so ₹500 buys 500 credits', () => {
  assert.equal(PAISE_PER_CREDIT, 100);
  assert.equal(paiseFromCredits(500), 50000);
  assert.equal(creditsFromPaise(50000), '500.00');
});

// ---------------------------------------------------------------------------
// The float trap this module exists to defuse.
// ---------------------------------------------------------------------------

test('paiseFromDecimal is exact where Math.round(parseFloat*100) is short', () => {
  // Binary float puts 1.005 × 100 just below 100.5, so the naive round lands on
  // 100 — a paise short, always in the same direction (the platform gives the
  // difference away). The digit string says 101 and that is what we take.
  assert.equal(Math.round(parseFloat('1.005') * 100), 100);
  assert.equal(paiseFromDecimal('1.005'), 101);
});

test('paiseFromDecimal: truncation never silently underbills', () => {
  // Math.trunc('500.005' * 100) is 50000 — FlexPrice's ToSmallestUnit defect.
  assert.equal(Math.trunc(parseFloat('500.005') * 100), 50000);
  assert.equal(paiseFromDecimal('500.005'), 50001);
});

// ---------------------------------------------------------------------------
// decimalToScaled — exact on every digit string we see on the wire
// ---------------------------------------------------------------------------

test('decimalToScaled: plain integers and two decimals', () => {
  assert.equal(decimalToScaled('500', 2), 50000n);
  assert.equal(decimalToScaled('500.00', 2), 50000n);
  assert.equal(decimalToScaled('0.01', 2), 1n);
  assert.equal(decimalToScaled('0.10', 2), 10n);
});

test('decimalToScaled: sub-paise rounds half away from zero', () => {
  assert.equal(decimalToScaled('500.005', 2), 50001n);  // .005 rounds up
  assert.equal(decimalToScaled('500.004', 2), 50000n);  // .004 rounds down
  assert.equal(decimalToScaled('-500.005', 2), -50001n); // away from zero, not toward +∞
  assert.equal(decimalToScaled('-500.004', 2), -50000n);
});

test('decimalToScaled: more decimals than toDp without crashing', () => {
  // 1000.505 → 3 decimal places, toDp=2: keep the first 2, round the 3rd.
  assert.equal(decimalToScaled('1000.505', 2), 100051n);
  assert.equal(decimalToScaled('1000.504', 2), 100050n);
});

test('decimalToScaled: rejects garbage instead of returning NaN', () => {
  assert.throws(() => decimalToScaled(NaN, 2), /finite|integer|decimal/i);
  assert.throws(() => decimalToScaled(Infinity, 2), /finite|integer|decimal/i);
  assert.throws(() => decimalToScaled('not-a-number', 2), /decimal/i);
  assert.throws(() => decimalToScaled('', 2), /decimal/i);
});

test('decimalToScaled: a sub-paise remainder smaller than half a paise is 0', () => {
  // 0.0005 rupee = 0.05 paise: closer to 0 than to 1, so it rounds to 0.
  assert.equal(decimalToScaled('0.0005', 2), 0n);
  // 0.005 rupee = exactly half a paise → 1.
  assert.equal(decimalToScaled('0.005', 2), 1n);
});

// ---------------------------------------------------------------------------
// roundDiv — halves away from zero on integer division too
// ---------------------------------------------------------------------------

test('roundDiv: 5 paise / 2 rounds to 3, not 2 (banker\'s would be even)', () => {
  assert.equal(roundDiv(5n, 2n), 3n);
  assert.equal(roundDiv(4n, 2n), 2n);
  assert.equal(roundDiv(3n, 2n), 2n);
});

test('roundDiv: negative amounts away from zero', () => {
  assert.equal(roundDiv(-5n, 2n), -3n);
  assert.equal(roundDiv(-4n, 2n), -2n);
});

// ---------------------------------------------------------------------------
// formatScaled — the inverse
// ---------------------------------------------------------------------------

test('formatScaled: renders to the right number of decimal places', () => {
  assert.equal(formatScaled(50000n, 2), '500.00');
  assert.equal(formatScaled(1n, 2), '0.01');
  assert.equal(formatScaled(-50001n, 2), '-500.01');
  assert.equal(formatScaled(1000n, 0), '1000');
});

test('formatScaled: zero has the right sign', () => {
  assert.equal(formatScaled(0n, 2), '0.00');
});

// ---------------------------------------------------------------------------
// The public wrappers
// ---------------------------------------------------------------------------

test('paiseFromDecimal / decimalFromPaise: round-trip on two-decimal strings', () => {
  for (const s of ['0.00', '0.01', '1.00', '500.00', '590.00', '-1.00']) {
    assert.equal(decimalFromPaise(paiseFromDecimal(s)), s);
  }
});

test('paiseFromDecimal: JS number path only works for integers', () => {
  assert.equal(paiseFromDecimal(500), 50000);
  assert.throws(() => paiseFromDecimal(500.005), /STRING/);
});

test('decimalFromPaise: refuses fractional paise', () => {
  assert.throws(() => decimalFromPaise(500.5), /WHOLE paise/);
});

test('paiseFromCredits / creditsFromPaise: ₹1 = 1 credit round-trips', () => {
  assert.equal(paiseFromCredits('500'), 50000);
  assert.equal(paiseFromCredits('500.5'), 50050);
  assert.equal(creditsFromPaise(50000), '500.00');
  assert.equal(creditsFromPaise(50050), '500.50');
});

test('paiseFromCredits: a fractional JS number is refused, not guessed at', () => {
  // 0.1 is not exactly one tenth in binary floating point, so the amount that
  // arrives as a Number is only trustworthy when it is a whole one.
  assert.throws(() => paiseFromCredits(500.5), /STRING/);
});

test('paiseFromCredits: sub-paise rounds, never truncates', () => {
  // 0.005 credits = 0.005 rupee = 0.5 paise, which half-up makes 1 paise.
  assert.equal(paiseFromCredits('0.005'), 1);
});

test('decimalFromPaise handles negative refund amounts', () => {
  assert.equal(decimalFromPaise(-100), '-1.00');
  assert.equal(decimalFromPaise(-50001), '-500.01');
});

test('creditsFromPaise handles negative paise', () => {
  assert.equal(creditsFromPaise(-100), '-1.00');
});
