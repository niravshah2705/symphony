'use strict';

const creditRates = require('./credit-rates');
const { creditsFromTokenCredits } = require('./money-wire');

// A runtime may report a cost to the nanoruupee; below 8 dp it is reporting nothing.
// The bound exists so a float never reaches the wire in exponent notation.
const REPORTED_USD_DP = 8;

/**
 * SDK-free cost helpers for billing, priced from the rate card.
 *
 * The card (`deploy/billing/credit-rates.yaml`) is the AUTHORITATIVE source for a
 * debit: `token_credits = tokens x INR-per-1M-tokens`. A runtime's self-reported
 * `costUsd` used to win over every estimate, which made the platform's charge depend
 * on a number the model's own SDK chose, at an FX rate nobody in `deploy/` ever set.
 * That number is now recorded as PROVENANCE on the event (`provider_cost`,
 * `provider_currency`) so a discrepancy is auditable, and it computes nothing — which
 * is also why no FX multiplication is on the money path any more.
 *
 * Two consequences worth stating plainly: a rate change is a card edit plus a
 * redeploy (the card is memoised per process, deliberately), and an unknown model
 * falls back to the provider row, then to `defaults`, and is LABELLED so the alert
 * counts it. An estimate beats an unmetered run; a silent estimate beats neither.
 */

function whole(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * The four token dimensions the card prices, from whatever the runtime called them.
 *
 * `cachedInputTokens` / `cacheCreationInputTokens` are the harness-normalised names
 * (contract.js normalizeUsage, straight from the SDKs); the `cacheRead`/`cacheWrite`
 * spellings are what this module persists and what the event property is called. A
 * run that reports no cache usage prices at 0 for those dimensions, which is the
 * correct answer rather than a missing one.
 */
function tokenCountsOf(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  return {
    inputTokens: whole(u.inputTokens),
    outputTokens: whole(u.outputTokens),
    cacheReadTokens: whole(u.cacheReadTokens ?? u.cachedInputTokens ?? u.cache_read_input_tokens),
    cacheWriteTokens: whole(u.cacheWriteTokens ?? u.cacheCreationInputTokens ?? u.cache_creation_input_tokens),
  };
}

/** Bounded-precision decimal TEXT: no float artefacts, no exponent notation. */
function decimalText(value, dp) {
  const fixed = Number(value).toFixed(dp);
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/\.?0+$/, '') || '0';
}

/**
 * What the provider says it billed, in the currency it billed it in.
 *
 * Provenance only — this never becomes a money source. `null` means the runtime
 * reported nothing (Codex, Gemini and every local provider), which is the normal
 * case and is exactly why the card prices the run instead.
 */
function reportedCost(result) {
  const r = result && typeof result === 'object' ? result : {};
  const amount = Number(r.costUsd);
  if (!Number.isFinite(amount) || amount < 0) {
    return { providerCost: null, providerCurrency: null };
  }
  return {
    providerCost: decimalText(amount, REPORTED_USD_DP),
    providerCurrency: String(r.costCurrency || 'USD').toUpperCase(),
  };
}

/**
 * Price one run from the card: its money, how the price was found, and its provenance.
 *
 * `priceMatch` is the label Cloud Logging alerts on and has exactly two values now
 * that the card decides the debit: `Exact` (the card models this model or its
 * provider) or `Default` (priced from the last-resort row, i.e. a guess). The third
 * value it used to carry, `Reported`, described a run whose SDK number WAS the charge;
 * that is no longer true of any run, so keeping the label would have been a claim the
 * code does not honour. `rateMatch` keeps the card's finer answer — `Card`,
 * `Provider` or `Default` — for the drill-down that wants to know whether the model
 * itself is priced or only its provider.
 */
function priceRun({ usage, llm, result } = {}) {
  const counts = tokenCountsOf(usage ?? (result && result.usage));
  const prices = creditRates.priceFor({ model: llm && llm.model, provider: llm && llm.provider });
  const tokenCredits = creditRates.tokenCreditsFromTokens(counts, prices);
  return {
    counts,
    tokenCredits,
    priceMatch: prices.match === 'Default' ? 'Default' : 'Exact',
    rateMatch: prices.match,
    // The row the money came from, so a caller can tell "priced at zero" (a local
    // run: a real answer) from "priced into nothing" (a rounding: a finding).
    prices,
    // D6 makes this the same string twice over: 1 credit is ₹1, so the credit
    // rendering of a token-credit integer IS its rupee rendering. It is emitted as a
    // decimal STRING so a reader cannot mistake the audit figure for the metered int.
    inrCost: creditsFromTokenCredits(tokenCredits),
    fxRateToInr: creditRates.fxRate().usdToInr,
    ...reportedCost(result),
  };
}

/** The integer token credits one run costs, priced from the card. */
function costTokenCreditsFromResult(result, llm) {
  return priceRun({ usage: result && result.usage, llm, result }).tokenCredits;
}

/**
 * Whether the card models this run's model/provider — the alert-contract half of
 * `priceRun`, exposed for a caller that wants the label without repricing.
 */
function priceMatchOf({ model, provider } = {}) {
  return creditRates.priceFor({ model, provider }).match === 'Default' ? 'Default' : 'Exact';
}

/**
 * A subunit integer → a rupee number, for the admin ₹ column and the ₹ in a
 * notification line. Every caller hands it token credits (a balance, a run's cost) and
 * D6 makes 100 of them worth ₹1 either way; a figure that is a payment or a tax is
 * still paise, and both divide by the same 100.
 */
function paiseToInr(paise) {
  return (Number(paise) || 0) / 100;
}

module.exports = {
  priceRun,
  costTokenCreditsFromResult,
  priceMatchOf,
  tokenCountsOf,
  reportedCost,
  paiseToInr,
};
