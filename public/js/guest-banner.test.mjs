import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GUEST_BANNER_DISMISSED,
  GUEST_BANNER_STORAGE_KEY,
  dismissGuestBanner,
  guestBannerDismissed,
  guestBannerVisible,
  shouldShowGuestBanner,
} from './guest-banner.mjs';

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

test('the message belongs to a signed-out visitor on an auth-enabled deployment', () => {
  assert.equal(shouldShowGuestBanner(GUEST), true);
  assert.equal(shouldShowGuestBanner({ enabled: true, authenticated: true }), false,
    'a signed-in user has a tenant and needs no explanation of not having one');
  assert.equal(shouldShowGuestBanner({ enabled: false, authenticated: false }), false,
    'the local profile has no identity to sign into, so the prompt would be a dead button');
  assert.equal(shouldShowGuestBanner({ enabled: false, authenticated: true }), false);
  assert.equal(shouldShowGuestBanner({}), false, 'an unknown session is not a guest session');
  assert.equal(shouldShowGuestBanner(), false);
});

test('dismissing lasts for the tab, and a new tab is told again', () => {
  const store = storage();
  assert.equal(guestBannerVisible({ session: GUEST, storage: store }), true);

  dismissGuestBanner(store);
  assert.equal(store.getItem(GUEST_BANNER_STORAGE_KEY), GUEST_BANNER_DISMISSED);
  assert.equal(guestBannerVisible({ session: GUEST, storage: store }), false);

  // Same value under a different key, or a fresh store, is not a dismissal.
  assert.equal(guestBannerVisible({ session: GUEST, storage: storage({ other: GUEST_BANNER_DISMISSED }) }), true);
  assert.equal(guestBannerVisible({ session: GUEST, storage: storage({ [GUEST_BANNER_STORAGE_KEY]: 'maybe' }) }), true,
    'only the recorded dismissal value dismisses it — a stray string is not consent');
});

test('signed-in state wins over an undismissed banner', () => {
  const store = storage();
  assert.equal(guestBannerVisible({ session: { enabled: true, authenticated: true }, storage: store }), false,
    'the banner must not survive the sign-in that resolves it');
});

test('storage that cannot answer is not a reason to hide the message', () => {
  assert.equal(guestBannerVisible({ session: GUEST, storage: undefined }), true,
    'a missing store reads as "never dismissed"');
  assert.equal(guestBannerDismissed({ getItem() { throw new Error('SecurityError'); } }), false);
  assert.doesNotThrow(() => dismissGuestBanner({ setItem() { throw new Error('QuotaExceeded'); } }));
  assert.doesNotThrow(() => dismissGuestBanner(undefined));
});
