// Whether a signed-in user is shown the EULA card right after signing in.
//
// Acceptance used to be asked only when the user first requested "actual work"
// (the work-intent gate in views/agent.js). That made the agreement look like an
// error appearing mid-task. Asking it once at the start of the session is the same
// UI, the same record path and the same version, moved earlier: the decision here
// only decides whether to paint the card, because requireEulaAccepted() in
// services/gateway/src/eula.js stays the trust boundary — a bypassed card still
// cannot mutate anything.
//
// The seen-version record is keyed per user, not per device: two accounts in one
// browser must not inherit each other's "already asked". It is a courtesy flag —
// losing it re-asks, which is the honest failure — so storage that throws reads as
// "never asked" rather than "already seen".

export const FIRST_LOGIN_EULA_STORAGE_KEY = 'aiFleetFirstLoginEula';

/** The device store, or null when the browser will not hand one out. */
export function firstLoginEulaStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    // A blocked store cannot hold the "already asked" record, so the card is
    // shown again next boot instead of going quiet on an account that never saw it.
    return null;
  }
}

function identities(session) {
  const user = session && session.user;
  const id = user && (user.sub || user.email);
  return id ? String(id).toLowerCase() : null;
}

/** `{ [userKey]: version }`, or `{}` when storage is unavailable or corrupt. */
function readRecord(storage) {
  if (!storage || typeof storage.getItem !== 'function') return {};
  try {
    const parsed = JSON.parse(storage.getItem(FIRST_LOGIN_EULA_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function readFirstLoginEulaSeen(storage, session) {
  const key = identities(session);
  if (!key) return null;
  const version = readRecord(storage)[key];
  return typeof version === 'string' ? version : null;
}

export function markFirstLoginEulaSeen(storage, session, version) {
  const key = identities(session);
  if (!key || typeof version !== 'string' || !version) return;
  if (!storage || typeof storage.setItem !== 'function') return;
  try {
    storage.setItem(FIRST_LOGIN_EULA_STORAGE_KEY, JSON.stringify({ ...readRecord(storage), [key]: version }));
  } catch (_) {
    // In-memory only for this paint; the card is shown again next visit.
  }
}

/**
 * @param {{ mode?: string, authenticated?: boolean, eulaStatus?: {accepted?: boolean, version?: string},
 *           hasOrganization?: boolean, seenVersion?: string|null, currentVersion?: string|null }} input
 */
export function shouldPromptFirstLoginEula(input = {}) {
  const { mode, authenticated, eulaStatus, hasOrganization, seenVersion } = input;
  // Local development auto-accepts server-side (eula.js resolveEulaStatus), so a
  // prompt there would be theatre with no record behind it.
  if (mode === 'disabled' || !authenticated) return false;
  // The server record is authoritative: accepted means accepted, at any version
  // this function has not been told about.
  if (eulaStatus && eulaStatus.accepted) return false;
  // An organisation member already accepted by joining (the `via:'org-member'`
  // path in views/agent.js) — re-asking them would be a new prompt for old members.
  if (hasOrganization) return false;
  const version = currentVersionOf(input);
  // Declined at this version already: the work-intent gate is the backstop for the
  // next real request, so do not nag on every boot. A version bump re-asks.
  if (version && seenVersion === version) return false;
  return true;
}

export function currentVersionOf(input = {}) {
  const { eulaStatus, currentVersion } = input;
  const version = currentVersion || (eulaStatus && eulaStatus.version);
  return typeof version === 'string' && version ? version : null;
}

// The one-shot hand-off between the boot check (app.js) and the view that owns the
// transcript (views/agent.js). Both import this module, so they share this state
// without either needing to know the other's order: whoever gets there first wins.
let pendingVersion = null;

export function setPendingFirstLoginEula(version) {
  pendingVersion = typeof version === 'string' && version ? version : 'unknown';
}

export function takePendingFirstLoginEula() {
  const version = pendingVersion;
  pendingVersion = null;
  return version;
}
