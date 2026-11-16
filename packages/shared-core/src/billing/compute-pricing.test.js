'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SECONDS_PER_HOUR,
  TIERS,
  DEFAULT_TIER,
  tierFor,
  priceActorUsage,
  referenceCostInr,
  savingsEstimate,
} = require('./compute-pricing');

// A rate used only by these tests. It is not a price the product charges: no
// default rate exists in the module, on purpose.
const RATE = 463; // paise per actor-hour

test('the single tier is the actor shape the code actually builds', () => {
  const tier = TIERS[DEFAULT_TIER];
  assert.deepEqual(
    [tier.cpuMillicores, tier.memoryBytes],
    [1000, 1073741824],
    'substrate.js hardcodes these for every actor; a second tier requires a real spec field first',
  );
  assert.equal(tierFor({ cpuMillicores: 1000, memoryBytes: 1073741824 }), DEFAULT_TIER);
  assert.equal(tierFor({ cpuMillicores: 2000, memoryBytes: 1073741824 }), null, 'an unknown shape is never priced at the only known rate');
  assert.equal(tierFor({}), null);
  assert.equal(tierFor(), null);
});

test('priceActorUsage: 90 seconds of a standard actor', () => {
  const priced = priceActorUsage({ durationSeconds: 90, hourlyRatePaise: RATE });
  assert.equal(priced.meterName, 'actor-compute');
  assert.equal(priced.meterUnit, 'seconds');
  assert.equal(priced.meterValue, 90, 'the metered quantity is whole seconds, not hours and not money');
  // 90 * 463 / 3600 = 11.575 -> 12
  assert.equal(priced.expectedPaise, 12);
  assert.equal(priced.tier, DEFAULT_TIER);
});

test('priceActorUsage: the paise conversion happens once, at the end', () => {
  assert.equal(priceActorUsage({ durationSeconds: 0, hourlyRatePaise: RATE }).expectedPaise, 0);
  assert.equal(priceActorUsage({ durationSeconds: 1, hourlyRatePaise: RATE }).expectedPaise, 0, '1s is 0.13p, which rounds to nothing');
  assert.equal(priceActorUsage({ durationSeconds: 59, hourlyRatePaise: RATE }).expectedPaise, 8);
  assert.equal(priceActorUsage({ durationSeconds: 1800, hourlyRatePaise: RATE }).expectedPaise, 232, '231.5 rounds up');
  assert.equal(priceActorUsage({ durationSeconds: 3600, hourlyRatePaise: RATE }).expectedPaise, RATE, 'one hour costs exactly the hourly rate');
  assert.equal(priceActorUsage({ durationSeconds: 7200, hourlyRatePaise: RATE }).expectedPaise, 2 * RATE);
  assert.equal(priceActorUsage({ durationSeconds: 90.9, hourlyRatePaise: RATE }).meterValue, 90, 'partial seconds are floored before pricing, never billed');
});

test('priceActorUsage: a free rate is free, a missing rate is an error', () => {
  assert.equal(priceActorUsage({ durationSeconds: 3600, hourlyRatePaise: 0 }).expectedPaise, 0);
  assert.throws(() => priceActorUsage({ durationSeconds: 90 }), /refusing to guess a price/);
  assert.throws(() => priceActorUsage({ durationSeconds: 90, hourlyRatePaise: undefined }), /refusing to guess a price/);
  assert.throws(() => priceActorUsage({ durationSeconds: 90, hourlyRatePaise: -1 }), /refusing to guess a price/);
  assert.throws(() => priceActorUsage({ durationSeconds: -5, hourlyRatePaise: RATE }), TypeError);
  assert.throws(() => priceActorUsage({ durationSeconds: 'x', hourlyRatePaise: RATE }), TypeError);
  assert.throws(() => priceActorUsage({ durationSeconds: 10, tier: 'large-8v32g', hourlyRatePaise: RATE }), /unknown actor tier/);
});

// The deviation from the reference formula has to be bounded, not asserted away:
// it computes fractional hours x rupees and rounds to 4 decimal rupees, which is
// a different unit from this module. They must still agree to within a paise.
test('agrees with the reference formula to within one paise', () => {
  const rateInr = RATE / 100;
  let worst = 0;
  for (let seconds = 0; seconds <= 4 * SECONDS_PER_HOUR; seconds += 7) {
    const ours = priceActorUsage({ durationSeconds: seconds, hourlyRatePaise: RATE }).expectedPaise;
    const theirs = Math.round(referenceCostInr({ durationSeconds: seconds, hourlyRateInr: rateInr }) * 100);
    worst = Math.max(worst, Math.abs(ours - theirs));
  }
  assert.ok(worst <= 1, `the two formulas diverged by ${worst}p`);
  assert.equal(referenceCostInr({ durationSeconds: 3600, hourlyRateInr: rateInr }), rateInr);
});

test('savingsEstimate: always-on baseline minus what was actually billed', () => {
  const first = 1_794_000_000;
  const billed = priceActorUsage({ durationSeconds: 1800, hourlyRatePaise: RATE });
  const saved = savingsEstimate({
    firstSeenAt: first,
    now: first + SECONDS_PER_HOUR,
    billedSeconds: billed.meterValue,
    billedPaise: billed.expectedPaise,
    hourlyRatePaise: RATE,
  });
  assert.equal(saved.available, true);
  assert.equal(saved.baselineSeconds, 3600);
  assert.equal(saved.baselinePaise, RATE);
  assert.equal(saved.billedPaise, 232);
  assert.equal(saved.netSavedPaise, RATE - 232);
  assert.equal(saved.idleSeconds, 1800);
  assert.equal(saved.idlePercent, 50, 'half the elapsed wall clock was not running');
});

test('savingsEstimate: never reports a saving that is a refund', () => {
  const first = 1_794_000_000;
  const saved = savingsEstimate({
    firstSeenAt: first,
    now: first + 60,
    billedSeconds: 3600,
    billedPaise: 10 * RATE,
    hourlyRatePaise: RATE,
  });
  assert.equal(saved.netSavedPaise, 0, 'billed more than the counterfactual means the inputs are wrong, not that the org is owed money');
  assert.equal(saved.idleSeconds, 0);
});

test('savingsEstimate: unusable inputs are reported, not defaulted', () => {
  assert.equal(savingsEstimate({}).available, false);
  assert.equal(savingsEstimate({ firstSeenAt: 1, now: 2, billedSeconds: 0, billedPaise: 0 }).available, false, 'a missing rate is why this cannot be shown');
  assert.equal(savingsEstimate({ firstSeenAt: 100, now: 50, hourlyRatePaise: RATE }).available, false, 'now before first-seen is a broken clock');
  const nothing = savingsEstimate({ firstSeenAt: 100, now: 100, billedSeconds: 0, billedPaise: 0, hourlyRatePaise: RATE });
  assert.equal(nothing.available, true);
  assert.equal(nothing.idlePercent, 0, 'no elapsed time is 0%, not a division by zero');
});
