'use strict';

const { CONFIG } = require('../config');

/**
 * Cost + currency helpers for billing. Money is handled in INTEGER paise
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

/** Convert USD to integer paise using the configured (approximate) FX rate. */
function usdToPaise(usd, rate = CONFIG.BILLING.usdToInr) {
  const amount = Number(usd);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * rate * 100);
}

/** Convert integer paise to a rupee number (for display only). */
function paiseToInr(paise) {
  return (Number(paise) || 0) / 100;
}

module.exports = {
  PER_MTOK_USD_DEFAULT,
  PRICE_PER_MTOK_USD,
  rateFor,
  estimateCostUsd,
  costUsdFromResult,
  usdToPaise,
  paiseToInr,
};
