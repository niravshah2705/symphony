'use strict';

const { CONFIG } = require('@ai-fleet/shared/config');

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
  });
}

function createAuthenticationMiddleware(config = CONFIG.AUTH, verify = defaultVerify) {
  return function authenticate(req, res, next) {
    if (!config.enabled || config.mode === 'disabled') {
      req.auth = Object.freeze({ mode: 'disabled', authenticated: false, user: null });
      next();
      return;
    }
    if (req.method === 'OPTIONS') {
      req.auth = Object.freeze({ mode: config.mode, authenticated: false, user: null });
      next();
      return;
    }
    verifyFirebaseIdToken(req, config, verify)
      .then((user) => {
        req.auth = Object.freeze({ mode: config.mode, authenticated: true, user });
        next();
      })
      .catch((error) => denyAccess(res, error));
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
    }),
  });
}

/** Whether app auth is enforced (used by the SSE stream-token gate). */
function authEnabled(config = CONFIG.AUTH) {
  return Boolean(config && config.enabled);
}

module.exports = {
  createAuthenticationMiddleware,
  publicAuthConfig,
  verifyFirebaseIdToken,
  authEnabled,
  bearerToken,
};
