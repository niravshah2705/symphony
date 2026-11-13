'use strict';

// The one place a rupee becomes an integer and an integer becomes a rupee.
//
// FlexPrice marshals shopspring/decimal as a QUOTED JSON string ("500.005"), and
// Cashfree/Razorpay want rupees with two decimals. Our whole money path is
// integer paise. Three unit conversions in one system is where a rounding
// argument starts, so they all live in this file and nowhere else.
//
// Why not `Math.round(parseFloat(x) * 100)`: binary floating point puts some
// exact halves just below themselves, and the amount is then short by a paise in
// a direction that never varies. `parseFloat('1.005') * 100` is
// 100.49999999999999, so the naive round gives 100 where the decimal says 101 —
// and scanning rupee amounts finds thousands of these. Truncation instead
// (FlexPrice's own `ToSmallestUnit`, and `Math.trunc` before it) is worse still:
// `500.005` × 100 is exactly 50000.5 and truncation says 50000, so it is short
// on *every* half, which no reconciliation catches because both sides agree
// they undercharged.
//
// So the arithmetic is BigInt on the digit string: shift the decimal point, and
// round half away from zero exactly once at the boundary being shifted to. That
// keeps sub-paise precision visible (the engine really does hold 1000.505) and
// makes the loss explicit and symmetric instead of a float accident.
//
// Deviation from the plan, recorded here rather than silently: the plan's
// example said `paiseFromDecimal('500.005') -> 50000`. That is truncation, the
// exact defect this module exists to avoid, so the implemented rule is half-up
// away from zero and the result is 50001.

const CURRENCY = 'INR';

// D6 of the implementation plan: 1 credit is 1 rupee, so ₹500 is 500 credits and
// a credit is worth PAISE_PER_CREDIT paise. The number is here, in one place,
// because probe A measures the engine's `conversion_rate` direction and the fix
// for a wrong guess must not be spread across the money path.
const PAISE_PER_CREDIT = 100;
const CREDITS_PER_RUPEE = 1;

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d*))?$/;

/**
 * Read a decimal amount — engine string or JS number — as `BigInt` scaled to
 * exactly `toDp` decimal places, rounding halves away from zero.
 */
function decimalToScaled(value, toDp) {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new TypeError(`money-wire: not a finite amount: ${String(value)}`);
    if (!Number.isInteger(raw)) throw new TypeError(`money-wire: pass a decimal STRING for a fractional amount, got number ${String(value)}`);
  }
  const text = String(raw);
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new TypeError(`money-wire: not a decimal amount: ${JSON.stringify(text)}`);
  const [, sign, intDigits, fracPart = ''] = m;
  if (/e/i.test(text)) throw new TypeError(`money-wire: exponent notation is not an amount: ${JSON.stringify(text)}`);

  const negative = sign === '-';
  const magnitude = BigInt(`${intDigits}${fracPart}` || '0');
  const diff = toDp - fracPart.length;
  if (diff >= 0) {
    const scaled = magnitude * 10n ** BigInt(diff);
    return negative ? -scaled : scaled;
  }

  const divisor = 10n ** BigInt(-diff);
  const whole = magnitude / divisor;
  const rest = magnitude % divisor;
  const rounded = rest * 2n >= divisor ? whole + 1n : whole;
  return negative ? -rounded : rounded;
}

/** Render a `BigInt` scaled by `dp` decimals back to a fixed-point decimal string. */
function formatScaled(scaled, dp) {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  if (dp === 0) return `${negative ? '-' : ''}${magnitude.toString()}`;
  const base = 10n ** BigInt(dp);
  const whole = magnitude / base;
  const frac = (magnitude % base).toString().padStart(dp, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

function toSafeNumber(scaled, value) {
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER) || scaled < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`money-wire: amount exceeds a safe integer paise count: ${JSON.stringify(value)}`);
  }
  return Number(scaled);
}

/** An engine decimal ("590.00", "500.005") → integer paise, half-away-from-zero. */
function paiseFromDecimal(value) {
  return toSafeNumber(decimalToScaled(value, 2), value);
}

/** Integer paise → the decimal string the wire expects ("59000" → "590.00"). */
function decimalFromPaise(paise) {
  return formatScaled(BigInt(wholePaise(paise, 'decimalFromPaise')), 2);
}

/** Credits → integer paise, half-away-from-zero on any sub-paise remainder. */
function paiseFromCredits(credits) {
  const scaled = decimalToScaled(credits, 6) * BigInt(PAISE_PER_CREDIT);
  return toSafeNumber(roundDiv(scaled, 10n ** 6n), credits);
}

/** Integer paise → credits as a decimal string ("50000" → "500.00" at ₹1 = 1 credit). */
function creditsFromPaise(paise) {
  const n = BigInt(wholePaise(paise, 'creditsFromPaise'));
  return formatScaled(roundDiv(n * 100n, BigInt(PAISE_PER_CREDIT)), 2);
}

/**
 * Integer credits → integer paise.
 *
 * The named pair the money path uses at the credit boundary (D6: 1 credit = ₹1,
 * so ₹500 is 500 credits and 50000 paise). `paiseFromCredits` is the general
 * decimal form; this is the whole-credit case, named because a recharge is
 * counted in credits on the wire and in paise in our ledger, and a reader of
 * either side should be able to tell which one they are looking at.
 */
function creditsToPaise(credits) {
  return paiseFromCredits(credits);
}

/**
 * Integer paise → integer credits, exactly.
 *
 * Refuses a non-divisible amount instead of inventing a fraction of a credit:
 * every credit a human is told about is a whole one, because a recharge is a
 * whole number of rupees. A remainder here means a caller is crediting GST or
 * sub-rupee usage money as credits, which is the mistake
 * `credits.assertNoTaxCredited` exists to catch — so `creditsFromPaise` (the
 * decimal string) is for display and this is for money movement.
 */
function paiseToCredits(paise) {
  const n = wholePaise(paise, 'paiseToCredits');
  if (n % PAISE_PER_CREDIT !== 0) {
    throw new TypeError(
      `money-wire: ${n}p is not a whole number of credits (₹1 = ${PAISE_PER_CREDIT}p); a fractional credit is a unit error — use creditsFromPaise to display it`,
    );
  }
  return n / PAISE_PER_CREDIT;
}

function wholePaise(value, context) {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new TypeError(`money-wire: ${context} wants WHOLE paise, got ${JSON.stringify(value)}. Round it deliberately first.`);
  }
  return n;
}

/** BigInt division with halves away from zero — the same rule as decimalToScaled. */
function roundDiv(numerator, denominator) {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const quotient = a / b;
  const remainder = a % b;
  const out = remainder * 2n >= b ? quotient + 1n : quotient;
  return negative ? -out : out;
}

/** Paise must be a whole-number amount before it goes anywhere near the wire. */
function assertPaise(paise, context = 'money') {
  if (!Number.isInteger(paise)) {
    throw new TypeError(`${context}: expected integer paise, got ${JSON.stringify(paise)}`);
  }
  return paise;
}

module.exports = {
  CURRENCY,
  PAISE_PER_CREDIT,
  CREDITS_PER_RUPEE,
  decimalToScaled,
  formatScaled,
  roundDiv,
  paiseFromDecimal,
  decimalFromPaise,
  paiseFromCredits,
  creditsFromPaise,
  creditsToPaise,
  paiseToCredits,
  assertPaise,
};
