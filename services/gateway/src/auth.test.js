'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFirebaseAuthConfig } = require('@ai-fleet/shared/config');
const { createAuthenticationMiddleware, publicAuthConfig, verifyFirebaseIdToken } = require('./auth');

function firebaseConfig(overrides = {}) {
  return {
    mode: 'firebase',
    enabled: true,
    provider: 'firebase',
    projectId: 'demo-proj',
    apiKey: 'AIzaTESTKEY',
    authDomain: 'demo-proj.firebaseapp.com',
    issuer: 'https://securetoken.google.com/demo-proj',
    audience: 'demo-proj',
    allowedEmails: [],
    allowedDomain: '',
    hostedDomain: '',
    ...overrides,
  };
}

// A stub Firebase verifier: 'good' → a verified Google user; anything else rejects.
function verifierReturning(decoded) {
  return async (token) => {
    if (token !== 'good') throw new Error('invalid token');
    return decoded;
  };
}
const verifiedUser = { uid: 'uid-1', email: 'Operator@UiPath.com', email_verified: true, name: 'Fleet Operator', picture: 'https://pic' };

function req(headers = {}, method = 'GET') {
  return { method, get: (name) => headers[String(name).toLowerCase()] || '' };
}
function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    json(body) { this.body = body; return this; },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ---------------------------- config builder ---------------------------- */

test('buildFirebaseAuthConfig: disabled by default (local, open)', () => {
  assert.deepEqual(buildFirebaseAuthConfig({}), { mode: 'disabled', enabled: false, provider: 'none' });
});

test('buildFirebaseAuthConfig: firebase mode derives issuer/audience/authDomain', () => {
  const config = buildFirebaseAuthConfig({ AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'p', FIREBASE_API_KEY: 'AIza' });
  assert.equal(config.enabled, true);
  assert.equal(config.issuer, 'https://securetoken.google.com/p');
  assert.equal(config.audience, 'p');
  assert.equal(config.authDomain, 'p.firebaseapp.com');
});

test('buildFirebaseAuthConfig: fails closed on missing project/api key and in production', () => {
  assert.throws(() => buildFirebaseAuthConfig({ AUTH_MODE: 'firebase' }), /FIREBASE_PROJECT_ID/);
  assert.throws(() => buildFirebaseAuthConfig({ AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'p' }), /FIREBASE_API_KEY/);
  assert.throws(() => buildFirebaseAuthConfig({ NODE_ENV: 'production' }), /AUTH_MODE must be firebase/);
  assert.throws(() => buildFirebaseAuthConfig({ AUTH_MODE: 'istio' }), /disabled or firebase/);
});

/* ---------------------------- publicAuthConfig -------------------------- */

test('publicAuthConfig exposes only the public Firebase web config (no authz secrets)', () => {
  const pub = publicAuthConfig(firebaseConfig({ allowedEmails: ['x@y.com'], allowedDomain: 'uipath.com' }));
  assert.deepEqual(pub, {
    mode: 'firebase',
    enabled: true,
    provider: 'firebase',
    firebase: { apiKey: 'AIzaTESTKEY', authDomain: 'demo-proj.firebaseapp.com', projectId: 'demo-proj', hostedDomain: undefined },
  });
  const serialized = JSON.stringify(pub);
  assert.doesNotMatch(serialized, /allowedEmails|allowedDomain|x@y\.com/);
});

test('publicAuthConfig collapses to disabled when auth is off', () => {
  assert.deepEqual(publicAuthConfig({ enabled: false }), { mode: 'disabled', enabled: false });
});

/* ---------------------------- middleware -------------------------------- */

test('disabled mode is open (no token required)', () => {
  const request = req();
  let nexted = 0;
  createAuthenticationMiddleware({ mode: 'disabled', enabled: false })(request, responseRecorder(), () => { nexted += 1; });
  assert.equal(nexted, 1);
  assert.equal(request.auth.authenticated, false);
});

test('firebase mode admits a verified Google user and normalizes identity', async () => {
  const request = req({ authorization: 'Bearer good' });
  let nexted = 0;
  createAuthenticationMiddleware(firebaseConfig(), verifierReturning(verifiedUser))(request, responseRecorder(), () => { nexted += 1; });
  await tick();
  assert.equal(nexted, 1);
  assert.equal(request.auth.authenticated, true);
  assert.equal(request.auth.user.email, 'operator@uipath.com'); // lowercased
  assert.equal(request.auth.user.name, 'Fleet Operator');
  assert.equal(request.auth.user.sub, 'uid-1');
});

test('firebase mode rejects a missing bearer (401)', async () => {
  const res = responseRecorder();
  createAuthenticationMiddleware(firebaseConfig(), verifierReturning(verifiedUser))(req(), res, () => {});
  await tick();
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'authentication_required');
});

test('firebase mode rejects an invalid token (401)', async () => {
  const res = responseRecorder();
  createAuthenticationMiddleware(firebaseConfig(), verifierReturning(verifiedUser))(req({ authorization: 'Bearer bad' }), res, () => {});
  await tick();
  assert.equal(res.statusCode, 401);
});

test('firebase mode rejects an unverified email (403)', async () => {
  const res = responseRecorder();
  const verify = verifierReturning({ ...verifiedUser, email_verified: false });
  createAuthenticationMiddleware(firebaseConfig(), verify)(req({ authorization: 'Bearer good' }), res, () => {});
  await tick();
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'access_denied');
});

test('firebase mode enforces the email allowlist when configured (403)', async () => {
  const res = responseRecorder();
  const config = firebaseConfig({ allowedEmails: ['someone-else@uipath.com'] });
  createAuthenticationMiddleware(config, verifierReturning(verifiedUser))(req({ authorization: 'Bearer good' }), res, () => {});
  await tick();
  assert.equal(res.statusCode, 403);
});

test('firebase mode enforces the allowed domain when configured', async () => {
  // Wrong domain → 403.
  const denied = responseRecorder();
  const domainConfig = firebaseConfig({ allowedDomain: 'uipath.com' });
  const gmailUser = { ...verifiedUser, email: 'op@gmail.com' };
  createAuthenticationMiddleware(domainConfig, verifierReturning(gmailUser))(req({ authorization: 'Bearer good' }), denied, () => {});
  await tick();
  assert.equal(denied.statusCode, 403);

  // Right domain → allowed.
  const request = req({ authorization: 'Bearer good' });
  let nexted = 0;
  createAuthenticationMiddleware(domainConfig, verifierReturning(verifiedUser))(request, responseRecorder(), () => { nexted += 1; });
  await tick();
  assert.equal(nexted, 1);
  assert.equal(request.auth.user.email, 'operator@uipath.com');
});

test('verifyFirebaseIdToken returns a frozen normalized identity', async () => {
  const identity = await verifyFirebaseIdToken(req({ authorization: 'Bearer good' }), firebaseConfig(), verifierReturning(verifiedUser));
  assert.equal(identity.email, 'operator@uipath.com');
  assert.ok(Object.isFrozen(identity));
});
