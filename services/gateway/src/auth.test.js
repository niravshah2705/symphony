'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFirebaseAuthConfig } = require('@ai-fleet/shared/config');
const { createAuthenticationMiddleware, requirePermission, requireAuthenticated, publicAuthConfig, verifyFirebaseIdToken } = require('./auth');

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
    firebase: {
      apiKey: 'AIzaTESTKEY', authDomain: 'demo-proj.firebaseapp.com', projectId: 'demo-proj',
      hostedDomain: undefined, googleClientId: undefined,
      googleEnabled: true, microsoftEnabled: false, microsoftTenant: undefined,
    },
    publicPermissions: { workspace: 'read' },
  });
  const serialized = JSON.stringify(pub);
  assert.doesNotMatch(serialized, /allowedEmails|allowedDomain|x@y\.com/);
});

test('publicAuthConfig surfaces the public One Tap client id when configured', () => {
  const pub = publicAuthConfig(firebaseConfig({ googleClientId: '123.apps.googleusercontent.com' }));
  assert.equal(pub.firebase.googleClientId, '123.apps.googleusercontent.com');
});

test('publicAuthConfig surfaces provider availability flags + Microsoft tenant (no secret)', () => {
  const pub = publicAuthConfig(firebaseConfig({ googleEnabled: false, microsoftEnabled: true, microsoftTenant: 'common' }));
  assert.equal(pub.firebase.googleEnabled, false);
  assert.equal(pub.firebase.microsoftEnabled, true);
  assert.equal(pub.firebase.microsoftTenant, 'common');
  // A tenant id is public, but confirm no client secret ever leaks into the payload.
  assert.doesNotMatch(JSON.stringify(pub), /secret|clientSecret/i);
});

test('publicAuthConfig defaults google on / microsoft off when flags are absent', () => {
  const pub = publicAuthConfig(firebaseConfig());
  assert.equal(pub.firebase.googleEnabled, true);
  assert.equal(pub.firebase.microsoftEnabled, false);
  assert.equal(pub.firebase.microsoftTenant, undefined);
});

test('publicAuthConfig collapses to disabled when auth is off', () => {
  assert.deepEqual(publicAuthConfig({ enabled: false }), { mode: 'disabled', enabled: false });
});

/* ---------------------------- middleware (attach, never deny) ----------- */

test('disabled mode → open with full admin permissions', () => {
  const request = req();
  let nexted = 0;
  createAuthenticationMiddleware({ mode: 'disabled', enabled: false })(request, responseRecorder(), () => { nexted += 1; });
  assert.equal(nexted, 1);
  assert.equal(request.auth.authenticated, true);
  assert.equal(request.auth.role, 'admin');
  assert.equal(request.auth.permissions.settings, 'write');
});

test('firebase: verified user → authenticated with resolved role + permissions', async () => {
  const request = req({ authorization: 'Bearer good' });
  let nexted = 0;
  createAuthenticationMiddleware(firebaseConfig(), verifierReturning(verifiedUser))(request, responseRecorder(), () => { nexted += 1; });
  await tick();
  assert.equal(nexted, 1);
  assert.equal(request.auth.authenticated, true);
  assert.equal(request.auth.user.email, 'operator@uipath.com'); // lowercased
  assert.equal(request.auth.role, 'viewer'); // no claim / not admin → default
  assert.equal(request.auth.permissions.workspace, 'read');
});

test('firebase: bootstrap admin email → admin role', async () => {
  const request = req({ authorization: 'Bearer good' });
  createAuthenticationMiddleware(firebaseConfig({ adminEmails: ['operator@uipath.com'] }), verifierReturning(verifiedUser))(request, responseRecorder(), () => {});
  await tick();
  assert.equal(request.auth.role, 'admin');
  assert.equal(request.auth.permissions.settings, 'write');
});

test('firebase: `role` custom claim is honored (operator)', async () => {
  const request = req({ authorization: 'Bearer good' });
  createAuthenticationMiddleware(firebaseConfig(), verifierReturning({ ...verifiedUser, role: 'operator' }))(request, responseRecorder(), () => {});
  await tick();
  assert.equal(request.auth.role, 'operator');
  assert.equal(request.auth.permissions.planning, 'write');
  assert.equal(request.auth.permissions.settings, 'read'); // operator can read config, not write
});

test('firebase: missing / invalid / unverified / out-of-domain token → PUBLIC (not denied)', async () => {
  const cases = [
    ['no bearer', {}, firebaseConfig(), verifierReturning(verifiedUser)],
    ['invalid token', { authorization: 'Bearer bad' }, firebaseConfig(), verifierReturning(verifiedUser)],
    ['unverified email', { authorization: 'Bearer good' }, firebaseConfig(), verifierReturning({ ...verifiedUser, email_verified: false })],
    ['out of domain', { authorization: 'Bearer good' }, firebaseConfig({ allowedDomain: 'uipath.com' }), verifierReturning({ ...verifiedUser, email: 'op@gmail.com' })],
  ];
  for (const [label, headers, config, verify] of cases) {
    const request = req(headers);
    const res = responseRecorder();
    let nexted = 0;
    createAuthenticationMiddleware(config, verify)(request, res, () => { nexted += 1; });
    await tick();
    assert.equal(nexted, 1, `${label}: middleware must not deny`);
    assert.equal(res.statusCode, 200, `${label}: no error response`);
    assert.equal(request.auth.authenticated, false, label);
    assert.equal(request.auth.role, 'public', label);
    assert.equal(request.auth.permissions.workspace, 'read', label);
    assert.equal(request.auth.permissions.planning, undefined, `${label}: public has no planning`);
  }
});

test('verifyFirebaseIdToken returns a frozen identity carrying the resolved role', async () => {
  const identity = await verifyFirebaseIdToken(req({ authorization: 'Bearer good' }), firebaseConfig(), verifierReturning(verifiedUser));
  assert.equal(identity.email, 'operator@uipath.com');
  assert.equal(identity.role, 'viewer');
  assert.ok(Object.isFrozen(identity));
});

/* ---------------------------- requirePermission (the real gate) --------- */

const authed = (role, permissions) => ({ authenticated: true, role, permissions });
const publicAuth = { authenticated: false, role: 'public', permissions: { workspace: 'read' } };

test('requirePermission: public may READ workspace (read-only Agent home)', () => {
  const request = { method: 'GET', auth: publicAuth };
  let nexted = 0;
  requirePermission('workspace')(request, responseRecorder(), () => { nexted += 1; });
  assert.equal(nexted, 1);
});

test('requirePermission: public WRITING workspace → 401 (prompt sign-in)', () => {
  const request = { method: 'POST', auth: publicAuth };
  const res = responseRecorder();
  let nexted = 0;
  requirePermission('workspace')(request, res, () => { nexted += 1; });
  assert.equal(nexted, 0);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'authentication_required');
});

test('requirePermission: public reaching planning/settings → 401', () => {
  for (const domain of ['planning', 'insights', 'settings']) {
    const res = responseRecorder();
    requirePermission(domain)({ method: 'GET', auth: publicAuth }, res, () => {});
    assert.equal(res.statusCode, 401, domain);
  }
});

test('requirePermission: viewer reads planning but is 403 on writes', () => {
  const perms = { workspace: 'read', planning: 'read', insights: 'read', settings: 'read' };
  let reads = 0;
  requirePermission('planning')({ method: 'GET', auth: authed('viewer', perms) }, responseRecorder(), () => { reads += 1; });
  assert.equal(reads, 1);
  const res = responseRecorder();
  let writes = 0;
  requirePermission('planning')({ method: 'POST', auth: authed('viewer', perms) }, res, () => { writes += 1; });
  assert.equal(writes, 0);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'access_denied');
});

test('requirePermission: forced write level (codex/claude/roles) blocks a read-only settings user', () => {
  const res = responseRecorder();
  let nexted = 0;
  requirePermission('settings', { level: 'write' })({ method: 'GET', auth: authed('operator', { settings: 'read' }) }, res, () => { nexted += 1; });
  assert.equal(nexted, 0);
  assert.equal(res.statusCode, 403);
});

test('requirePermission: OPTIONS preflight is never gated', () => {
  let nexted = 0;
  requirePermission('settings', { level: 'write' })({ method: 'OPTIONS', auth: publicAuth }, responseRecorder(), () => { nexted += 1; });
  assert.equal(nexted, 1);
});

/* ---------------------------- requireAuthenticated (/api/org/me) -------- */

test('requireAuthenticated: any signed-in user passes regardless of role', () => {
  // A default viewer has only org:read, but the personal workspace is theirs.
  const request = { method: 'POST', auth: authed('viewer', { workspace: 'read', org: 'read' }) };
  let nexted = 0;
  requireAuthenticated()(request, responseRecorder(), () => { nexted += 1; });
  assert.equal(nexted, 1);
});

test('requireAuthenticated: anonymous/public → 401', () => {
  const res = responseRecorder();
  let nexted = 0;
  requireAuthenticated()({ method: 'POST', auth: publicAuth }, res, () => { nexted += 1; });
  assert.equal(nexted, 0);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'authentication_required');
});

test('requireAuthenticated: OPTIONS preflight is never gated', () => {
  let nexted = 0;
  requireAuthenticated()({ method: 'OPTIONS', auth: publicAuth }, responseRecorder(), () => { nexted += 1; });
  assert.equal(nexted, 1);
});

test('buildFirebaseAuthConfig: One Tap client id from either env alias (public)', () => {
  const a = buildFirebaseAuthConfig({ AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'p', FIREBASE_API_KEY: 'AIza', GOOGLE_ONE_TAP_CLIENT_ID: 'aaa.apps.googleusercontent.com' });
  assert.equal(a.googleClientId, 'aaa.apps.googleusercontent.com');
  const b = buildFirebaseAuthConfig({ AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'p', FIREBASE_API_KEY: 'AIza', FIREBASE_GOOGLE_CLIENT_ID: 'bbb.apps.googleusercontent.com' });
  assert.equal(b.googleClientId, 'bbb.apps.googleusercontent.com');
});

test('buildFirebaseAuthConfig: provider flags default google on / microsoft off', () => {
  const config = buildFirebaseAuthConfig({ AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'p', FIREBASE_API_KEY: 'AIza' });
  assert.equal(config.googleEnabled, true);
  assert.equal(config.microsoftEnabled, false);
  assert.equal(config.microsoftTenant, '');
});

test('buildFirebaseAuthConfig: reads AUTH_MICROSOFT_ENABLED and Microsoft tenant (either alias)', () => {
  const base = { AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'p', FIREBASE_API_KEY: 'AIza' };
  const a = buildFirebaseAuthConfig({ ...base, AUTH_GOOGLE_ENABLED: 'false', AUTH_MICROSOFT_ENABLED: 'true', MICROSOFT_TENANT: 'organizations' });
  assert.equal(a.googleEnabled, false);
  assert.equal(a.microsoftEnabled, true);
  assert.equal(a.microsoftTenant, 'organizations');
  const b = buildFirebaseAuthConfig({ ...base, AZURE_TENANT_ID: 'tenant-123' });
  assert.equal(b.microsoftTenant, 'tenant-123');
});

test('buildFirebaseAuthConfig: rejects a non-boolean provider flag', () => {
  assert.throws(
    () => buildFirebaseAuthConfig({ AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'p', FIREBASE_API_KEY: 'AIza', AUTH_MICROSOFT_ENABLED: 'maybe' }),
    /AUTH_MICROSOFT_ENABLED must be a boolean/,
  );
});
