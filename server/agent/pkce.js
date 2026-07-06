'use strict';

const crypto = require('crypto');

/**
 * Shared OAuth 2.0 PKCE (S256) primitives used by every OAuth provider in this
 * app (Codex, Claude). Kept provider-agnostic and pure so both flows follow the
 * same oauth-oidc checklist: PKCE S256 only, cryptographically random state.
 */

/** base64url with no padding (RFC 7636 §A). */
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE code verifier: 43 chars of base64url (32 random bytes). */
function generateVerifier() {
  return base64url(crypto.randomBytes(32));
}

/** PKCE S256 challenge for a verifier. */
function challengeFromVerifier(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
}

/** Cryptographically random, unguessable CSRF state. */
function generateState() {
  return base64url(crypto.randomBytes(32));
}

module.exports = { base64url, generateVerifier, challengeFromVerifier, generateState };
