'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('./pricing');

// Every expectation here is a hand multiplication against deploy/billing/credit-rates.yaml,
// so that a card edit has to be answered in this file before it can become a number a
// customer sees. The card prices the claude family at ₹261 per 1M input and ₹1,305 per 1M
// output tokens, hence:
//   100k in + 20k out = ₹26.10 + ₹26.10 = ₹52.20 = 5,220 token credits
//   1k in   + 1k out  = ₹0.261 + ₹1.305 = ₹1.566 =   157 token credits (rounded once)
const CLAUDE_100K_20K = { inputTokens: 100000, outputTokens: 20000, totalTokens: 120000 };

test('the card prices the run, not the number the SDK chose to report', () => {
  // The card's ₹52.20 and the SDK's $0.10 describe the same run and disagree by design:
  // a debit that depends on a self-reported amount is a debit the model gets to set.
  const tc = pricing.costTokenCreditsFromResult(
    { usage: CLAUDE_100K_20K, costUsd: 0.10 },
    { provider: 'claude', model: 'claude-sonnet-5' },
  );
  assert.equal(tc, 5220);
});

test('a run rounds once, at the credit boundary, not once per priced dimension', () => {
  // ₹1.305 + ₹0.6525 = ₹1.9575 → 195.75 token credits. Rounding each component first
  // would give 131 + 66 = 197, and nobody could say which run produced which number.
  const tc = pricing.costTokenCreditsFromResult(
    { usage: { inputTokens: 5000, outputTokens: 500, totalTokens: 5500 } },
    { provider: 'claude' },
  );
  assert.equal(tc, 196);
});

test('a local run is priced at zero, which is an answer rather than a missing price', () => {
  const priced = pricing.priceRun({
    usage: { inputTokens: 500000, outputTokens: 500000 },
    llm: { provider: 'ollama', model: 'qwen' },
  });
  assert.equal(priced.tokenCredits, 0);
  assert.equal(priced.rateMatch, 'Provider', 'ollama is a listed provider at 0/0');
  assert.equal(priced.priceMatch, 'Exact');
});

test('an unlisted provider is priced from the fallback row and labeled as a guess', () => {
  const priced = pricing.priceRun({ usage: CLAUDE_100K_20K, llm: { provider: 'brand-new-runtime' } });
  assert.equal(priced.priceMatch, 'Default', 'the alert contract: a fallback number is countable');
  assert.equal(priced.rateMatch, 'Default', 'the drill-down contract: which row answered');
  assert.equal(priced.tokenCredits, 5220, 'the fallback row mirrors the most expensive priced family');
});

test('the runtime-reported cost is provenance: a decimal string, never a float on the wire', () => {
  assert.deepEqual(pricing.reportedCost({ costUsd: 0.1 }), { providerCost: '0.1', providerCurrency: 'USD' });
  assert.deepEqual(pricing.reportedCost({ costUsd: 0.000000001234 }), {
    providerCost: '0', providerCurrency: 'USD',
  }, 'below 8 dp a runtime is reporting nothing, and exponent notation must never reach the event');
  assert.deepEqual(pricing.reportedCost({ costUsd: '0.42', costCurrency: 'usd' }),
    { providerCost: '0.42', providerCurrency: 'USD' });
  assert.deepEqual(pricing.reportedCost({}), { providerCost: null, providerCurrency: null },
    'Codex, Gemini and every local run report no cost — the normal case');
  assert.deepEqual(pricing.reportedCost({ costUsd: -1 }), { providerCost: null, providerCurrency: null });
});

test('a priced run states its money and its provenance in one answer', () => {
  const priced = pricing.priceRun({
    usage: CLAUDE_100K_20K,
    llm: { provider: 'claude', model: 'claude-sonnet-5' },
    result: { costUsd: 0.10 },
  });
  assert.equal(priced.tokenCredits, 5220);
  assert.equal(priced.inrCost, '52.20', 'a decimal STRING, so no reader mistakes it for the metered int');
  assert.equal(priced.fxRateToInr, '87.00', 'stamped from the card, and used for nothing but the stamp');
  assert.equal(priced.providerCost, '0.1');
  assert.deepEqual(priced.counts, { inputTokens: 100000, outputTokens: 20000, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test('the four priced dimensions come from whatever the runtime called them', () => {
  // The harness normalizes usage, but a record written before a rename is still readable:
  // one extraction, so the counts on the record and the counts the debit came from agree.
  assert.deepEqual(pricing.tokenCountsOf({
    inputTokens: '1000', outputTokens: 500.9,
    cachedInputTokens: 40, cacheCreationInputTokens: 7,
  }), { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 40, cacheWriteTokens: 7 });
  assert.deepEqual(pricing.tokenCountsOf({ input_tokens: 5 }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    'an unrecognized spelling is a zero, and a zero is not a silent discount on a real model');
});

test('priceMatchOf answers with the label alone, for a caller that will not reprice', () => {
  assert.equal(pricing.priceMatchOf({ model: 'claude-sonnet-5', provider: 'claude' }), 'Exact');
  assert.equal(pricing.priceMatchOf({ provider: 'CLAUDE' }), 'Exact', 'the provider lookup is case-insensitive');
  assert.equal(pricing.priceMatchOf({ provider: 'ollama' }), 'Exact', 'modeled at zero is still modeled');
  assert.equal(pricing.priceMatchOf({ provider: 'brand-new-runtime' }), 'Default');
  assert.equal(pricing.priceMatchOf({}), 'Default', 'no provider at all is the same finding');
});

test('paiseToInr divides by 100', () => {
  assert.equal(pricing.paiseToInr(12345), 123.45);
  assert.equal(pricing.paiseToInr(0), 0);
  assert.equal(pricing.paiseToInr(undefined), 0);
});

test('no USD table and no FX multiplication survive on the cost path', () => {
  // The D9 finding, encoded: `usdToPaise` and `PRICE_PER_MTOK_USD` are gone, so there is
  // no remaining code path in which a currency rate moves a customer's debit.
  assert.equal(pricing.usdToPaise, undefined);
  assert.equal(pricing.PRICE_PER_MTOK_USD, undefined);
  assert.equal(pricing.costUsdFromResult, undefined, 'renamed to reportedCost — it computes nothing');
});
