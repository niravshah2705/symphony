'use strict';

const { CONFIG } = require('../config');
const { decimalToScaled, roundDiv } = require('./money-wire');

// The precision this module is willing to multiply: 8 dp of USD (a provider
// reporting below that is reporting nothing) and 4 dp of FX (an operator who
// sets USD_TO_INR=87.5321 gets exactly that).
const USD_DP = 8;
const FX_DP = 4;

/**
 * SDK-free cost + currency helpers for billing. Money is handled in INTEGER paise
 * everywhere (never floating INR) to avoid rounding drift.
 *
 * Third-party LLM cost is billed in USD, but only some runtimes report a billed
 * `costUsd` (Claude Agent SDK does; Codex / Gemini / local do not). When a run
 * reports tokens but no USD, we ESTIMATE cost from a conservative per-provider
 * price table so no spend goes unmetered. Rates are indicative list prices
 * (they drift) — this produces a billing estimate, not an invoice.
 */

// Conservative blended default (USD per 1M tokens) for an unknown provider.
const PER_MTOK_USD_DEFAULT = Object.freeze({ input: 3, output: 15 });

// provider -> { input, output } USD per 1M tokens. Local providers are
// self-hosted, so they cost nothing to call but are still recorded (token
// volume shows on the cost page even at zero spend).
const PRICE_PER_MTOK_USD = Object.freeze({
  claude: { input: 3, output: 15 },
  codex: { input: 2.5, output: 10 },
  antigravity: { input: 1.25, output: 5 },
  ollama: { input: 0, output: 0 },
  lmstudio: { input: 0, output: 0 },
  omlx: { input: 0, output: 0 },
  huggingface: { input: 0, output: 0 },
});

/** The per-1M-token USD rate for a provider (falls back to a conservative default). */
function rateFor(provider) {
  return PRICE_PER_MTOK_USD[String(provider || '').toLowerCase()] || PER_MTOK_USD_DEFAULT;
}

/**
 * How the cost number was obtained, so an estimate built from the fallback rate
 * is countable rather than silent. `Reported` means the runtime billed it and no
 * table was consulted; `Exact` means this catalog models the provider (ollama at
 * 0/0 is modeled, not missing); `Default` means it does not, and the run was
 * priced by guess. A `Default` row is the money version of an unmodeled gateway
 * key: the number is plausible, wrong, and currently invisible.
 */
function priceMatchOf(provider, reportedUsd) {
  if (Number(reportedUsd) > 0) return 'Reported';
  return PRICE_PER_MTOK_USD[String(provider || '').toLowerCase()] ? 'Exact' : 'Default';
}

/** Estimate USD from a normalized usage object using the per-provider table. */
function estimateCostUsd(usage, provider) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const input = Number(u.inputTokens) || 0;
  const output = Number(u.outputTokens) || 0;
  const rate = rateFor(provider);
  return (input / 1e6) * rate.input + (output / 1e6) * rate.output;
}

/**
 * Resolve the USD cost of a run: prefer the runtime-reported `costUsd` (Claude
 * and any SDK that bills), else estimate from tokens. Always returns a finite
 * number >= 0.
 */
function costUsdFromResult(result, llm) {
  const reported = result && Number.isFinite(Number(result.costUsd)) ? Number(result.costUsd) : null;
  if (reported !== null && reported > 0) return reported;
  const provider = (llm && llm.provider) || (result && result.provider) || '';
  const estimated = estimateCostUsd(result && result.usage, provider);
  if (Number.isFinite(estimated) && estimated > 0) return estimated;
  return reported !== null && reported >= 0 ? reported : 0;
}

/**
 * Convert USD to integer paise using the configured FX rate.
 *
 * This is a money-path multiplication, not a display one: since Phase 3 the
 * result is the `cost_paise` the outbox delivers and the wallet is debited
 * against. So it is BigInt on digit strings (see money-wire.js) rather than
 * `Math.round(usd * rate * 100)` — binary float puts some exact halves just
 * below themselves, which would short every such run by a paise in a direction
 * that never varies and never fails a check.
 *
 * `toFixed` bounds the precision we claim: a cost reported to the nanoruupee is
 * still a whole-paise charge, and anything below half a paise is zero rather
 * than an exponent-notation string the decimal parser would refuse.
 */
function usdToPaise(usd, rate = CONFIG.BILLING.usdToInr) {
  const amount = Number(usd);
  const fx = Number(rate);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!Number.isFinite(fx) || fx <= 0) return 0;
  const scaled = decimalToScaled(amount.toFixed(USD_DP), USD_DP)
    * decimalToScaled(fx.toFixed(FX_DP), FX_DP)
    * 100n;
  return Number(roundDiv(scaled, 10n ** BigInt(USD_DP + FX_DP)));
}

/** Convert integer paise to a rupee number (for display only). */
function paiseToInr(paise) {
  return (Number(paise) || 0) / 100;
}

module.exports = {
  PER_MTOK_USD_DEFAULT,
  PRICE_PER_MTOK_USD,
  rateFor,
  priceMatchOf,
  estimateCostUsd,
  costUsdFromResult,
  usdToPaise,
  paiseToInr,
};
