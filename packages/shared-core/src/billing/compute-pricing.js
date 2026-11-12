'use strict';

// Turning actor session time into money. This is the whole priced-compute
// surface: one module, one formula, swappable without touching the runner, the
// outbox or the UI.
//
// The quantity metered is INTEGER SECONDS, not rupees and not fractional hours.
// Two reasons, both learned the hard way elsewhere in this directory:
//   - the reference design computed `round(hours * rate, 4)`, i.e. four decimal
//     rupees. Everything else here is integer paise, and a money path with two
//     units cannot be reconciled to the paise;
//   - dividing by 3600 before multiplying carries float error that only appears
//     at the rounding boundary, so a session can bill differently than its own
//     line items add up to.
// So the meter holds seconds and the price converts them. Changing a rate
// therefore stays a price edit rather than a re-parse of history.
//
// Deliberately absent: an hourly rate default. A placeholder price that silently
// bills is worse than an exception on a missing one, so the caller must supply
// it (CONFIG in the product, an argument in the spike).

const { roundHalfUpPaise } = require('./gst');

const SECONDS_PER_HOUR = 3600;

// Actor resource shape as it exists in code today: substrate.js hardcodes
// cpuMillicores 1000 and memoryBytes 1073741824 for every actor, so there is
// exactly one tier. Naming it is what makes the catalog honest — a price list
// with one row is a fact, a price list with an unnamed row is a guess.
// Adding a second tier means giving actors a real spec field first; until then
// every actor is this shape and this tier, and nothing is mis-priced.
const TIERS = Object.freeze({
  'standard-1v1g': Object.freeze({
    name: 'standard-1v1g',
    cpuMillicores: 1000,
    memoryBytes: 1073741824,
  }),
});

const DEFAULT_TIER = 'standard-1v1g';

/** The tier an actor of the given shape belongs to. Unmatched shapes are an error, not a silent default. */
function tierFor({ cpuMillicores, memoryBytes } = {}) {
  const cpu = Number(cpuMillicores);
  const mem = Number(memoryBytes);
  for (const tier of Object.values(TIERS)) {
    if (tier.cpuMillicores === cpu && tier.memoryBytes === mem) return tier.name;
  }
  return null;
}

/**
 * One priced actor usage line.
 *
 * `meterValue` is what goes to the billing engine as the metered quantity
 * (seconds); `expectedPaise` is what this module believes that quantity costs,
 * which the tests assert against hand-computed arithmetic and the spike asserts
 * against the engine's own invoice. Two independent derivations of the same
 * number is the point — if they disagree, the price catalog drifted.
 */
function priceActorUsage({ durationSeconds, tier = DEFAULT_TIER, hourlyRatePaise }) {
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new TypeError(`computePricing: durationSeconds must be a number >= 0, got ${JSON.stringify(durationSeconds)}`);
  }
  if (!TIERS[tier]) {
    throw new TypeError(`computePricing: unknown actor tier ${JSON.stringify(tier)} (known: ${Object.keys(TIERS).join(', ')})`);
  }
  const rate = Number(hourlyRatePaise);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new TypeError(`computePricing: hourlyRatePaise is required for tier ${tier}; refusing to guess a price`);
  }

  const wholeSeconds = Math.floor(seconds);
  return {
    tier,
    meterName: 'actor-compute',
    meterUnit: 'seconds',
    meterValue: wholeSeconds,
    hourlyRatePaise: rate,
    expectedPaise: roundHalfUpPaise((wholeSeconds * rate) / SECONDS_PER_HOUR),
  };
}

/**
 * The reference formula, kept verbatim so the deviation is auditable.
 *
 * This is what the design we replaced produced: fractional hours times a rate,
 * rounded to four decimal rupees. `priceActorUsage` must agree with it to within
 * one paise for any session, and the test suite pins that.
 */
function referenceCostInr({ durationSeconds, hourlyRateInr }) {
  const hours = Number(durationSeconds) / SECONDS_PER_HOUR;
  return Math.round(hours * Number(hourlyRateInr) * 10000) / 10000;
}

/**
 * The savings panel: what the same actor would have cost always-on, minus what
 * it actually cost.
 *
 * Displayed on the usage page and NEVER billed. An always-on counterfactual is a
 * number to show a customer, not a supply — charging it would mean invoicing for
 * time that did not happen. `baselineSeconds` runs from the actor's first seen
 * moment to now, which is why `firstSeenAt` is required rather than inferred.
 */
function savingsEstimate({ firstSeenAt, now, billedSeconds, billedPaise, hourlyRatePaise }) {
  const first = Number(firstSeenAt);
  const at = Number(now);
  const rate = Number(hourlyRatePaise);
  const billed = Math.max(0, Number(billedSeconds) || 0);
  const spent = Math.max(0, Number(billedPaise) || 0);
  if (!Number.isFinite(first) || !Number.isFinite(at) || at < first || !Number.isFinite(rate)) {
    return { available: false, reason: 'missing first-seen timestamp or rate' };
  }
  const baselineSeconds = Math.floor(at - first);
  const baselinePaise = roundHalfUpPaise((baselineSeconds * rate) / SECONDS_PER_HOUR);
  // A refund cannot be shown: idle time that costs less than what was billed
  // means the inputs are wrong, not that the customer is owed money.
  const netPaise = Math.max(0, baselinePaise - spent);
  return {
    available: true,
    baselineSeconds,
    baselinePaise,
    billedSeconds: billed,
    billedPaise: spent,
    netSavedPaise: netPaise,
    idleSeconds: Math.max(0, baselineSeconds - billed),
    // Percent of wall-clock time the actor was NOT running, which is what
    // "efficiency" means here; 0 when nothing has elapsed yet.
    idlePercent: baselineSeconds > 0 ? roundHalfUpPaise((10000 * (baselineSeconds - billed)) / baselineSeconds) / 100 : 0,
  };
}

module.exports = {
  SECONDS_PER_HOUR,
  TIERS,
  DEFAULT_TIER,
  tierFor,
  priceActorUsage,
  referenceCostInr,
  savingsEstimate,
};
