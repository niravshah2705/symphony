'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');
const {
  resolveRole,
  permissionsForRole,
  permitted,
  requiredLevel,
  PUBLIC_PERMISSIONS,
  ADMIN_PERMISSIONS,
} = require('@ai-fleet/shared-core/authz');

/**
 * Application authentication — Firebase Google SSO.
 *
 * The SPA signs in with Google via Firebase Authentication and sends the Firebase
 * ID token as `Authorization: Bearer`. This middleware verifies that token with
 * the Firebase Admin SDK (signature + issuer `securetoken.google.com/<projectId>`
 * + audience `<projectId>` + expiry), requires a verified email, and applies the
 * optional allowlist/domain gate. `AUTH_MODE=disabled` (local dev) is open.
 *
 * firebase-admin is required lazily so local/disabled deployments never load it.
 */

function authError(message) {
  const error = new Error(message);
  error.status = 401;
  error.code = 'authentication_required';
  return error;
}

function authorizationError(message) {
  const error = new Error(message);
  error.status = 403;
  error.code = 'access_denied';
  return error;
}

function boundedClaim(value, maxLength = 320) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) return '';
  return normalized;
}

function bearerToken(req) {
  const header = (req.get && req.get('authorization')) || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (!match) throw authError('Authentication bearer token is missing');
  return match[1];
}

function denyAccess(res, error) {
  const status = error?.status === 403 ? 403 : 401;
  res.status(status).set('Cache-Control', 'no-store');
  if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="AI Fleet"');
  res.json({
    error: error?.message || (status === 403 ? 'Access denied' : 'Authentication required'),
    code: error?.code || (status === 403 ? 'access_denied' : 'authentication_required'),
  });
}

// Lazily initialize the Firebase Admin app (verifyIdToken needs only projectId;
// ADC on Cloud Run supplies credentials — no service-account key required).
let firebaseAuth = null;
function getFirebaseAuth(config) {
  if (firebaseAuth) return firebaseAuth;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  if (!getApps().length) initializeApp({ projectId: config.projectId });
  firebaseAuth = getAuth();
  return firebaseAuth;
}

async function defaultVerify(token, config) {
  return getFirebaseAuth(config).verifyIdToken(token);
}

/**
 * Verify the request's Firebase ID token and return the normalized identity, or
 * throw a 401/403. `verify` is injectable so unit tests need not load firebase-admin.
 */
async function verifyFirebaseIdToken(req, config = CONFIG.AUTH, verify = defaultVerify) {
  const token = bearerToken(req);
  let decoded;
  try {
    decoded = await verify(token, config);
  } catch (_) {
    throw authError('Authentication token is invalid or expired');
  }
  if (!decoded || decoded.email_verified !== true) {
    throw authorizationError('A verified email is required');
  }
  const email = boundedClaim(decoded.email, 320).toLowerCase();
  if (!email) throw authorizationError('Authentication email is missing');
  if (config.allowedEmails && config.allowedEmails.length && !config.allowedEmails.includes(email)) {
    throw authorizationError('This account is not allowed');
  }
  if (config.allowedDomain && !email.endsWith(`@${config.allowedDomain}`)) {
    throw authorizationError('This email domain is not allowed');
  }
  return Object.freeze({
    sub: boundedClaim(decoded.uid || decoded.sub, 512),
    email,
    name: boundedClaim(decoded.name, 320),
    picture: boundedClaim(decoded.picture, 1024),
    // Role comes from the verified `role` custom claim (or the bootstrap-admin /
    // default-role fallback) — never from anything the browser can set directly.
    role: resolveRole(decoded, config),
  });
}

const PUBLIC_AUTH = Object.freeze({
  mode: 'firebase',
  authenticated: false,
  role: 'public',
  user: null,
  permissions: PUBLIC_PERMISSIONS,
});

/**
 * Attach the caller's identity + permissions to `req.auth`. It does NOT deny —
 * authorization is decided per-route by requirePermission(). An absent, invalid,
 * expired, or unauthorized (unverified/out-of-allowlist) token yields the PUBLIC
 * permission set, so unauthenticated visitors get exactly the public surface
 * (read-only Agent workspace) and nothing more.
 */
function createAuthenticationMiddleware(config = CONFIG.AUTH, verify = defaultVerify) {
  return function authenticate(req, res, next) {
    if (!config.enabled || config.mode === 'disabled') {
      // Local single-operator workflow — fully open.
      req.auth = Object.freeze({ mode: 'disabled', authenticated: true, role: 'admin', user: null, permissions: ADMIN_PERMISSIONS });
      next();
      return;
    }
    if (req.method === 'OPTIONS') {
      req.auth = PUBLIC_AUTH;
      next();
      return;
    }
    verifyFirebaseIdToken(req, config, verify)
      .then((user) => {
        req.auth = Object.freeze({
          mode: config.mode,
          authenticated: true,
          role: user.role,
          user,
          permissions: permissionsForRole(user.role),
        });
        next();
      })
      .catch(() => {
        req.auth = PUBLIC_AUTH;
        next();
      });
  };
}

/**
 * Route guard: require `domain` at the level implied by the HTTP method (GET →
 * read, mutations → write), or an explicit `opts.level`. This is the real
 * authorization boundary — apply it to EVERY sensitive router. Unauthenticated
 * callers who lack the permission get 401 (prompt sign-in); authenticated
 * callers who lack it get 403.
 */
function requirePermission(domain, opts = {}) {
  return function authorize(req, res, next) {
    if (req.method === 'OPTIONS') return next(); // CORS preflight — never gated
    const level = opts.level || requiredLevel(req.method);
    const auth = req.auth || PUBLIC_AUTH;
    if (permitted(auth.permissions, domain, level)) return next();
    return denyAccess(res, auth.authenticated
      ? authorizationError('You do not have permission to access this resource')
      : authError('Authentication required'));
  };
}

/**
 * Route guard: require an AUTHENTICATED identity (any role), independent of the
 * permission domains. Used for the personal-workspace surface (/api/org/me/*),
 * which every signed-in user may use even without an org role — the org service
 * enforces owner-scoping. Public/anonymous callers get 401. Local dev is open.
 */
function requireAuthenticated() {
  return function authenticate(req, res, next) {
    if (req.method === 'OPTIONS') return next(); // CORS preflight — never gated
    const auth = req.auth || PUBLIC_AUTH;
    if (auth.authenticated) return next();
    return denyAccess(res, authError('Authentication required'));
  };
}

/** Public, non-secret Firebase web config for the SPA (safe to expose). */
function publicAuthConfig(config = CONFIG.AUTH) {
  if (!config.enabled) return Object.freeze({ mode: 'disabled', enabled: false });
  return Object.freeze({
    mode: config.mode,
    enabled: true,
    provider: config.provider,
    firebase: Object.freeze({
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      hostedDomain: config.hostedDomain || undefined,
      // Public OAuth Web client id for Google One Tap (falls back to the popup
      // when absent). Not a secret — see packages/shared/src/config.js.
      googleClientId: config.googleClientId || undefined,
      // Which sign-in buttons the SPA renders. Google defaults on unless
      // explicitly disabled; Microsoft is opt-in. The Azure tenant is public
      // (the client secret stays in the Firebase console, never here).
      googleEnabled: config.googleEnabled !== false,
      microsoftEnabled: Boolean(config.microsoftEnabled),
      microsoftTenant: config.microsoftTenant || undefined,
    }),
    // What an unauthenticated visitor may do — lets the SPA render the public
    // (read-only Agent) surface and hide everything else before sign-in.
    publicPermissions: PUBLIC_PERMISSIONS,
  });
}

/** Whether app auth is enforced (used by the SSE stream-token gate). */
function authEnabled(config = CONFIG.AUTH) {
  return Boolean(config && config.enabled);
}

module.exports = {
  createAuthenticationMiddleware,
  requirePermission,
  requireAuthenticated,
  publicAuthConfig,
  verifyFirebaseIdToken,
  authEnabled,
  bearerToken,
};
