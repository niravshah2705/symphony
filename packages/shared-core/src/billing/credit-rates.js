'use strict';

// Loads the rate card — `deploy/billing/credit-rates.yaml` — and answers the two
// questions the money path asks it: what does this run cost, and what can a customer
// buy.
//
// The card is read once per process and memoised per path. There is NO hot reload, and
// that is a correctness choice rather than a missing feature: a debit and the invoice
// reconciled against it months later have to be computable from the same rates, which
// a card that can change under a running process makes impossible. A rate change is
// therefore a redeploy.
//
// Fail-closed at boot, fail-soft at runtime. A missing or malformed card while billing
// is enabled refuses to start — a service that cannot price a run must not accept it.
// An UNKNOWN MODEL at runtime is not fatal: `priceFor` falls back to the provider row,
// then to `defaults`, and reports `match: 'Default'` so the caller warns and
// Cloud Logging counts it. An estimate beats an unmetered run (that has always been
// the rule in pricing.js); silently booting without any card at all beats neither.
//
// Every money value in and out of this module is a decimal STRING or an integer —
// never a float. The card's own loader rejects a bare YAML number for a price rather
// than coercing it, because the difference between "87.00" and 87 is the difference
// between an exact decimal and a binary approximation, and this file feeds the same
// BigInt digit arithmetic as the rest of the money path (see money-wire.js).

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const log = require('../logger');
const { bonusTokenCredits } = require('./credits');
const { TOKEN_CREDITS_PER_CREDIT, decimalToScaled, roundDiv } = require('./money-wire');

const SCHEMA_VERSION = 1;
const DEFAULT_CARD_PATH = path.resolve(__dirname, '../../../../deploy/billing/credit-rates.yaml');

const TOP_LEVEL_KEYS = new Set([
  'schema_version', 'fx', 'reconcile', 'limits', 'models', 'providers', 'defaults', 'packages',
]);
const PRICE_KEYS = new Set([
  'input_inr_per_mtok', 'output_inr_per_mtok', 'cache_read_inr_per_mtok', 'cache_write_inr_per_mtok',
]);
const REQUIRED_PRICE_KEYS = ['input_inr_per_mtok', 'output_inr_per_mtok'];

// A price is stated in rupees per 1,000,000 tokens, to at most 6 dp; FX to 4 dp; a
// provider-reported USD cost to 8 dp (below that a runtime is reporting nothing).
const PER_MTOK_DP = 6;
const PRICE_DP = 6;
const FX_DP = 4;
const USD_DP = 8;

const MONEY_STRING_RE = /^\d+(\.\d{1,6})?$/;
const WHOLE_INR_RE = /^\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `.code` is `rate_card_missing` | `rate_card_invalid` — the boot log keys off it. */
class CreditRatesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CreditRatesError';
    this.code = code;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (problems, message) => problems.push(message);

/** A YAML integer: unquoted number or digit string. Counts only — money is a string. */
function asCount(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function checkInt(problems, where, value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = asCount(value);
  if (n === null) {
    bad(problems, `${where} must be a whole number >= ${min}, got ${JSON.stringify(value)}`);
    return null;
  }
  if (n < min || n > max) {
    bad(problems, `${where} is ${n}, outside ${min}..${max}`);
    return null;
  }
  return n;
}

/** One `*_inr_per_mtok` mapping, normalized to `{ input, output, cacheRead, cacheWrite }`. */
function readPriceRow(problems, where, row) {
  if (!isPlainObject(row)) {
    bad(problems, `${where} must be a mapping of *_inr_per_mtok prices, got ${JSON.stringify(row)}`);
    return null;
  }
  for (const key of Object.keys(row)) {
    if (!PRICE_KEYS.has(key)) bad(problems, `${where}: unknown price key '${key}'`);
  }
  const out = {};
  for (const [key, field] of [
    ['input_inr_per_mtok', 'input'], ['output_inr_per_mtok', 'output'],
    ['cache_read_inr_per_mtok', 'cacheRead'], ['cache_write_inr_per_mtok', 'cacheWrite'],
  ]) {
    const value = row[key];
    if (value === undefined) {
      // The one error message here that is not about a typo: an absent key read as a
      // zero would bill a real model at nothing, and nothing downstream notices.
      if (REQUIRED_PRICE_KEYS.includes(key)) {
        bad(problems, `${where}: missing ${key} — an absent key is not a zero`);
      }
      out[field] = '0';
      continue;
    }
    if (typeof value !== 'string' || !MONEY_STRING_RE.test(value)) {
      bad(problems, `${where}.${key} must be a quoted decimal STRING ("261", "217.5"), got ${JSON.stringify(value)}`);
      continue;
    }
    out[field] = value;
  }
  return REQUIRED_PRICE_KEYS.every((k) => row[k] !== undefined) ? Object.freeze(out) : null;
}

function readFx(problems, fx) {
  if (!isPlainObject(fx)) {
    bad(problems, 'fx must be a mapping with usd_to_inr and as_of');
    return null;
  }
  for (const key of Object.keys(fx)) {
    if (!['usd_to_inr', 'as_of', 'stale_after_days', 'drift_bps_per_day'].includes(key)) {
      bad(problems, `fx: unknown key '${key}'`);
    }
  }
  const rate = fx.usd_to_inr;
  if (typeof rate !== 'string' || !MONEY_STRING_RE.test(rate)) {
    bad(problems, `fx.usd_to_inr must be a quoted decimal STRING, got ${JSON.stringify(rate)}`);
    return null;
  }
  if (Number(rate) <= 0) {
    // Zero is not "conservative": it converts LiteLLM's whole spend to zero, so every
    // window reconciles at any delta and the check reports success while measuring nil.
    bad(problems, 'fx.usd_to_inr must be greater than zero — a zero rate makes LiteLLM\'s spend convert to zero, so every window would report match at any delta');
    return null;
  }
  const asOf = typeof fx.as_of === 'string' && DATE_RE.test(fx.as_of) && !Number.isNaN(Date.parse(fx.as_of))
    ? fx.as_of : null;
  if (asOf === null) bad(problems, `fx.as_of must be a YYYY-MM-DD date, got ${JSON.stringify(fx.as_of)}`);
  const staleAfterDays = checkInt(problems, 'fx.stale_after_days', fx.stale_after_days, { min: 1 });
  const driftBpsPerDay = checkInt(problems, 'fx.drift_bps_per_day', fx.drift_bps_per_day, { min: 0 });
  if (asOf === null || staleAfterDays === null || driftBpsPerDay === null) return null;
  return Object.freeze({ usdToInr: rate, asOf, staleAfterDays, driftBpsPerDay });
}

function readReconcile(problems, block) {
  if (!isPlainObject(block)) {
    bad(problems, 'reconcile must be a mapping with base_tolerance_bps and max_tolerance_bps');
    return null;
  }
  const base = checkInt(problems, 'reconcile.base_tolerance_bps', block.base_tolerance_bps, { min: 0 });
  const max = checkInt(problems, 'reconcile.max_tolerance_bps', block.max_tolerance_bps, { min: 0 });
  if (base !== null && max !== null && base > max) {
    bad(problems, `reconcile.base_tolerance_bps ${base} exceeds max_tolerance_bps ${max}`);
    return null;
  }
  return base === null || max === null ? null : Object.freeze({ baseToleranceBps: base, maxToleranceBps: max });
}

function readLimits(problems, block) {
  if (!isPlainObject(block)) {
    bad(problems, 'limits must be a mapping with max_package_price_inr and max_bonus_bps');
    return null;
  }
  const maxPrice = checkInt(problems, 'limits.max_package_price_inr', block.max_package_price_inr, { min: 1 });
  const maxBonus = checkInt(problems, 'limits.max_bonus_bps', block.max_bonus_bps, { min: 0 });
  if (maxPrice === null || maxBonus === null) return null;
  // The bonus multiply in gst.js is float (`subtotalPaise * bps / BPS`), so the cap is
  // only safe while that product is exactly representable. Stated as an assertion
  // rather than a belief: a cap an operator raises past this point is refused here,
  // where the message names the file, instead of in a customer's quote.
  if (maxPrice * 100 * maxBonus >= Number.MAX_SAFE_INTEGER) {
    bad(problems, `limits: a package of ₹${maxPrice} at ${maxBonus} bps overflows a safe integer in the float bonus multiply (gst.js) — lower max_package_price_inr or max_bonus_bps`);
    return null;
  }
  return Object.freeze({ maxPackagePriceInr: maxPrice, maxBonusBps: maxBonus });
}

/**
 * One purchasable package → the money it moves.
 *
 * `couponBps` is DERIVED from the advertised pair (price, credits) and must come out
 * exact. A package whose bonus is not an integer number of basis points would round in
 * `gst.quote`, and the wallet would then credit a different offer than the page sold —
 * the one place a bonus rounding is invisible, because both sides look plausible.
 */
function readPackage(problems, entry, index, limits, seenIds) {
  const where = `packages[${index}]`;
  if (!isPlainObject(entry)) {
    bad(problems, `${where} must be a mapping`);
    return null;
  }
  for (const key of Object.keys(entry)) {
    if (!['id', 'price_inr', 'credits', 'bonus_valid_days', 'enabled'].includes(key)) {
      bad(problems, `${where}: unknown key '${key}'`);
    }
  }
  const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
  if (id === null) bad(problems, `${where}.id must be a non-empty string`);
  else if (seenIds.has(id)) bad(problems, `package id '${id}' is listed twice — the second would shadow the first`);
  else seenIds.add(id);

  if (typeof entry.price_inr !== 'string' || !WHOLE_INR_RE.test(entry.price_inr)) {
    bad(problems, `${where}.price_inr must be a quoted string of WHOLE rupees ("2000") — a recharge is a whole number of rupees because 1 credit = ₹1, got ${JSON.stringify(entry.price_inr)}`);
    return null;
  }
  const priceInr = Number(entry.price_inr);
  const credits = checkInt(problems, `${where}.credits`, entry.credits, { min: 1 });
  const validDays = checkInt(problems, `${where}.bonus_valid_days`, entry.bonus_valid_days, { min: 1 });
  const enabled = typeof entry.enabled === 'boolean' ? entry.enabled : (entry.enabled === undefined ? true : null);
  if (enabled === null) bad(problems, `${where}.enabled must be true or false`);
  if (id === null || credits === null || validDays === null || enabled === null) return null;

  if (priceInr <= 0 || priceInr > limits.maxPackagePriceInr) {
    bad(problems, `package ${id}: ₹${priceInr} is outside 1..${limits.maxPackagePriceInr} (limits.max_package_price_inr)`);
    return null;
  }
  if (credits < priceInr) {
    bad(problems, `package ${id}: ${credits} credits is less than the ₹${priceInr} charged — a package may grant a bonus, never take one`);
    return null;
  }
  const subtotalPaise = priceInr * TOKEN_CREDITS_PER_CREDIT;
  const bonusCredits = credits - priceInr;
  const numerator = BigInt(bonusCredits) * 10000n;
  const denominator = BigInt(priceInr);
  if (numerator % denominator !== 0n) {
    bad(problems, `package ${id}: the bonus of ${bonusCredits} credits on ₹${priceInr} is not an exact basis-point ratio (${numerator}/${denominator}) — the offer would round in gst.quote and credit something other than what was advertised`);
    return null;
  }
  const couponBps = Number(numerator / denominator);
  if (couponBps > limits.maxBonusBps) {
    bad(problems, `package ${id}: ${couponBps} bps of bonus exceeds limits.max_bonus_bps ${limits.maxBonusBps}`);
    return null;
  }
  const expectedBonusTokenCredits = bonusCredits * TOKEN_CREDITS_PER_CREDIT;
  const helperBonus = bonusTokenCredits(subtotalPaise, couponBps);
  if (helperBonus !== expectedBonusTokenCredits) {
    bad(problems, `package ${id}: the bonus helper grants ${helperBonus} token credits for ${couponBps} bps on ₹${priceInr}, not the ${expectedBonusTokenCredits} the card advertises`);
    return null;
  }
  return Object.freeze({
    id,
    priceInr,
    credits,
    bonusValidDays: validDays,
    enabled,
    // Rupee-side names (`subtotalPaise`) are what a payment collects and a GST invoice
    // states; credit-side names (`bonusTokenCredits`) are what lands in the wallet.
    subtotalPaise,
    couponBps,
    bonusTokenCredits: expectedBonusTokenCredits,
    prepaidCredits: priceInr,
    bonusCredits,
  });
}

/** Parse and validate one card file. Throws `CreditRatesError`; never mutates state. */
function loadCard({ env = process.env, file = cardPath(env) } = {}) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CreditRatesError('rate_card_missing',
      `credit-rates: no rate card readable at ${file} (${err.code || err.message}) — set CREDIT_RATES_FILE or restore deploy/billing/credit-rates.yaml`);
  }

  let doc;
  try {
    // `yaml` refuses duplicate map keys by default, which is the whole reason a
    // hand-rolled key scan is not here too: a silently last-wins rate row is a money
    // author that is not the one an operator edited.
    doc = YAML.parse(source);
  } catch (err) {
    throw new CreditRatesError('rate_card_invalid', `credit-rates: ${file} does not parse — ${err.message}`);
  }
  if (!isPlainObject(doc)) {
    throw new CreditRatesError('rate_card_invalid', `credit-rates: ${file} must contain a mapping at the top level`);
  }

  const problems = [];
  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(key)) bad(problems, `unknown top-level key '${key}' — a typo here is a section nobody reads`);
  }
  if (doc.schema_version !== SCHEMA_VERSION) {
    bad(problems, `schema_version must be ${SCHEMA_VERSION}, got ${JSON.stringify(doc.schema_version)}`);
  }

  const fx = readFx(problems, doc.fx);
  const reconcile = readReconcile(problems, doc.reconcile);
  const limits = readLimits(problems, doc.limits);

  const models = {};
  if (!isPlainObject(doc.models) || !Object.keys(doc.models).length) {
    bad(problems, 'models must list at least one model_name with its INR prices');
  } else {
    for (const [name, row] of Object.entries(doc.models)) {
      const price = readPriceRow(problems, `models.${name}`, row);
      if (price) models[name] = price;
    }
  }

  const providers = {};
  if (doc.providers !== undefined) {
    if (!isPlainObject(doc.providers)) bad(problems, 'providers must be a mapping of provider -> prices');
    else {
      for (const [name, row] of Object.entries(doc.providers)) {
        const price = readPriceRow(problems, `providers.${name}`, row);
        if (price) providers[name] = price;
      }
    }
  }

  let defaultModel = null;
  if (!isPlainObject(doc.defaults) || doc.defaults.model === undefined) {
    // Without this row an unknown model has no price at all, and "no price" in this
    // module means either a crash mid-run or an unmetered run — both worse than the
    // estimate this fallback exists to provide.
    bad(problems, 'defaults.model is required: it is the last-resort price for a model the card does not list');
  } else {
    for (const key of Object.keys(doc.defaults)) {
      if (key !== 'model') bad(problems, `defaults: unknown key '${key}'`);
    }
    defaultModel = readPriceRow(problems, 'defaults.model', doc.defaults.model);
  }

  const packages = [];
  if (!Array.isArray(doc.packages) || !doc.packages.length) {
    bad(problems, 'packages must list at least one purchasable package');
  } else {
    const seenIds = new Set();
    doc.packages.forEach((entry, index) => {
      const pkg = isPlainObject(entry) && limits
        ? readPackage(problems, entry, index, limits, seenIds)
        : null;
      if (pkg) packages.push(pkg);
    });
  }

  if (problems.length) {
    throw new CreditRatesError('rate_card_invalid',
      `credit-rates: refusing to use ${file}:\n  - ${problems.join('\n  - ')}`);
  }

  return Object.freeze({
    version: SCHEMA_VERSION,
    file,
    fx,
    reconcile,
    limits,
    models: Object.freeze(models),
    providers: Object.freeze(providers),
    defaults: Object.freeze({ model: defaultModel }),
    packages: Object.freeze(packages),
  });
}

/** Where the card lives: `CREDIT_RATES_FILE`, else the repo's `deploy/billing/`. */
function cardPath(env = process.env) {
  return env.CREDIT_RATES_FILE || DEFAULT_CARD_PATH;
}

// Memoised PER PATH, not globally: a test or an operator script that points
// CREDIT_RATES_FILE at a fixture must not be able to read a card loaded for another
// path and believe it validated the fixture.
const CARDS = new Map();

function rateCard({ env = process.env, file = cardPath(env) } = {}) {
  const hit = CARDS.get(file);
  if (hit) return hit;
  const card = loadCard({ file });
  CARDS.set(file, card);
  return card;
}

/**
 * Boot gate. With billing enabled a missing or broken card is fatal, because the
 * alternative is a service that accepts runs it cannot price. With it disabled the
 * card is optional — a development profile that never bills must still boot — but the
 * absence is logged, since the common way to discover the card was never mounted is a
 * customer's zero-value invoice.
 */
function ensureLoaded({ env = process.env, enabled = false } = {}) {
  const file = cardPath(env);
  if (CARDS.has(file)) return CARDS.get(file);
  try {
    const card = rateCard({ file });
    // Presence and coverage, never the rates: this line is what tells an operator a
    // mounted-but-empty card is the reason a run priced from `defaults`.
    log.info('billing_credit_rates_loaded', {
      file: card.file,
      models: Object.keys(card.models).length,
      providers: Object.keys(card.providers).length,
      packages: card.packages.length,
      fx: card.fx.usdToInr,
      fxAsOf: card.fx.asOf,
    });
    return card;
  } catch (err) {
    if (err.code === 'rate_card_missing' && !enabled) {
      log.warn('billing_credit_rates_not_loaded', { file, code: err.code, effect: 'nothing can be priced: recordUsage fails open, so every run goes unmetered' });
      return null;
    }
    throw err;
  }
}

/** Drop the memoised card(s). For tests and for a script that reloads a fixture. */
function resetCard() {
  CARDS.clear();
}

/** One line for the boot log: what the card covers, never what it costs to run. */
function describe(card = rateCard()) {
  return [
    `file=${card.file}`,
    `models=${Object.keys(card.models).length}`,
    `providers=${Object.keys(card.providers).length}`,
    `packages=${card.packages.length}`,
    `fx=${card.fx.usdToInr}@${card.fx.asOf}`,
  ].join(' ');
}

/**
 * The price row for one run, and HOW it was found.
 *
 * `match` is the money version of an unmodeled gateway key: `Default` means the number
 * is a guess, and a guess that is not counted is a guess that is never fixed. Callers
 * warn on `Default` and Cloud Logging alerts on it.
 */
function priceFor({ model, provider } = {}, options = {}) {
  const card = resolveCard(options);
  const key = String(model || '').trim();
  const named = key ? card.models[key] : undefined;
  if (named) return { ...named, match: 'Card' };
  const viaProvider = card.providers[String(provider || '').trim().toLowerCase()];
  if (viaProvider) return { ...viaProvider, match: 'Provider' };
  return { ...card.defaults.model, match: 'Default' };
}

function tokenCount(where, value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`credit-rates: ${where} must be a non-negative whole token count, got ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * Token counts → integer token credits, at ONE rounding, on the digit strings.
 *
 * The precision lives in BigInt (see money-wire.js for the float argument), so a run
 * priced from four components rounds once, at the credit boundary, rather than four
 * times. Components that are zero contribute nothing, and a zero total is a real answer
 * (a local run), not a missing price.
 */
function tokenCreditsFromTokens(usage, prices) {
  if (!isPlainObject(prices)) {
    throw new TypeError('credit-rates: tokenCreditsFromTokens needs a price row from priceFor()');
  }
  const u = isPlainObject(usage) ? usage : {};
  let scaled = 0n; // Σ tokens × price, in INR × 10^PRICE_DP × 10^PER_MTOK_DP^-1
  for (const [field, priceKey] of [
    ['inputTokens', 'input'], ['outputTokens', 'output'],
    ['cacheReadTokens', 'cacheRead'], ['cacheWriteTokens', 'cacheWrite'],
  ]) {
    const tokens = tokenCount(field, u[field]);
    if (!tokens) continue;
    const price = String(prices[priceKey] ?? '0');
    if (!MONEY_STRING_RE.test(price)) {
      throw new TypeError(`credit-rates: ${priceKey} must be a decimal string of INR per 1M tokens, got ${JSON.stringify(prices[priceKey])}`);
    }
    scaled += BigInt(tokens) * decimalToScaled(price, PRICE_DP);
  }
  const denominator = 10n ** BigInt(PER_MTOK_DP + PRICE_DP);
  return Number(roundDiv(scaled * BigInt(TOKEN_CREDITS_PER_CREDIT), denominator));
}

/**
 * USD → integer token credits at a rate the CALLER supplies.
 *
 * Reconciler and event-stamping only; there is no default rate, because the whole
 * point of the card is that a debit does not depend on FX. An absent rate is a bug in
 * the caller, so it throws rather than quietly converting to zero.
 */
function tokenCreditsFromUsd(usd, fxUsdToInr) {
  const amount = Number(usd);
  if (!Number.isFinite(amount)) throw new TypeError(`credit-rates: tokenCreditsFromUsd needs a finite USD amount, got ${JSON.stringify(usd)}`);
  if (amount <= 0) return 0;
  const fx = String(fxUsdToInr ?? '').trim();
  if (!MONEY_STRING_RE.test(fx) || Number(fx) <= 0) {
    throw new TypeError(`credit-rates: tokenCreditsFromUsd needs a positive fx rate as a decimal string, got ${JSON.stringify(fxUsdToInr)}`);
  }
  const scaled = decimalToScaled(amount.toFixed(USD_DP), USD_DP)
    * decimalToScaled(fx, FX_DP)
    * BigInt(TOKEN_CREDITS_PER_CREDIT);
  return Number(roundDiv(scaled, 10n ** BigInt(USD_DP + FX_DP)));
}

/** Either the card a caller already loaded, or the memoised card for that path. */
function resolveCard(options = {}) {
  return options.card || rateCard(options);
}

/** What the purchase UI may offer: every enabled package, in card order. */
function listPackages(options = {}) {
  return resolveCard(options).packages.filter((pkg) => pkg.enabled);
}

/** A package by id, ENABLED or not: settling a paid order must find a retired one. */
function packageById(id, options = {}) {
  const wanted = String(id || '').trim();
  if (!wanted) return null;
  return resolveCard(options).packages.find((pkg) => pkg.id === wanted) || null;
}

/**
 * The card's answer for one package, as the money fields the recharge path takes.
 *
 * No GST quote here: `quoteRecharge` owns tax, and a second place that composes a
 * quote is a second place the two can disagree about the taxable value.
 */
function packageQuote(pkgOrId, options = {}) {
  const pkg = typeof pkgOrId === 'string' ? packageById(pkgOrId, options) : pkgOrId;
  if (!pkg || !pkg.id) throw new CreditRatesError('rate_card_invalid', `credit-rates: packageQuote needs a package or an id, got ${JSON.stringify(pkgOrId)}`);
  return {
    packageId: pkg.id,
    priceInr: pkg.priceInr,
    subtotalPaise: pkg.subtotalPaise,
    couponBps: pkg.couponBps,
    bonusTokenCredits: pkg.bonusTokenCredits,
    prepaidCredits: pkg.prepaidCredits,
    bonusCredits: pkg.bonusCredits,
    totalCredits: pkg.credits,
    bonusValidDays: pkg.bonusValidDays,
  };
}

/** The FX block, plus how old it is: the reconciler needs both to be honest. */
function fxRate(options = {}) {
  const { fx } = resolveCard(options);
  const ageDays = Math.floor((Date.now() - Date.parse(`${fx.asOf}T00:00:00Z`)) / 86_400_000);
  return {
    usdToInr: fx.usdToInr,
    asOf: fx.asOf,
    staleAfterDays: fx.staleAfterDays,
    driftBpsPerDay: fx.driftBpsPerDay,
    ageDays,
    stale: ageDays > fx.staleAfterDays,
  };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_CARD_PATH,
  CreditRatesError,
  cardPath,
  loadCard,
  rateCard,
  ensureLoaded,
  resetCard,
  describe,
  priceFor,
  tokenCreditsFromTokens,
  tokenCreditsFromUsd,
  listPackages,
  packageById,
  packageQuote,
  fxRate,
};
