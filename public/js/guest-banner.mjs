// What an unauthenticated visitor is told, and for how long.
//
// A guest is not a locked state. The gateway answers an absent or invalid token
// with the public permissions (`packages/shared-core/src/authz.js` —
// `{ workspace: 'read' }`) rather than a 401, so a visitor is already standing in
// the read-only Agent workspace. What the page cannot show them is that nothing
// they are looking at belongs to an organization, and that signing in is the only
// thing that changes that.
//
// Dismissal is deliberately per-tab (sessionStorage), not per-device: "do not tell
// me twice in this visit" is a session choice, while a visitor who comes back in a
// new tab is in a different visit and should be told they are still tenant-less.

export const GUEST_BANNER_STORAGE_KEY = 'aiFleetGuestBanner';
export const GUEST_BANNER_DISMISSED = 'dismissed';

export function guestBannerDismissed(storage) {
  try {
    return storage.getItem(GUEST_BANNER_STORAGE_KEY) === GUEST_BANNER_DISMISSED;
  } catch (_) {
    // Storage that cannot answer cannot hold a dismissal, so the message stays up.
    return false;
  }
}

export function dismissGuestBanner(storage) {
  try {
    storage.setItem(GUEST_BANNER_STORAGE_KEY, GUEST_BANNER_DISMISSED);
  } catch (_) {
    // In-memory only: the banner hides for this paint and returns on the next.
  }
}

/** Whether the sign-in prompt is the honest description of this session.
 *
 * `enabled: false` is the local development profile — application auth is not
 * configured, so there is no identity to sign into and the prompt would be a dead
 * button. That is the same reason the toolbar hides its own sign-in control. */
export function shouldShowGuestBanner(session = {}) {
  return Boolean(session.enabled) && !session.authenticated;
}

export function guestBannerVisible({ session, storage } = {}) {
  return shouldShowGuestBanner(session) && !guestBannerDismissed(storage);
}
