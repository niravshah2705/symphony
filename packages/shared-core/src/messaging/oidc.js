'use strict';

const { CONFIG } = require('../config');
const log = require('../logger');

/**
 * Pub/Sub push OIDC verification.
 *
 * A Pub/Sub push subscription authenticates to its Cloud Run endpoint with a
 * Google-signed OIDC token in the Authorization header. Per the header-trust /
 * oauth-oidc checklists we MUST verify that token (signature + audience + the
 * expected pusher service account) before acting on the push — never trust an
 * unauthenticated POST to /pubsub/*.
 *
 * In local/direct mode (MESSAGING_MODE !== 'pubsub') there is no token and no
 * metadata server, so `pushAuth` is a no-op — `npm start` needs no GCP.
 */

let client = null;
function getClient() {
  if (client) return client;
  const { OAuth2Client } = require('google-auth-library');
  client = new OAuth2Client();
  return client;
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : '';
}

/** Verify the push OIDC token on a request; returns the payload or throws. */
async function verifyPushToken(req, { audience, allowedEmails } = {}) {
  const token = bearerToken(req);
  if (!token) {
    const error = new Error('Missing push OIDC token');
    error.status = 401;
    throw error;
  }
  const ticket = await getClient().verifyIdToken({ idToken: token, audience: audience || undefined });
  const payload = ticket.getPayload() || {};
  if (Array.isArray(allowedEmails) && allowedEmails.length && !allowedEmails.includes(payload.email)) {
    const error = new Error('Push token service account is not allowed');
    error.status = 403;
    throw error;
  }
  return payload;
}

/**
 * Express middleware enforcing push OIDC in cloud mode; a no-op locally.
 * @param {{ audience?: string, allowedEmails?: string[] }} [opts]
 */
function pushAuth(opts = {}) {
  const enforce = CONFIG.MESSAGING_MODE === 'pubsub';
  const audience = opts.audience || CONFIG.GCP.pushAudience || undefined;
  const allowedEmails = opts.allowedEmails
    || (CONFIG.GCP.pushServiceAccount ? [CONFIG.GCP.pushServiceAccount] : []);
  return async function verify(req, res, next) {
    if (!enforce) {
      next();
      return;
    }
    try {
      req.pushToken = await verifyPushToken(req, { audience, allowedEmails });
      next();
    } catch (err) {
      log.warn(`rejected pubsub push: ${err && err.message ? err.message : err}`);
      res.status(err && err.status ? err.status : 401).json({ error: err && err.message ? err.message : 'Unauthorized' });
    }
  };
}

module.exports = { verifyPushToken, pushAuth, bearerToken };
