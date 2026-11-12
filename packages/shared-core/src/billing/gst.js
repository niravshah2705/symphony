'use strict';

// Indian GST computation for a wallet recharge. Integer paise in, integer paise
// out — the same rule `pricing.js` applies to LLM cost.
//
// This module exists so exactly one number is ever born for a tax amount. The
// Cashfree order total, the invoice shown to the user and the Zoho posting must
// all come from one `quote()` result; if any of them recomputes GST from a
// percentage independently they will disagree by a paise on odd amounts, and a
// charge that does not match the invoice cannot be reconciled later.
//
// `advance` is the mode this product uses: the recharge receipt is the taxable
// event (time of supply = receipt of money), so the period invoices that later
// consume that credit must carry zero tax. Charging GST again on consumption
// would tax the same supply twice.

const BPS = 10000;

const GST_RATE_BPS = 1800; // 18%
const CGST_RATE_BPS = 900;
const SGST_RATE_BPS = 900;
const IGST_RATE_BPS = 1800;

const CURRENCY = 'INR';

// 15 chars: 2-digit state code, 10-char PAN, entity check code, a literal 'Z',
// then a checksum character.
const GSTIN_RE = /^(\d{2})([A-Z]{5}[0-9]{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$/;

/**
 * Round a fractional paise amount to whole paise, halves away from zero.
 *
 * `Math.round` rounds -0.5 to -0 and 0.5 up, which is fine for positives but is
 * not a rule you can state for a refund, so the direction is written out. Every
 * rounding in this directory goes through here — two rounding rules in one money
 * path is how a total stops equalling the sum of its parts.
 */
function roundHalfUpPaise(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n >= 0 ? Math.floor(n + 0.5) : Math.ceil(n - 0.5);
}

/**
 * Read a GSTIN's place of supply out of it.
 *
 * The state code is checked for shape only (01-37). Two things are deliberately
 * NOT validated here, because guessing at them is worse than not doing it:
 *   - the trailing check digit (a modulus-11 weighted algorithm whose weights I
 *     have not verified against the official spec — an implementation that is
 *     wrong by one weight rejects valid GSTINs from whole states and blocks
 *     recharges, silently);
 *   - the state-code-to-name table (same reason).
 * Both are marked in the return value so a caller can require them later, and
 * both are open items for the legal/compliance pass, not for this module.
 */
function parseGstin(gstin) {
  const raw = String(gstin || '').trim().toUpperCase();
  if (!raw) return { present: false, valid: false, stateCode: null, pan: null, reason: 'absent' };
  const m = GSTIN_RE.exec(raw);
  if (!m) {
    return {
      present: true,
      valid: false,
      stateCode: null,
      pan: null,
      reason: raw.length !== 15 ? 'expected 15 characters' : 'does not match the GSTIN format',
    };
  }
  const stateCode = Number(m[1]);
  if (stateCode < 1 || stateCode > 37) {
    return { present: true, valid: false, stateCode: m[1], pan: m[2], reason: 'unknown state code' };
  }
  return {
    present: true,
    valid: true,
    stateCode: m[1],
    pan: m[2],
    entityCode: m[3],
    checkDigitVerified: false,
    reason: null,
  };
}

/**
 * Where the supply happens. Same state => CGST+SGST; different state => IGST.
 *
 * An unregistered customer with no address falls back to the supplier's state,
 * which is the default rule when the recipient location is not available. That
 * fallback is reported as `assumed` rather than hidden, because a supply that is
 * actually inter-state charged as CGST+SGST is a filing error someone has to be
 * able to see.
 */
function resolvePlaceOfSupply({ supplierStateCode, customerStateCode } = {}) {
  const supplier = String(supplierStateCode || '').padStart(2, '0');
  const fromCustomer = customerStateCode == null || customerStateCode === ''
    ? null
    : String(customerStateCode).padStart(2, '0');
  if (!fromCustomer) {
    return { code: supplier, assumed: true, basis: 'supplier-state-default' };
  }
  return { code: fromCustomer, assumed: false, basis: 'customer-gstin' };
}

/**
 * One quote for one recharge: what is credited, what GST is added, what is charged.
 *
 * `subtotalPaise` is the rupee value the user asked to load (₹500 => 50000) and
 * is also what becomes wallet credit. `totalPaise` is what Cashfree collects.
 * The total is DERIVED by adding the components, never rounded on its own, so
 * the collected amount always equals the invoice to the paise.
 *
 * `couponBps` is a bonus grant (more credit for the same money), not a discount:
 * it does not reduce the taxable value. Folding a bonus into the subtotal would
 * understate GST on the amount actually received.
 */
function quote(params = {}) {
  const {
    subtotalPaise,
    couponBps = 0,
    supplierStateCode,
    customerGstin,
    customerStateCode,
    mode = 'advance',
  } = params;

  if (!Number.isInteger(subtotalPaise) || subtotalPaise < 0) {
    throw new TypeError(`gst.quote: subtotalPaise must be a non-negative integer of paise, got ${JSON.stringify(subtotalPaise)}`);
  }
  if (!Number.isInteger(couponBps) || couponBps < 0 || couponBps > 10000) {
    throw new TypeError(`gst.quote: couponBps must be an integer 0..10000, got ${JSON.stringify(couponBps)}`);
  }
  if (mode !== 'advance' && mode !== 'supply') {
    throw new TypeError(`gst.quote: unknown mode ${JSON.stringify(mode)}`);
  }
  if (subtotalPaise === 0) {
    return {
      mode, currency: CURRENCY, subtotalPaise: 0, taxablePaise: 0,
      components: [], gstPaise: 0, totalPaise: 0,
      bonusPaise: 0, creditPaise: 0, placeOfSupply: null,
    };
  }

  const parsed = customerGstin ? parseGstin(customerGstin) : { present: false, valid: false, stateCode: null };
  if (parsed.present && !parsed.valid) {
    throw new TypeError(`gst.quote: customerGstin is not a valid GSTIN (${parsed.reason})`);
  }

  const place = resolvePlaceOfSupply({
    supplierStateCode,
    customerStateCode: parsed.stateCode || customerStateCode,
  });
  const supplier = String(supplierStateCode || '').padStart(2, '0');
  const interstate = place.code !== supplier;

  const components = interstate
    ? [{ name: 'IGST', rateBps: IGST_RATE_BPS }]
    : [{ name: 'CGST', rateBps: CGST_RATE_BPS }, { name: 'SGST', rateBps: SGST_RATE_BPS }];

  const taxablePaise = subtotalPaise;
  const priced = components.map((c) => ({
    name: c.name,
    rateBps: c.rateBps,
    paise: roundHalfUpPaise((taxablePaise * c.rateBps) / BPS),
  }));
  const gstPaise = priced.reduce((sum, c) => sum + c.paise, 0);

  return {
    mode,
    currency: CURRENCY,
    subtotalPaise,
    taxablePaise,
    components: priced,
    gstPaise,
    totalPaise: subtotalPaise + gstPaise,
    bonusPaise: roundHalfUpPaise((subtotalPaise * couponBps) / BPS),
    creditPaise: subtotalPaise,
    placeOfSupply: {
      type: interstate ? 'interstate' : 'intrastate',
      stateCode: place.code,
      supplierStateCode: supplier,
      assumed: place.assumed,
      basis: place.basis,
    },
  };
}

/** The `order_amount` Cashfree expects: rupees, two decimals, no float artifacts. */
function toCashfreeOrderAmount(totalPaise) {
  const paise = Number(totalPaise) || 0;
  return (Math.trunc(paise) / 100).toFixed(2);
}

module.exports = {
  BPS,
  CURRENCY,
  GST_RATE_BPS,
  CGST_RATE_BPS,
  SGST_RATE_BPS,
  IGST_RATE_BPS,
  roundHalfUpPaise,
  parseGstin,
  resolvePlaceOfSupply,
  quote,
  toCashfreeOrderAmount,
};
