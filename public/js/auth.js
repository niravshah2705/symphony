import { initializeApp } from '/vendor/firebase/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithCredential,
  signInWithPopup,
  signOut as firebaseSignOut,
} from '/vendor/firebase/firebase-auth.js';
import { api, setAccessTokenProvider, getApiBase, setApiBase } from './api.js';
import { pollUntilResolved } from './deployment.js';

const AUTH_SESSION_TIMEOUT_MS = 15_000;
// Google Identity Services (One Tap). Loaded on demand only when a public
// client id is configured; the app works without it (popup fallback).
const GIS_SRC = 'https://accounts.google.com/gsi/client';
let gisPromise = null;

let auth = null;
let currentUser = null;
let configuration = null;
// Full local access when auth is disabled; read-only Agent workspace for public.
// Mirrors the server admin permission set (packages/shared/src/authz.js).
const ADMIN_PERMISSIONS = Object.freeze({ workspace: 'write', planning: 'write', insights: 'write', settings: 'write', org: 'write' });
const FALLBACK_PUBLIC_PERMISSIONS = Object.freeze({ workspace: 'read' });

let authState = Object.freeze({
  mode: 'loading',
  enabled: false,
  authenticated: false,
  role: 'public',
  permissions: {},
  user: null,
  error: '',
  // Per-org deployment (resolved after sign-in via GET /api/config): 'shared'
  // (the shared stack), 'provisioning' (a dedicated stack is coming up), or
  // 'provisioned' (using the per-tenant gateway). orgName is the workspace label.
  deploymentStatus: 'shared',
  orgName: null,
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

// After sign-in, resolve which front-facing gateway this session should use.
// A PROVISIONED per-tenant org re-points the API base at its own gateway (a full
// gateway image that verifies the same Firebase token); a shared/pseudo
// workspace stays on the shared gateway (the bootstrap base). Best-effort — any
// failure leaves the SPA on the shared gateway. Runs after confirmIdentity so the
// access-token provider is set (the /api/config call carries the bearer).
function emitDeploymentStatus(status) {
  try {
    window.dispatchEvent(new CustomEvent('ai-fleet:deployment-status', { detail: { status: status || 'shared' } }));
  } catch (_) {
    /* non-browser / no CustomEvent */
  }
}

// While a dedicated stack is coming up, poll the SHARED gateway's resolver in the
// background (init is NOT blocked). On 'provisioned' we re-point + reload so the
// whole app re-boots against the tenant gateway; other terminal states just
// surface via the status event.
function watchProvisioning() {
  emitDeploymentStatus('provisioning');
  pollUntilResolved({
    fetchConfig: () => api.getRuntimeConfig(),
    onStatus: emitDeploymentStatus,
  })
    .then((cfg) => {
      if (cfg && cfg.status === 'provisioned' && cfg.gatewayUrl) {
        setApiBase(cfg.gatewayUrl);
        emitDeploymentStatus('provisioned');
        window.location.reload();
      } else {
        emitDeploymentStatus((cfg && cfg.status) || 'failed');
      }
    })
    .catch(() => {});
}

async function resolveDeployment() {
  let cfg;
  try {
    cfg = await api.getRuntimeConfig();
  } catch (_) {
    return { deploymentStatus: 'shared', orgName: null };
  }
  const status = cfg?.status || 'shared';
  if (status === 'provisioned' && cfg.gatewayUrl) {
    setApiBase(cfg.gatewayUrl);
  } else if (status === 'provisioning') {
    watchProvisioning(); // background — do not await
  }
  return { deploymentStatus: status, orgName: cfg?.orgName || null };
}

// Confirm the signed-in user is accepted by the gateway (verified email +
// any allowlist/domain gate). Provider-agnostic — Google and Microsoft both
// resolve to the same Firebase session. Returns the server identity or throws.
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

  const deployment = await resolveDeployment();
  return setState({
    mode: 'firebase',
    enabled: true,
    authenticated: true,
    role: identity.role || 'viewer',
    permissions: identity.permissions || {},
    user: mergeDisplayProfile(identity.user, { name: user.displayName, email: user.email, picture: user.photoURL }),
    error: '',
    deploymentStatus: deployment.deploymentStatus,
    orgName: deployment.orgName,
  });
}

export function getAuthenticationState() {
  return authState;
}

// Which sign-in buttons the SPA should render, from the public auth config.
// Google defaults on (backward compatible with configs predating the flag);
// Microsoft is opt-in via AUTH_MICROSOFT_ENABLED.
export function getAuthProviders() {
  const firebase = configuration?.firebase || {};
  return Object.freeze({
    google: firebase.googleEnabled !== false,
    microsoft: Boolean(firebase.microsoftEnabled),
  });
}

export function expireAuthentication(message = '') {
  setAccessTokenProvider(null);
  // Drop back to the public surface rather than a locked state.
  const permissions = (configuration && configuration.publicPermissions) || FALLBACK_PUBLIC_PERMISSIONS;
  return setState({ authenticated: false, role: 'public', permissions, user: null, error: message });
}

// Run a Firebase popup sign-in for the given provider, then authorize the
// account with the gateway BEFORE entering so a rejected (unverified /
// out-of-domain) account shows the error instead of a reload bounce. Firebase
// (Identity Platform ↔ the IdP) owns the OAuth authorization-code + state +
// nonce + PKCE exchange — we never handle those directly.
async function completeSignIn(provider) {
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    // Firebase's default "one account per email" rejects a second provider for
    // an email that already exists. Surface a friendly, provider-neutral hint.
    if (error?.code === 'auth/account-exists-with-different-credential') {
      throw new Error('This email is already registered with a different sign-in method. Use the provider you first signed in with.');
    }
    throw error;
  }
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

export async function signIn() {
  if (!auth || !configuration?.enabled) throw new Error('Sign-in is not configured.');
  const provider = new GoogleAuthProvider();
  const hostedDomain = configuration.firebase.hostedDomain;
  if (hostedDomain) provider.setCustomParameters({ hd: hostedDomain });
  return completeSignIn(provider);
}

export async function signInWithMicrosoft() {
  if (!auth || !configuration?.enabled) throw new Error('Sign-in is not configured.');
  const provider = new OAuthProvider('microsoft.com');
  // Optional Azure AD tenant scope ('common' when unset). Public, not a secret.
  const tenant = configuration.firebase.microsoftTenant;
  if (tenant) provider.setCustomParameters({ tenant });
  return completeSignIn(provider);
}

export async function signOut() {
  setAccessTokenProvider(null);
  if (auth) {
    try { await firebaseSignOut(auth); } catch (_) { /* ignore */ }
  }
  window.location.reload();
}

// --- Google One Tap -------------------------------------------------------

function loadGisScript() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve(window.google));
    script.addEventListener('error', () => reject(new Error('Google sign-in could not load.')));
    document.head.appendChild(script);
  });
  return gisPromise;
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * Show the Google One Tap prompt (the compact "Sign in with Google" card). The
 * returned Google ID token is exchanged for a Firebase session via
 * signInWithCredential; a per-prompt nonce (hashed for Google, raw for Firebase)
 * binds the credential against replay (oauth-oidc). The gateway still verifies
 * the resulting Firebase ID token on every request — One Tap only changes how
 * the browser acquires it. No-op (popup remains the fallback) when no public
 * client id is configured, the GIS script is blocked, or a user is signed in.
 */
export async function promptOneTap() {
  const clientId = configuration?.firebase?.googleClientId;
  if (!auth || !configuration?.enabled || !clientId || auth.currentUser) return false;

  let google;
  try {
    google = await loadGisScript();
  } catch (_) {
    return false;
  }
  if (!google?.accounts?.id) return false;

  const rawNonce = randomNonce();
  const hashedNonce = await sha256Hex(rawNonce);
  try {
    google.accounts.id.initialize({
      client_id: clientId,
      nonce: hashedNonce,
      auto_select: false,
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true,
      callback: async (response) => {
        try {
          const credential = new OAuthProvider('google.com').credential({
            idToken: response.credential,
            rawNonce,
          });
          await signInWithCredential(auth, credential);
          await confirmIdentity(); // reject unverified / out-of-domain before entering
          window.location.reload();
        } catch (_) {
          setAccessTokenProvider(null);
          try { await firebaseSignOut(auth); } catch (_) { /* ignore */ }
        }
      },
    });
    google.accounts.id.prompt();
    return true;
  } catch (_) {
    return false;
  }
}
