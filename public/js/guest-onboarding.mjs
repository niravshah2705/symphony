// Whether a first-visit guest gets the "how to use this" dialog.
//
// A guest lands in a click-only demo (`services/gateway/src/routes/guest-demo.js`)
// with no text input, and the absence of an omnibox is confusing unless it is
// explained. So the explanation is a dialog shown once, with two honest exits:
// "I have reviewed" records it on the device and never asks again, "Skip" records
// it for the tab only. A visitor who skips and opens a new tab is in a new visit
// and is told again — the same per-tab reasoning as guest-banner.mjs, which stays
// the persistent strip underneath this dialog.
//
// Both stores are treated as unavailable, not as empty: storage that throws (Safari
// private mode, a full quota, a blocked third-party context) must not silently
// convert "never seen this" into "seen it", because the cheap failure here is
// showing the dialog one more time.

export const GUEST_ONBOARDING_STORAGE_KEY = 'aiFleetGuestOnboarding';
export const GUEST_ONBOARDING_REVIEWED = 'reviewed';
export const GUEST_ONBOARDING_SKIPPED = 'skipped';

/** The dialog is a guest affordance: an auth-disabled profile has no sign-in to offer. */
export function shouldShowGuestOnboarding(session = {}) {
  return Boolean(session.enabled) && !session.authenticated;
}

function read(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    return storage.getItem(key);
  } catch (_) {
    return null;
  }
}

function write(storage, key, value) {
  if (!storage || typeof storage.setItem !== 'function') return;
  try {
    storage.setItem(key, value);
  } catch (_) {
    // In-memory only: the choice holds for this paint and is asked again next time.
  }
}

/** Device-permanent: the visitor read the explanation and does not need it again. */
export function guestOnboardingReviewed(local) {
  return read(local, GUEST_ONBOARDING_STORAGE_KEY) === GUEST_ONBOARDING_REVIEWED;
}

/** Per-tab: skipped now, asked again in a new tab. */
export function guestOnboardingSkipped(session) {
  return read(session, GUEST_ONBOARDING_STORAGE_KEY) === GUEST_ONBOARDING_SKIPPED;
}

export function markGuestOnboardingReviewed(local, session) {
  write(local, GUEST_ONBOARDING_STORAGE_KEY, GUEST_ONBOARDING_REVIEWED);
  // A skip recorded earlier in this tab must not outlive the review, and a stale
  // "skipped" in sessionStorage is the only state that could argue with it.
  if (read(session, GUEST_ONBOARDING_STORAGE_KEY) === GUEST_ONBOARDING_SKIPPED && session && typeof session.removeItem === 'function') {
    try { session.removeItem(GUEST_ONBOARDING_STORAGE_KEY); } catch (_) { /* best effort */ }
  }
}

export function markGuestOnboardingSkipped(session) {
  write(session, GUEST_ONBOARDING_STORAGE_KEY, GUEST_ONBOARDING_SKIPPED);
}

export function guestOnboardingVisible({ session = {}, localStorage = null, sessionStorage = null } = {}) {
  return shouldShowGuestOnboarding(session)
    && !guestOnboardingReviewed(localStorage)
    && !guestOnboardingSkipped(sessionStorage);
}
