'use strict';

// Deterministic FX for the math below (set BEFORE config loads).
process.env.USD_TO_INR = '100';

const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('./pricing');

test('usdToPaise converts with the configured FX rate and rounds to integer paise', () => {
  assert.equal(pricing.usdToPaise(1), 10000); // 1 USD × 100 INR × 100 paise
  assert.equal(pricing.usdToPaise(0.005), 50); // 0.005 × 100 × 100 = 50
  assert.equal(pricing.usdToPaise(0.00001), 0); // 0.1 paise rounds down to 0
});

test('usdToPaise returns 0 for zero, negative, or non-finite input', () => {
  assert.equal(pricing.usdToPaise(0), 0);
  assert.equal(pricing.usdToPaise(-5), 0);
  assert.equal(pricing.usdToPaise(NaN), 0);
  assert.equal(pricing.usdToPaise('x'), 0);
});

test('paiseToInr divides by 100', () => {
  assert.equal(pricing.paiseToInr(12345), 123.45);
  assert.equal(pricing.paiseToInr(0), 0);
});

test('costUsdFromResult prefers a runtime-reported costUsd (Claude passthrough)', () => {
  const cost = pricing.costUsdFromResult({ costUsd: 0.42, usage: { inputTokens: 1000, outputTokens: 1000 } }, { provider: 'claude' });
  assert.equal(cost, 0.42);
});

test('costUsdFromResult estimates from tokens when no costUsd is reported (Codex)', () => {
  // codex table: input 2.5 / output 10 USD per 1M tokens.
  const cost = pricing.costUsdFromResult({ costUsd: null, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }, { provider: 'codex' });
  assert.equal(cost, 12.5);
});

test('costUsdFromResult meters local providers at zero', () => {
  const cost = pricing.costUsdFromResult({ usage: { inputTokens: 500_000, outputTokens: 500_000 } }, { provider: 'ollama' });
  assert.equal(cost, 0);
});

test('estimateCostUsd falls back to a conservative default for unknown providers', () => {
  // default table: input 3 / output 15 per 1M.
  assert.equal(pricing.estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, 'mystery'), 3);
});
