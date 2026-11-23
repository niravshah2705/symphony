'use strict';

// The rate card loader's contract, in both directions: what it accepts, and the exact
// refusal for the config mistakes an operator can actually make. The error strings are
// asserted because they are the only documentation a booting service gives anyone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rates = require('./credit-rates');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'credit-rates-'));
let seq = 0;

/** Write a card fixture and return its path (each test gets its own file). */
function cardFile(text) {
  const file = path.join(DIR, `card-${(seq += 1)}.yaml`);
  fs.writeFileSync(file, text);
  return file;
}

const VALID = `
schema_version: 1
fx: { usd_to_inr: "87.00", as_of: "2026-11-01", stale_after_days: 45, drift_bps_per_day: 15 }
reconcile: { base_tolerance_bps: 100, max_tolerance_bps: 1000 }
limits: { max_package_price_inr: 1000000, max_bonus_bps: 100000 }
models:
  claude-sonnet-5: { input_inr_per_mtok: "261", output_inr_per_mtok: "1305" }
providers:
  ollama: { input_inr_per_mtok: "0", output_inr_per_mtok: "0" }
defaults: { model: { input_inr_per_mtok: "261", output_inr_per_mtok: "1305" } }
packages:
  - { id: credits-3500, price_inr: "2000", credits: 3500, bonus_valid_days: 30, enabled: true }
  - { id: credits-10000, price_inr: "4000", credits: 10000, bonus_valid_days: 45, enabled: false }
`;

/** VALID with one line replaced, so each case states only its own difference. */
function mutate(find, replace) {
  if (!VALID.includes(find)) throw new Error(`fixture does not contain: ${find}`);
  return VALID.replace(find, replace);
}

function load(text) {
  return rates.loadCard({ file: cardFile(text) });
}

test('a valid card loads as a frozen structure with money kept as strings', () => {
  const card = load(VALID);
  assert.equal(card.version, 1);
  assert.equal(card.fx.usdToInr, '87.00');
  assert.deepEqual(card.models['claude-sonnet-5'], {
    input: '261', output: '1305', cacheRead: '0', cacheWrite: '0',
  });
  assert.equal(Object.isFrozen(card), true);
  assert.equal(Object.isFrozen(card.packages), true);
  const pkg = card.packages[0];
  assert.deepEqual(
    {
      subtotalPaise: pkg.subtotalPaise,
      couponBps: pkg.couponBps,
      bonusTokenCredits: pkg.bonusTokenCredits,
      prepaidCredits: pkg.prepaidCredits,
      bonusCredits: pkg.bonusCredits,
      credits: pkg.credits,
    },
    { subtotalPaise: 200000, couponBps: 7500, bonusTokenCredits: 150000, prepaidCredits: 2000, bonusCredits: 1500, credits: 3500 },
    'the rupee side stays rupee-named and the credit side credit-named',
  );
});

test('a price written as a bare YAML number is refused, not coerced', () => {
  assert.throws(
    () => load(mutate('input_inr_per_mtok: "261", output_inr_per_mtok: "1305" }', 'input_inr_per_mtok: 261, output_inr_per_mtok: "1305" }')),
    /models\.claude-sonnet-5\.input_inr_per_mtok must be a quoted decimal STRING/,
  );
});

test('an absent output price is a refusal, because an absent key is not a zero', () => {
  assert.throws(
    () => load(mutate('{ input_inr_per_mtok: "261", output_inr_per_mtok: "1305" }', '{ input_inr_per_mtok: "261" }')),
    /missing output_inr_per_mtok — an absent key is not a zero/,
  );
});

test('a zero FX rate is refused with the reason it matters', () => {
  assert.throws(
    () => load(mutate('usd_to_inr: "87.00"', 'usd_to_inr: "0.00"')),
    /a zero rate makes LiteLLM's spend convert to zero, so every window would report match at any delta/,
  );
});

test('a duplicated key fails instead of silently last-wins', () => {
  assert.throws(
    () => load(`${VALID}\nmodels:\n  other: { input_inr_per_mtok: "1", output_inr_per_mtok: "1" }\n`),
    /credit-rates: .* does not parse/,
  );
});

test('an unknown top-level key is refused: a typo here is a section nobody reads', () => {
  assert.throws(() => load(`${VALID}\nmodelz:\n  x: {}\n`), /unknown top-level key 'modelz'/);
  assert.throws(() => load(mutate('schema_version: 1', 'schema_version: 2')), /schema_version must be 1/);
  assert.throws(() => load(mutate('output_inr_per_mtok: "1305" }', 'output_inr_per_mtok: "1305", ttl_inr_per_mtok: "1" }')),
    /models\.claude-sonnet-5: unknown price key 'ttl_inr_per_mtok'/);
});

test('defaults.model is required — it is the last-resort price, not a nicety', () => {
  assert.throws(() => load(VALID.replace(/defaults: \{[^\n]*\}\n/, '')),
    /defaults\.model is required/);
});

test('a package whose bonus is not an exact basis-point ratio is refused', () => {
  assert.throws(
    () => load(mutate('{ id: credits-3500, price_inr: "2000", credits: 3500', '{ id: credits-300, price_inr: "300", credits: 500')),
    /credits-300: the bonus of 200 credits on ₹300 is not an exact basis-point ratio/,
  );
});

test('a package over the bonus cap is refused, and under it is not', () => {
  // 100000 bps = a 1000% bonus: the cap the ₹4000 → 10,000-credit offer needed room for.
  assert.throws(
    () => load(mutate('price_inr: "4000", credits: 10000', 'price_inr: "4000", credits: 404000')),
    /of bonus exceeds limits\.max_bonus_bps 100000/,
  );
  assert.equal(load(mutate('price_inr: "4000", credits: 10000', 'price_inr: "4000", credits: 44000')).packages[1].couponBps, 100000);
});

test('a package may grant a bonus and never take one', () => {
  assert.throws(() => load(mutate('credits: 3500', 'credits: 1500')), /never take one/);
});

test('a package price with paise in it is refused: a recharge is whole rupees because 1 credit = ₹1', () => {
  assert.throws(() => load(mutate('price_inr: "2000"', 'price_inr: "1999.50"')),
    /price_inr must be a quoted string of WHOLE rupees/);
});

test('duplicate package ids are refused rather than shadowed', () => {
  assert.throws(() => load(mutate('id: credits-10000', 'id: credits-3500')), /listed twice/);
});

test('the bonus cap is refused when the float multiply could not represent it', () => {
  assert.throws(
    () => load(VALID
      .replace('max_package_price_inr: 1000000', 'max_package_price_inr: 100000000000')
      .replace('max_bonus_bps: 100000', 'max_bonus_bps: 1000000000')),
    /overflows a safe integer in the float bonus multiply/,
  );
});

test('an empty package list is refused: a store with no products is a broken deploy', () => {
  assert.throws(() => load(VALID.replace(/packages:\n(?:  .*\n)+/, 'packages: []\n')),
    /packages must list at least one purchasable package/);
});

test('priceFor reports how it found the number, and only Default is a guess', () => {
  const card = load(VALID);
  assert.equal(rates.priceFor({ model: 'claude-sonnet-5', provider: 'claude' }, { card }).match, 'Card');
  assert.equal(rates.priceFor({ model: 'ollama', provider: 'ollama' }, { card }).match, 'Provider');
  assert.equal(rates.priceFor({ model: 'ollama', provider: ' Ollama ' }, { card }).match, 'Provider',
    'provider keys are case- and space-insensitive, as the usage record spells them');
  const guess = rates.priceFor({ model: 'gpt-9', provider: 'unknown' }, { card });
  assert.equal(guess.match, 'Default');
  assert.equal(guess.input, '261');
});

test('tokenCreditsFromTokens multiplies on digits and rounds exactly once', () => {
  const card = load(VALID);
  const claude = rates.priceFor({ model: 'claude-sonnet-5' }, { card });
  // 100k input at ₹261/1M = ₹26.10 of value = 2610 token credits, exactly.
  assert.equal(rates.tokenCreditsFromTokens({ inputTokens: 100000 }, claude), 2610);
  assert.equal(rates.tokenCreditsFromTokens({ inputTokens: 100000, outputTokens: 20000 }, claude), 2610 + 2610);
  assert.equal(rates.tokenCreditsFromTokens({ inputTokens: 0, outputTokens: 0 }, claude), 0);
  assert.equal(rates.tokenCreditsFromTokens({}, rates.priceFor({ provider: 'ollama' }, { card })), 0,
    'a local run genuinely costs nothing — zero is an answer, not a missing price');

  // The case the float path loses: ₹1.005/1M × 1,000,000 tokens is ₹1.005 = 100.5 token
  // credits. Half-away-from-zero says 101; `(x/1e6)*1.005*100` says 100.49999999999999.
  const odd = { input: '1.005', output: '0', cacheRead: '0', cacheWrite: '0' };
  assert.equal(rates.tokenCreditsFromTokens({ inputTokens: 1000000 }, odd), 101);
  assert.equal(Math.round((1000000 / 1e6) * 1.005 * 100), 100, 'the naive form this replaces');
});

test('tokenCreditsFromTokens refuses a fractional token count, not a coin flip', () => {
  assert.throws(() => rates.tokenCreditsFromTokens({ inputTokens: 10.5 }, { input: '1' }),
    /inputTokens must be a non-negative whole token count/);
  assert.throws(() => rates.tokenCreditsFromTokens({ inputTokens: -1 }, { input: '1' }),
    /inputTokens must be a non-negative whole token count/);
});

test('tokenCreditsFromUsd needs its rate: no default, because a debit must not depend on FX', () => {
  assert.equal(rates.tokenCreditsFromUsd(0.6, '87.00'), 5220, 'the same integer usdToPaise produced');
  assert.equal(rates.tokenCreditsFromUsd('0.6', '87.00'), 5220);
  assert.equal(rates.tokenCreditsFromUsd(0, '87.00'), 0);
  assert.throws(() => rates.tokenCreditsFromUsd(0.6), /needs a positive fx rate/);
  assert.throws(() => rates.tokenCreditsFromUsd(0.6, '0'), /needs a positive fx rate/);
  assert.throws(() => rates.tokenCreditsFromUsd(Number.NaN, '87.00'), /finite USD amount/);
});

test('the purchase surface lists enabled packages and still resolves a retired one', () => {
  const card = load(VALID);
  assert.deepEqual(rates.listPackages({ card }).map((p) => p.id), ['credits-3500']);
  assert.equal(rates.packageById('credits-10000', { card }).enabled, false,
    'settle() must find a package that was retired after the order was placed');
  assert.equal(rates.packageById('nope', { card }), null);
  assert.deepEqual(rates.packageQuote('credits-3500', { card }), {
    packageId: 'credits-3500',
    priceInr: 2000,
    subtotalPaise: 200000,
    couponBps: 7500,
    bonusTokenCredits: 150000,
    prepaidCredits: 2000,
    bonusCredits: 1500,
    totalCredits: 3500,
    bonusValidDays: 30,
  });
});

test('fxRate ages the rate so a reconciliation can say stale instead of match', () => {
  const stale = rates.fxRate({ card: load(mutate('as_of: "2026-11-01"', 'as_of: "2020-01-01"')) });
  assert.equal(stale.stale, true);
  assert.ok(stale.ageDays > 2000);
  const fresh = rates.fxRate({ card: load(mutate('as_of: "2026-11-01"', `as_of: "${new Date().toISOString().slice(0, 10)}"`)) });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageDays, 0);
});

test('ensureLoaded: optional when billing is off, fatal when it is on, always fatal when broken', () => {
  rates.resetCard();
  const missing = path.join(DIR, 'does-not-exist.yaml');
  assert.equal(rates.ensureLoaded({ env: { CREDIT_RATES_FILE: missing }, enabled: false }), null);
  assert.throws(() => rates.ensureLoaded({ env: { CREDIT_RATES_FILE: missing }, enabled: true }),
    (err) => err.code === 'rate_card_missing');

  const broken = cardFile('schema_version: 99\n');
  rates.resetCard();
  assert.throws(() => rates.ensureLoaded({ env: { CREDIT_RATES_FILE: broken }, enabled: false }),
    (err) => err.code === 'rate_card_invalid',
    'a card that exists but lies is never ignored, enabled billing or not');
});

test('the card is memoised per path, and resetCard is the only way to re-read it', () => {
  const file = cardFile(VALID);
  rates.resetCard();
  const first = rates.rateCard({ file });
  assert.equal(rates.rateCard({ file }), first);
  fs.writeFileSync(file, mutate('usd_to_inr: "87.00"', 'usd_to_inr: "90.00"'));
  assert.equal(rates.rateCard({ file }).fx.usdToInr, '87.00', 'no hot reload, by design');
  rates.resetCard();
  assert.equal(rates.rateCard({ file }).fx.usdToInr, '90.00');
  rates.resetCard();
});

test('describe names what the card covers, never a credential or a balance', () => {
  const line = rates.describe(load(VALID));
  assert.match(line, /models=1 providers=1 packages=2 fx=87\.00@2026-11-01/);
});
