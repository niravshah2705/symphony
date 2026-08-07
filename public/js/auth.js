import { initializeApp } from '/vendor/firebase/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
} from '/vendor/firebase/firebase-auth.js';
import { api, setAccessTokenProvider, getApiBase } from './api.js';

const AUTH_SESSION_TIMEOUT_MS = 15_000;

let auth = null;
let currentUser = null;
let configuration = null;
// Full local access when auth is disabled; read-only Agent workspace for public.
const ADMIN_PERMISSIONS = Object.freeze({ workspace: 'write', planning: 'write', insights: 'write', settings: 'write' });
const FALLBACK_PUBLIC_PERMISSIONS = Object.freeze({ workspace: 'read' });

let authState = Object.freeze({
  mode: 'loading',
  enabled: false,
  authenticated: false,
  role: 'public',
  permissions: {},
  user: null,
  error: '',
});

function setState(next) {
  authState = Object.freeze({ ...authState, ...next });
  return authState;
}

async function withinSessionTimeout(operation) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error('Authentication session restoration timed out.')), AUTH_SESSION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    window.clearTimeout(timeout);
  }
}

async function loadConfiguration() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  let response;
  try {
    response = await fetch(`${getApiBase()}/api/auth/config`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Authentication configuration timed out.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    // The error below is intentionally stable and does not expose proxy HTML.
  }
  if (!response.ok) throw new Error(payload.error || 'Authentication configuration could not be loaded.');
  if (!payload.enabled || payload.mode === 'disabled') return { mode: 'disabled', enabled: false };
  const firebase = payload.firebase || {};
  if (payload.mode !== 'firebase' || !firebase.apiKey || !firebase.projectId || !firebase.authDomain) {
    throw new Error('Authentication configuration is incomplete.');
  }
  return payload;
}

// Resolve with the first known auth state (signed-in user or null).
function firstAuthUser(authInstance) {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(
      authInstance,
      (user) => { unsubscribe(); resolve(user || null); },
      () => { unsubscribe(); resolve(null); }
    );
  });
}

function mergeDisplayProfile(serverUser, browserUser) {
  const authoritative = serverUser || {};
  const display = browserUser || {};
  return Object.freeze({
    ...authoritative,
    name: authoritative.name || display.name || '',
    email: authoritative.email || display.email || '',
    picture: authoritative.picture || display.picture || '',
  });
}

// Confirm the signed-in Google user is accepted by the gateway (verified email +
// any allowlist/domain gate). Returns the server identity or throws.
async function confirmIdentity() {
  currentUser = auth.currentUser;
  setAccessTokenProvider(() => currentUser.getIdToken());
  const identity = await api.getCurrentUser();
  if (!identity?.authenticated || !identity.user?.sub) {
    throw new Error('This account is not allowed.');
  }
  return identity;
}

export async function initializeAuthentication() {
  configuration = await loadConfiguration();
  if (!configuration.enabled) {
    // Auth disabled (local dev): fully open, single admin operator.
    auth = null;
    setAccessTokenProvider(null);
    return setState({ mode: 'disabled', enabled: false, authenticated: true, role: 'admin', permissions: ADMIN_PERMISSIONS, user: null, error: '' });
  }

  const publicPermissions = configuration.publicPermissions || FALLBACK_PUBLIC_PERMISSIONS;

  const app = initializeApp(configuration.firebase);
  auth = getAuth(app);
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (_) {
    // Persistence is best-effort; sign-in still works in-memory for this tab.
  }

  const user = await withinSessionTimeout(firstAuthUser(auth));
  if (!user) {
    // No signed-in user → public visitor (read-only Agent workspace).
    setAccessTokenProvider(null);
    return setState({ mode: 'firebase', enabled: true, authenticated: false, role: 'public', permissions: publicPermissions, user: null, error: '' });
  }

  let identity;
  try {
    identity = await withinSessionTimeout(confirmIdentity());
  } catch (error) {
    // Signed in but rejected (unverified / not allowed) → sign out, stay public.
    setAccessTokenProvider(null);
    try { await firebaseSignOut(auth); } catch (_) { /* ignore */ }
    return setState({ mode: 'firebase', enabled: true, authenticated: false, role: 'public', permissions: publicPermissions, user: null, error: error?.message || 'This account is not allowed.' });
  }

  return setState({
    mode: 'firebase',
    enabled: true,
    authenticated: true,
    role: identity.role || 'viewer',
    permissions: identity.permissions || {},
    user: mergeDisplayProfile(identity.user, { name: user.displayName, email: user.email, picture: user.photoURL }),
    error: '',
  });
}

export function getAuthenticationState() {
  return authState;
}

export function expireAuthentication(message = '') {
  setAccessTokenProvider(null);
  // Drop back to the public surface rather than a locked state.
  const permissions = (configuration && configuration.publicPermissions) || FALLBACK_PUBLIC_PERMISSIONS;
  return setState({ authenticated: false, role: 'public', permissions, user: null, error: message });
}

export async function signIn() {
  if (!auth || !configuration?.enabled) throw new Error('Sign-in is not configured.');
  const provider = new GoogleAuthProvider();
  const hostedDomain = configuration.firebase.hostedDomain;
  if (hostedDomain) provider.setCustomParameters({ hd: hostedDomain });

  await signInWithPopup(auth, provider);
  // Authorize BEFORE entering so a rejected (unverified / out-of-domain) account
  // shows the error instead of a reload bounce.
  try {
    await confirmIdentity();
  } catch (error) {
    setAccessTokenProvider(null);
    try { await firebaseSignOut(auth); } catch (_) { /* ignore */ }
    throw error;
  }
  // The popup resolved in-page (unlike Auth0's redirect); reload so the boot
  // sequence re-runs with the now-persisted Firebase session.
  window.location.reload();
}

export async function signOut() {
  setAccessTokenProvider(null);
  if (auth) {
    try { await firebaseSignOut(auth); } catch (_) { /* ignore */ }
  }
  window.location.reload();
}
