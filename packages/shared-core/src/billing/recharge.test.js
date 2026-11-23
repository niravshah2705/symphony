'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const recharge = require('./recharge');

const { getEffectiveThresholdTokenCredits } = recharge;

test('amount mode compares against the configured token-credit trigger', () => {
  const account = { initialCreditTokenCredits: 50000 };
  assert.equal(getEffectiveThresholdTokenCredits(account, { mode: 'amount', thresholdTokenCredits: 40000 }), 40000);
  assert.equal(getEffectiveThresholdTokenCredits(account, { thresholdTokenCredits: 12345 }), 12345, 'amount is the default mode');
  assert.equal(getEffectiveThresholdTokenCredits(account, { mode: 'amount' }), 0, 'no trigger configured never fires');
});

// The percentage is a share of the ORG'S OPENING CREDIT, which is configuration.
// It used to be a share of the local balance, which is a number this repo no longer
// holds — and the two only agreed until the first FlexPrice-side draw.
test('percentage mode is a share of the opening credit', () => {
  assert.equal(getEffectiveThresholdTokenCredits({ initialCreditTokenCredits: 50000 }, { mode: 'percentage', thresholdPercent: 20 }), 10000);
  assert.equal(getEffectiveThresholdTokenCredits({ initialCreditTokenCredits: 50000 }, { mode: 'percentage', thresholdPercent: 1 }), 500);
  assert.equal(getEffectiveThresholdTokenCredits({ initialCreditTokenCredits: 50000 }, { mode: 'percentage' }), 10000, 'defaults to 20%');
  assert.equal(getEffectiveThresholdTokenCredits({}, { mode: 'percentage', thresholdPercent: 50 }), 0, 'no opening credit, no trigger');
});

test('a percentage trigger stays in whole token credits', () => {
  // 3333 token credits of opening credit at 25% is 833.25: a fractional trigger would
  // make the comparison depend on float noise rather than on the wallet.
  assert.equal(getEffectiveThresholdTokenCredits({ initialCreditTokenCredits: 3333 }, { mode: 'percentage', thresholdPercent: 25 }), 833);
});

test('garbage in the config never becomes a charge', () => {
  assert.equal(getEffectiveThresholdTokenCredits({}, { mode: 'amount', thresholdTokenCredits: 'abc' }), 0);
  assert.equal(getEffectiveThresholdTokenCredits({}, { mode: 'percentage', thresholdPercent: 'abc' }), 0);
  assert.equal(getEffectiveThresholdTokenCredits({ initialCreditTokenCredits: null }, { mode: 'percentage', thresholdPercent: 20 }), 0);
});

// This module used to charge the mandate AND credit the local ledger. The credit
// half was deleted with the local balance — only services/billing/src/recharge-settle.js
// may move money, and only against a quoted intent — and the charge half cannot move
// to it until mandate-on-wallet settlement is built (docs/BILLING_FLEXPRICE.md §10).
// A module that charges without crediting is the worst of both, so it charges nothing.
test('this module moves no money', () => {
  assert.deepEqual(Object.keys(recharge), ['getEffectiveThresholdTokenCredits']);
  assert.equal(recharge.maybeAutoRecharge, undefined);
});
