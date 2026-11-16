'use strict';

// How a confirmed payment becomes wallet credit.
//
// Two rules hold this together:
//
//  1. `1 credit = ₹1 = 100 paise` of prepaid value (D6), and the unit lives in
//     exactly one place — `money-wire.PAISE_PER_CREDIT`, re-exported below.
//     Probe A confirmed the direction: FlexPrice's `credits_to_add` is
//     denominated in credits and `conversion_rate:'1'` scales credits to rupees
//     1:1, so 500 paise of rupees is 500 credits. The credit unit is never
//     re-denominated. A promotional ratio ("pay ₹500, get ₹550 of usage") is
//     expressed as a *separate expiring promotional wallet*, not by moving the
//     exchange rate — otherwise one org's balance is in a different unit than
//     another's and no report can add them up.
//
//  2. GST collected is never credit. ₹590 is charged, ₹500 is spendable. The
//     ₹90 is tax owed to the exchequer; crediting it would give away 18% of the
//     tax on every recharge, which reads as a generous promotion until it is the
//     whole margin. `topUpCrediting` therefore takes the quote object rather
//     than a number, so a caller structurally cannot hand it the total.

const { roundHalfUpPaise } = require('./gst');
const { PAISE_PER_CREDIT } = require('./money-wire');

const BPS = 10000;
const CREDIT_SOURCE_PREPAID = 'prepaid';
const CREDIT_SOURCE_PROMOTIONAL = 'promotional';

/** Bonus credit for a coupon/bonus ratio, in paise of promotional wallet value. */
function bonusPaise(subtotalPaise, bonusBps = 0) {
  if (!Number.isInteger(subtotalPaise) || subtotalPaise < 0) {
    throw new TypeError(`credits.bonusPaise: subtotalPaise must be a non-negative integer, got ${JSON.stringify(subtotalPaise)}`);
  }
  if (!Number.isInteger(bonusBps) || bonusBps < 0) {
    throw new TypeError(`credits.bonusPaise: bonusBps must be a non-negative integer, got ${JSON.stringify(bonusBps)}`);
  }
  return roundHalfUpPaise((subtotalPaise * bonusBps) / BPS);
}

/**
 * The credit instructions for one settled recharge.
 *
 * `quote` is the result of `gst.quote()` for this order. Its `subtotalPaise` is
 * the taxable value the user chose to load, and that — never `totalPaise` — is
 * what lands in the prepaid wallet.
 */
function topUpCrediting({ quote, bonusBps = 0, expiresAt = null } = {}) {
  if (!quote || !Number.isInteger(quote.subtotalPaise) || !Number.isInteger(quote.totalPaise)) {
    throw new TypeError('credits.topUpCrediting: quote must be a gst.quote() result with integer paise fields');
  }
  if (quote.totalPaise < quote.subtotalPaise) {
    throw new TypeError('credits.topUpCrediting: quote total is below its own subtotal');
  }

  const bonus = bonusBps > 0 ? bonusPaise(quote.subtotalPaise, bonusBps) : (quote.bonusPaise || 0);
  const prepaidPaise = quote.subtotalPaise;

  return {
    currency: quote.currency || 'INR',
    prepaidPaise,
    prepaidCredits: prepaidPaise / PAISE_PER_CREDIT,
    promoPaise: bonus,
    promoCredits: bonus / PAISE_PER_CREDIT,
    promoExpiresAt: bonus > 0 ? expiresAt : null,
    collectedPaise: quote.totalPaise,
    // Kept beside the credit so a report can show "you paid X, Y is tax" and an
    // auditor can tie it to the invoice without recomputing anything.
    gstPaise: quote.gstPaise || 0,
    instructions: [
      { walletType: CREDIT_SOURCE_PREPAID, amountPaise: prepaidPaise, expiry: null },
      ...(bonus > 0
        ? [{ walletType: CREDIT_SOURCE_PROMOTIONAL, amountPaise: bonus, expiry: expiresAt || null }]
        : []),
    ],
  };
}

/**
 * Guard for any path that credits from a number it computed itself.
 *
 * The failure this catches is quiet: a recharge of ₹500 that credits ₹590 is not
 * an error anywhere, the balance simply looks right, and 18% of every tax rupee
 * has become spendable. If `amountPaise` matches a quote's tax-inclusive total
 * while tax was charged, that is what happened.
 */
function assertNoTaxCredited({ amountPaise, quote }) {
  const amount = Number(amountPaise) || 0;
  const tax = Number(quote && quote.gstPaise) || 0;
  if (tax > 0 && amount === quote.totalPaise && amount !== quote.subtotalPaise) {
    throw new Error(
      `credits: refusing to credit ${amount}p — that is the GST-inclusive total (subtotal ${quote.subtotalPaise}p + ${tax}p tax). Credit the subtotal only.`,
    );
  }
  if (tax > 0 && amount > quote.subtotalPaise) {
    throw new Error(
      `credits: refusing to credit ${amount}p — more than the ${quote.subtotalPaise}p taxable value of this recharge.`,
    );
  }
  return amount;
}

/**
 * The order a debit draws from multiple credit sources.
 *
 * Promotional first, earliest expiry first, so a bonus that is about to lapse
 * is used before real money is touched. Drawing prepaid first would let bonus
 * credits expire unused on accounts that spend plenty — the customer loses a
 * benefit they were promised while the platform keeps the invoice.
 */
function drawOrderForDebit(balances = [], debitPaise) {
  const debit = Number(debitPaise) || 0;
  if (debit <= 0) return [];
  const ranked = [...balances]
    .filter((b) => (Number(b.amountPaise) || 0) > 0)
    .sort((a, b) => {
      const aPromo = a.walletType === CREDIT_SOURCE_PROMOTIONAL ? 0 : 1;
      const bPromo = b.walletType === CREDIT_SOURCE_PROMOTIONAL ? 0 : 1;
      if (aPromo !== bPromo) return aPromo - bPromo;
      const aExp = a.expiresAt ? Date.parse(a.expiresAt) : Number.MAX_SAFE_INTEGER;
      const bExp = b.expiresAt ? Date.parse(b.expiresAt) : Number.MAX_SAFE_INTEGER;
      if (aExp !== bExp) return aExp - bExp;
      return String(a.walletId || '').localeCompare(String(b.walletId || ''));
    });

  let remaining = debit;
  const draws = [];
  for (const wallet of ranked) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, wallet.amountPaise);
    draws.push({ walletId: wallet.walletId || null, walletType: wallet.walletType, amountPaise: take });
    remaining -= take;
  }
  return draws;
}

module.exports = {
  BPS,
  PAISE_PER_CREDIT,
  CREDIT_SOURCE_PREPAID,
  CREDIT_SOURCE_PROMOTIONAL,
  bonusPaise,
  topUpCrediting,
  assertNoTaxCredited,
  drawOrderForDebit,
};
