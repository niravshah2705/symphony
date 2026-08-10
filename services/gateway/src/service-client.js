'use strict';

const { CONFIG } = require('@ai-fleet/shared/config');
const log = require('@ai-fleet/shared/logger');

/**
 * Server-to-server client helpers shared by the reverse proxy (proxy.js) and the
 * gateway's own S2S calls (e.g. the deployment resolver at GET /api/config).
 *
 * In the cloud (MESSAGING_MODE=pubsub) internal services run with internal
 * ingress + `--no-allow-unauthenticated`, so the gateway must present a Google
 * OIDC ID token (audience = the target service origin) for Cloud Run's IAM
 * check. Locally (direct mode) no token is minted. google-auth-library is
 * required lazily so local dev never loads it.
 */

let googleAuth = null;
const idTokenClients = new Map();

/** Mint the `Authorization` header value (a Google OIDC ID token) for an audience. */
async function idTokenHeader(audience) {
  if (!googleAuth) {
    const { GoogleAuth } = require('google-auth-library');
    googleAuth = new GoogleAuth();
  }
  if (!idTokenClients.has(audience)) {
    idTokenClients.set(audience, await googleAuth.getIdTokenClient(audience));
  }
  const client = idTokenClients.get(audience);
  const headers = await client.getRequestHeaders();
  return headers.Authorization || headers.authorization || '';
}

function originOf(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch (_) {
    return baseUrl;
  }
}

/**
 * Make an S2S JSON request to an internal service and return { status, data }.
 * Attaches the same auth as createProxy: the caller's bearer rides in
 * X-Forwarded-Authorization (the target does its OWN Firebase-token
 * verification) while Authorization carries the S2S OIDC token Cloud Run's IAM
 * requires. In direct/local mode the user bearer passes through as Authorization.
 *
 * @param {string} baseUrl  target service base URL (e.g. CONFIG.SERVICES.orgUrl)
 * @param {string} path     absolute path on the target (e.g. '/api/v1/me/deployment')
 * @param {{ method?: string, body?: unknown, userAuth?: string }} [opts]
 * @returns {Promise<{ status: number, data: unknown }>}
 */
async function callJson(baseUrl, path, opts = {}) {
  const { method = 'GET', body, userAuth } = opts;
  const target = `${baseUrl}${path}`;
  const headers = {};
  const init = { method, headers };

  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  if (userAuth) headers['x-forwarded-authorization'] = userAuth;

  if (CONFIG.MESSAGING_MODE === 'pubsub') {
    try {
      const authorization = await idTokenHeader(originOf(baseUrl));
      if (authorization) headers.authorization = authorization;
    } catch (err) {
      log.error(`service-client could not mint ID token for ${target}: ${err && err.message ? err.message : err}`);
    }
  } else if (userAuth) {
    headers.authorization = userAuth;
  }

  const resp = await fetch(target, init);
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  return { status: resp.status, data };
}

module.exports = { callJson, idTokenHeader, originOf };
