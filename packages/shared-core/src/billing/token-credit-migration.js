'use strict';

// Rename migration for the credit-side subunit: it used to be spelled `paise`,
// it is now `tokenCredits`. The integers are identical — this is naming, not
// rescaling — so a legacy key is copied to its current name and the stale one
// dropped, the same shape as BYOM_KEY_MIGRATIONS below for settings.
//
// It is applied at load time in store.js `normalizeStore`, which BOTH backends
// assemble through (see store/firestore-backend.js `assemble()`), so a
// record written before the rename reads correctly with no data touched at all,
// and the next write of that record persists the new spelling. An un-migrated
// outbox row is the expensive case — toEvent() resolves the quantity key at send
// time, so a stranded row would retry and land `failed` over a quantity that
// exists but is spelled the old way.
//
// Deliberately absent: `subtotalPaise`, `gstPaise`, `totalPaise`, `collectedPaise`
// and `autoRecharge.amountPaise`. Those are rupee amounts — a tax document and a
// card charge — and rupee-side money keeps the rupee name.
const TOKEN_CREDIT_KEY_MIGRATIONS = Object.freeze([
  ['costPaise', 'costTokenCredits'],
  ['notionalCostPaise', 'notionalCostTokenCredits'],
  ['quantityPaise', 'quantityTokenCredits'],
  ['bonusPaise', 'bonusTokenCredits'],
  ['prepaidPaise', 'prepaidTokenCredits'],
  ['promoPaise', 'promoTokenCredits'],
  ['initialCreditPaise', 'initialCreditTokenCredits'],
  ['alertThresholdsPaise', 'alertThresholdsTokenCredits'],
  ['lastAlertedThresholdPaise', 'lastAlertedThresholdTokenCredits'],
  ['hourlyRatePaise', 'hourlyRateTokenCredits'],
  ['expectedPaise', 'expectedTokenCredits'],
  ['billedPaise', 'billedTokenCredits'],
]);

// Nested records that carry credit-side money of their own.
const TOKEN_CREDIT_NESTED_MIGRATIONS = Object.freeze({
  autoRecharge: [['thresholdPaise', 'thresholdTokenCredits']],
});

function renameTokenCreditKeys(target, pairs) {
  let renamed = false;
  for (const [legacy, current] of pairs) {
    if (!Object.prototype.hasOwnProperty.call(target, legacy)) continue;
    if (!Object.prototype.hasOwnProperty.call(target, current)) target[current] = target[legacy];
    delete target[legacy];
    renamed = true;
  }
  return renamed;
}

/** Copy any legacy `*Paise` credit key to its `*TokenCredits` name; idempotent. */
function migrateTokenCreditKeys(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const out = { ...record };
  let changed = renameTokenCreditKeys(out, TOKEN_CREDIT_KEY_MIGRATIONS);
  for (const [field, pairs] of Object.entries(TOKEN_CREDIT_NESTED_MIGRATIONS)) {
    const nested = out[field];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      out[field] = { ...nested };
      changed = renameTokenCreditKeys(out[field], pairs) || changed;
    }
  }
  return changed ? out : record;
}

module.exports = {
  TOKEN_CREDIT_KEY_MIGRATIONS,
  TOKEN_CREDIT_NESTED_MIGRATIONS,
  migrateTokenCreditKeys,
};
