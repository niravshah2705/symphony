import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GUEST_ONBOARDING_REVIEWED,
  GUEST_ONBOARDING_SKIPPED,
  GUEST_ONBOARDING_STORAGE_KEY,
  guestOnboardingReviewed,
  guestOnboardingSkipped,
  guestOnboardingVisible,
  markGuestOnboardingReviewed,
  markGuestOnboardingSkipped,
  shouldShowGuestOnboarding,
} from './guest-onboarding.mjs';

function storage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
    has: (key) => entries.has(key),
  };
}

const GUEST = { enabled: true, authenticated: false };
const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); }, removeItem() { throw new Error('SecurityError'); } };

test('the dialog belongs to a signed-out visitor on an auth-enabled deployment', () => {
  assert.equal(shouldShowGuestOnboarding(GUEST), true);
  assert.equal(shouldShowGuestOnboarding({ enabled: true, authenticated: true }), false,
    'a signed-in user has the omnibox and needs no explanation of a click-only composer');
  assert.equal(shouldShowGuestOnboarding({ enabled: false, authenticated: false }), false,
    'the local profile has no sign-in to offer, so the CTA in the dialog would be a dead button');
  assert.equal(shouldShowGuestOnboarding({}), false, 'an unknown session is not a guest session');
  assert.equal(shouldShowGuestOnboarding(), false);
});

test('reviewed is device-permanent and skipped is per-tab', () => {
  const local = storage();
  const firstTab = storage();
  assert.equal(guestOnboardingVisible({ session: GUEST, localStorage: local, sessionStorage: firstTab }), true);

  markGuestOnboardingSkipped(firstTab);
  assert.equal(firstTab.getItem(GUEST_ONBOARDING_STORAGE_KEY), GUEST_ONBOARDING_SKIPPED);
  assert.equal(guestOnboardingVisible({ session: GUEST, localStorage: local, sessionStorage: firstTab }), false,
    'skipping means do not ask again in this tab');

  // A new tab is a new visit: the skip lived in sessionStorage, so it asks again.
  assert.equal(guestOnboardingVisible({ session: GUEST, localStorage: local, sessionStorage: storage() }), true,
    'a skip must not leak across tabs');

  markGuestOnboardingReviewed(local);
  assert.equal(local.getItem(GUEST_ONBOARDING_STORAGE_KEY), GUEST_ONBOARDING_REVIEWED);
  assert.equal(guestOnboardingVisible({ session: GUEST, localStorage: local, sessionStorage: storage() }), false,
    'ticking "I have reviewed" stops it for good, in every tab of this device');
});

test('a review wins over a skip recorded earlier in the same tab', () => {
  const local = storage();
  const tab = storage({ [GUEST_ONBOARDING_STORAGE_KEY]: GUEST_ONBOARDING_SKIPPED });
  markGuestOnboardingReviewed(local, tab);
  assert.equal(guestOnboardingSkipped(tab), false, 'the stale skip marker outlived the review it contradicts');
  assert.equal(guestOnboardingReviewed(local), true);
  assert.equal(guestOnboardingVisible({ session: GUEST, localStorage: local, sessionStorage: tab }), false);
});

test('only the recorded values count as an answer', () => {
  // A stray string under the same key is not consent, and treating it as such
  // would let any other feature that wrote this key silence the dialog.
  assert.equal(guestOnboardingVisible({ session: GUEST, localStorage: storage({ [GUEST_ONBOARDING_STORAGE_KEY]: 'maybe' }), sessionStorage: storage() }), true);
  assert.equal(guestOnboardingVisible({ session: GUEST, localStorage: storage(), sessionStorage: storage({ [GUEST_ONBOARDING_STORAGE_KEY]: GUEST_ONBOARDING_REVIEWED }) }), true,
    'the review marker is only honored in localStorage, where it is permanent');
  assert.equal(guestOnboardingVisible({ session: GUEST, localStorage: storage({ [GUEST_ONBOARDING_STORAGE_KEY]: GUEST_ONBOARDING_SKIPPED }), sessionStorage: storage() }), true,
    'a skip in localStorage would be a device-wide silence nobody agreed to');
});

test('storage that cannot answer is not a reason to hide the dialog', () => {
  assert.equal(guestOnboardingVisible({ session: GUEST }), true, 'a missing store reads as "never shown"');
  assert.equal(guestOnboardingVisible({ session: GUEST, localStorage: throwing, sessionStorage: throwing }), true,
    'blocked storage must fail open toward showing the explanation');
  assert.doesNotThrow(() => markGuestOnboardingReviewed(throwing, throwing));
  assert.doesNotThrow(() => markGuestOnboardingSkipped(throwing));
  assert.doesNotThrow(() => markGuestOnboardingReviewed(undefined, undefined));
  assert.doesNotThrow(() => markGuestOnboardingSkipped(undefined));
});

test('a signed-in visitor is never shown it, reviewed or not', () => {
  const local = storage({ [GUEST_ONBOARDING_STORAGE_KEY]: GUEST_ONBOARDING_REVIEWED });
  assert.equal(guestOnboardingVisible({ session: { enabled: true, authenticated: true }, localStorage: storage(), sessionStorage: storage() }), false);
  assert.equal(guestOnboardingVisible({ session: { enabled: true, authenticated: true }, localStorage: local, sessionStorage: storage() }), false);
});
