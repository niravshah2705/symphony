'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pkce = require('./pkce');
const claude = require('./claude-oauth');
const { CONFIG } = require('../config');

test('buildAuthorizeUrl enforces S256 and carries required params', () => {
  const url = new URL(claude.buildAuthorizeUrl({ state: 'st', codeChallenge: 'cc' }));
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'cc');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('client_id'), CONFIG.CLAUDE.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), CONFIG.CLAUDE.redirectUri);
  assert.equal(url.searchParams.get('scope'), CONFIG.CLAUDE.scope);
});

test('createLogin issues a state whose challenge matches the stored verifier (S256)', () => {
  const { state, authorizeUrl } = claude.createLogin();
  const challenge = new URL(authorizeUrl).searchParams.get('code_challenge');
  const login = claude.consumeLogin(state);
  assert.ok(login && login.codeVerifier);
  assert.equal(pkce.challengeFromVerifier(login.codeVerifier), challenge);
});

test('state is single-use: a second consume is rejected (replay guard)', () => {
  const { state } = claude.createLogin();
  assert.ok(claude.consumeLogin(state));
  assert.equal(claude.consumeLogin(state), null);
});

test('unknown or empty state is rejected', () => {
  assert.equal(claude.consumeLogin('never-issued'), null);
  assert.equal(claude.consumeLogin(''), null);
  assert.equal(claude.consumeLogin(undefined), null);
});

test('parseCodeInput splits code#state, tolerates bare code and full URLs', () => {
  assert.deepEqual(claude.parseCodeInput('abc#xyz'), { code: 'abc', state: 'xyz' });
  assert.deepEqual(claude.parseCodeInput('  abc#xyz  '), { code: 'abc', state: 'xyz' });
  assert.deepEqual(claude.parseCodeInput('bare-code'), { code: 'bare-code', state: '' });
  assert.deepEqual(
    claude.parseCodeInput('https://console.anthropic.com/oauth/code/callback?code=AAA&state=BBB'),
    { code: 'AAA', state: 'BBB' }
  );
  assert.deepEqual(claude.parseCodeInput(''), { code: '', state: '' });
});

test('normalizeTokenResponse rotates refresh token but falls back to previous', () => {
  const rotated = claude.normalizeTokenResponse(
    { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 },
    { refreshToken: 'r1' }
  );
  assert.equal(rotated.accessToken, 'a2');
  assert.equal(rotated.refreshToken, 'r2'); // rotation honored
  assert.ok(rotated.expiresAt > Date.now());

  const kept = claude.normalizeTokenResponse({ access_token: 'a3', expires_in: 60 }, { refreshToken: 'r1' });
  assert.equal(kept.refreshToken, 'r1'); // no new refresh -> keep old
});

test('isExpired: missing token, near-expiry, and valid cases', () => {
  assert.equal(claude.isExpired(null), true);
  assert.equal(claude.isExpired({ accessToken: '', expiresAt: Date.now() + 1e9 }), true);
  assert.equal(claude.isExpired({ accessToken: 'x', expiresAt: Date.now() + 1000 }), true); // within skew
  assert.equal(claude.isExpired({ accessToken: 'x', expiresAt: Date.now() + 3600 * 1000 }), false);
});
