'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAuthConfig } = require('@ai-fleet/shared/config');
const {
  createAuthenticationMiddleware,
  decodeVerifiedPayload,
  identityFromClaims,
  publicAuthConfig,
} = require('./auth');

function istioConfig(overrides = {}) {
  return {
    mode: 'istio',
    enabled: true,
    provider: 'auth0',
    payloadHeader: 'x-ai-fleet-jwt-payload',
    domain: 'tenant.example.auth0.com',
    issuer: 'https://tenant.example.auth0.com/',
    clientId: 'client-id',
    audience: 'https://api.ai-fleet.example.com',
    requiredPermission: 'fleet:access',
    redirectUri: 'https://fleet.example.com/',
    logoutReturnTo: 'https://fleet.example.com/',
    scope: 'openid profile email',
    organization: '',
    ...overrides,
  };
}

function claims(overrides = {}) {
  return {
    iss: 'https://tenant.example.auth0.com/',
    aud: ['unrelated', 'https://api.ai-fleet.example.com'],
    sub: 'auth0|operator-123',
    exp: Math.floor(Date.now() / 1000) + 3600,
    name: 'Fleet Operator',
    email: 'operator@example.com',
    scope: 'openid profile fleet:read',
    permissions: ['fleet:access', 'fleet:read', 'fleet:operate'],
    unexpectedSecret: 'not-forwarded',
    ...overrides,
  };
}

function encoded(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('authentication configuration defaults to local disabled mode', () => {
  assert.deepEqual(buildAuthConfig({}), {
    mode: 'disabled',
    enabled: false,
    payloadHeader: 'x-ai-fleet-jwt-payload',
  });
});

test('Istio authentication configuration is complete and public client settings are secret-free', () => {
  const config = buildAuthConfig({
    AUTH_MODE: 'istio',
    AUTH0_DOMAIN: 'tenant.example.auth0.com',
    AUTH0_CLIENT_ID: 'public-spa-client',
    AUTH0_AUDIENCE: 'https://api.ai-fleet.example.com',
    AUTH0_REQUIRED_PERMISSION: 'fleet:access',
    AUTH0_REDIRECT_URI: 'https://fleet.example.com/',
    AUTH0_ORGANIZATION: 'org_123',
  });
  assert.equal(config.issuer, 'https://tenant.example.auth0.com/');
  assert.equal(config.payloadHeader, 'x-ai-fleet-jwt-payload');
  assert.equal(config.requiredPermission, 'fleet:access');
  assert.deepEqual(publicAuthConfig(config), {
    mode: 'istio',
    enabled: true,
    provider: 'auth0',
    auth0: {
      domain: 'tenant.example.auth0.com',
      clientId: 'public-spa-client',
      audience: 'https://api.ai-fleet.example.com',
      redirectUri: 'https://fleet.example.com/',
      logoutReturnTo: 'https://fleet.example.com/',
      scope: 'openid profile email',
      organization: 'org_123',
    },
  });
  assert.doesNotMatch(JSON.stringify(publicAuthConfig(config)), /payloadHeader|issuer|secret/i);
});

test('Istio authentication configuration fails closed when required values are unsafe or missing', () => {
  assert.throws(() => buildAuthConfig({ AUTH_MODE: 'production' }), /AUTH_MODE/);
  assert.throws(() => buildAuthConfig({ NODE_ENV: 'production' }), /AUTH_MODE=istio/);
  assert.throws(() => buildAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'disabled' }), /AUTH_MODE=istio/);
  assert.throws(() => buildAuthConfig({ AUTH_MODE: 'istio' }), /AUTH0_DOMAIN/);
  assert.throws(() => buildAuthConfig({
    AUTH_MODE: 'istio',
    AUTH0_DOMAIN: 'tenant.example.auth0.com',
    AUTH0_CLIENT_ID: 'client',
    AUTH0_AUDIENCE: 'api',
    AUTH0_REDIRECT_URI: 'https://fleet.example.com/',
  }), /AUTH0_REQUIRED_PERMISSION/);
  assert.throws(() => buildAuthConfig({
    AUTH_MODE: 'istio',
    AUTH0_DOMAIN: 'https://tenant.example.auth0.com/',
    AUTH0_CLIENT_ID: 'client',
    AUTH0_AUDIENCE: 'api',
    AUTH0_REDIRECT_URI: 'https://fleet.example.com/',
  }), /hostname/);
  assert.throws(() => buildAuthConfig({
    AUTH_MODE: 'istio',
    AUTH0_DOMAIN: 'tenant.example.auth0.com',
    AUTH0_CLIENT_ID: 'client',
    AUTH0_AUDIENCE: 'api',
    AUTH0_REDIRECT_URI: 'http://fleet.example.com/',
  }), /HTTPS/);
});

test('verified payload parsing returns only normalized identity claims', () => {
  const decoded = decodeVerifiedPayload(encoded(claims()));
  const identity = identityFromClaims(decoded, istioConfig());
  assert.deepEqual(identity, {
    sub: 'auth0|operator-123',
    name: 'Fleet Operator',
    email: 'operator@example.com',
    organizationId: '',
    permissions: ['fleet:access', 'fleet:read', 'fleet:operate'],
    scopes: ['openid', 'profile', 'fleet:read'],
  });
  assert.equal(identity.unexpectedSecret, undefined);
});

test('identity validation rejects malformed, expired, wrong-issuer, and wrong-audience claims', () => {
  assert.throws(() => decodeVerifiedPayload('not-json'), /malformed/);
  assert.throws(() => identityFromClaims(claims({ exp: 1 }), istioConfig()), /expired/);
  assert.throws(() => identityFromClaims(claims({ iss: 'https://attacker.example/' }), istioConfig()), /issuer/);
  assert.throws(() => identityFromClaims(claims({ aud: 'another-api' }), istioConfig()), /audience/);
  assert.throws(() => identityFromClaims(
    claims({ org_id: 'org_other' }),
    istioConfig({ organization: 'org_expected' })
  ), /organization/);
  assert.throws(() => identityFromClaims(
    claims({ permissions: [], scope: 'openid profile fleet:access' }),
    istioConfig()
  ), (error) => error.status === 403 && error.code === 'access_denied' && /permission/.test(error.message));
  assert.throws(() => identityFromClaims(claims({ sub: '' }), istioConfig()), /subject/);
});

test('gateway middleware permits local mode and requires the Istio verified payload in production', () => {
  let localNext = 0;
  createAuthenticationMiddleware({ mode: 'disabled', enabled: false })({}, responseRecorder(), () => { localNext += 1; });
  assert.equal(localNext, 1);

  const config = istioConfig();
  const missingResponse = responseRecorder();
  createAuthenticationMiddleware(config)({ method: 'GET', get: () => '' }, missingResponse, () => {});
  assert.equal(missingResponse.statusCode, 401);
  assert.equal(missingResponse.body.code, 'authentication_required');
  assert.match(missingResponse.headers['www-authenticate'], /^Bearer/);

  const request = {
    method: 'GET',
    get: (name) => name === config.payloadHeader ? encoded(claims()) : '',
  };
  let protectedNext = 0;
  createAuthenticationMiddleware(config)(request, responseRecorder(), () => { protectedNext += 1; });
  assert.equal(protectedNext, 1);
  assert.equal(request.auth.authenticated, true);
  assert.equal(request.auth.user.sub, 'auth0|operator-123');

  const deniedResponse = responseRecorder();
  createAuthenticationMiddleware(config)({
    method: 'GET',
    get: () => encoded(claims({ permissions: [], scope: 'openid profile' })),
  }, deniedResponse, () => {});
  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(deniedResponse.body.code, 'access_denied');
});

test('CORS preflight can reach Express without an access token', () => {
  const request = { method: 'OPTIONS', get: () => '' };
  let nextCalls = 0;
  createAuthenticationMiddleware(istioConfig())(request, responseRecorder(), () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.equal(request.auth.authenticated, false);
});
