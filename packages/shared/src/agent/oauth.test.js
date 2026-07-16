'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const oauth = require('./oauth');
const { CONFIG } = require('../config');

test('PKCE challenge matches the RFC 7636 §A test vector (S256)', () => {
  // Appendix A reference: verifier -> challenge.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(oauth.challengeFromVerifier(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('generateVerifier returns URL-safe base64 of adequate length', () => {
  const v = oauth.generateVerifier();
  assert.match(v, /^[A-Za-z0-9\-_]{43}$/);
  assert.notEqual(oauth.generateVerifier(), oauth.generateVerifier());
});

test('generateState is random and unguessable', () => {
  const a = oauth.generateState();
  const b = oauth.generateState();
  assert.match(a, /^[A-Za-z0-9\-_]+$/);
  assert.notEqual(a, b);
});

test('buildAuthorizeUrl enforces S256 and carries required params', () => {
  const url = new URL(
    oauth.buildAuthorizeUrl({ state: 'st', codeChallenge: 'cc', redirectUri: CONFIG.OAUTH.redirectUri })
  );
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'cc');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('client_id'), CONFIG.OAUTH.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.OAUTH.redirectUri);
});

test('state is single-use: a second consume is rejected', () => {
  const { state } = oauth.createLogin();
  const first = oauth.consumeLogin(state);
  assert.ok(first && first.codeVerifier);
  assert.equal(oauth.consumeLogin(state), null); // replay rejected
});

test('unknown or empty state is rejected', () => {
  assert.equal(oauth.consumeLogin('never-issued'), null);
  assert.equal(oauth.consumeLogin(''), null);
  assert.equal(oauth.consumeLogin(undefined), null);
});

test('consumed login binds the challenge to the issued verifier (S256)', () => {
  const { state, authorizeUrl } = oauth.createLogin();
  const challenge = new URL(authorizeUrl).searchParams.get('code_challenge');
  const login = oauth.consumeLogin(state);
  assert.equal(oauth.challengeFromVerifier(login.codeVerifier), challenge);
});

test('isExpired: missing token, near-expiry, and valid cases', () => {
  assert.equal(oauth.isExpired(null), true);
  assert.equal(oauth.isExpired({ accessToken: '', expiresAt: Date.now() + 1e9 }), true);
  assert.equal(oauth.isExpired({ accessToken: 'x', expiresAt: Date.now() + 1000 }), true); // within skew
  assert.equal(oauth.isExpired({ accessToken: 'x', expiresAt: Date.now() + 3600 * 1000 }), false);
});

test('accountIdFromIdToken extracts the ChatGPT account id from the id_token', () => {
  // Build a JWT-shaped token (header.payload.signature) with the namespaced claim.
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const idToken = [
    b64url({ alg: 'RS256', typ: 'JWT' }),
    b64url({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_123' } }),
    'sig',
  ].join('.');
  assert.equal(oauth.accountIdFromIdToken(idToken), 'acc_123');
});

test('accountIdFromIdToken returns empty string on missing/malformed input', () => {
  assert.equal(oauth.accountIdFromIdToken(''), '');
  assert.equal(oauth.accountIdFromIdToken(undefined), '');
  assert.equal(oauth.accountIdFromIdToken('not-a-jwt'), ''); // not three segments
  const noClaim = ['h', Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url'), 's'].join('.');
  assert.equal(oauth.accountIdFromIdToken(noClaim), ''); // claim absent
});

test('normalizeTokenResponse rotates refresh token but falls back to previous', () => {
  const rotated = oauth.normalizeTokenResponse(
    { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 },
    { refreshToken: 'r1', idToken: 'id1' }
  );
  assert.equal(rotated.accessToken, 'a2');
  assert.equal(rotated.refreshToken, 'r2'); // rotation honored
  assert.equal(rotated.idToken, 'id1'); // carried forward when absent

  const kept = oauth.normalizeTokenResponse({ access_token: 'a3', expires_in: 60 }, { refreshToken: 'r1' });
  assert.equal(kept.refreshToken, 'r1'); // no new refresh -> keep old
  assert.ok(kept.expiresAt > Date.now());
});
