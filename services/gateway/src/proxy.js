'use strict';

const { CONFIG } = require('@ai-fleet/shared/config');
const log = require('@ai-fleet/shared/logger');
const { idTokenHeader, originOf } = require('./service-client');

/**
 * Minimal reverse proxy from the gateway to an isolated agent service.
 *
 * The gateway is the only browser-facing origin; agent read endpoints
 * (/api/agent, /api/coder) are served by separate internal services. This
 * forwards the request (method, path + query, JSON body) and returns the
 * response. All agent endpoints speak JSON, so the body is reconstructed from
 * the already-parsed req.body.
 *
 * The S2S auth (Google OIDC ID token minting for Cloud Run IAM) lives in
 * service-client.js so the proxy and the gateway's own S2S calls share one
 * implementation.
 */

// opts.rewrite = { from, to } rewrites the leading path segment (e.g. mount at
// /api/org but the target service serves /api/v1). opts.forwardUserAuth carries
// the caller's bearer to a service that does its OWN token auth (the org service
// verifies the Firebase ID token): the user token rides in
// X-Forwarded-Authorization while Authorization holds the S2S OIDC token that
// Cloud Run's IAM check requires.
function createProxy(baseUrl, opts = {}) {
  const audience = originOf(baseUrl);

  return async function proxy(req, res) {
    let path = req.originalUrl;
    if (opts.rewrite) path = path.replace(opts.rewrite.from, opts.rewrite.to);
    const target = `${baseUrl}${path}`;
    const headers = {};
    const init = { method: req.method, headers };

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    if (hasBody && req.body && Object.keys(req.body).length > 0) {
      init.body = JSON.stringify(req.body);
      headers['content-type'] = 'application/json';
    }

    const incomingAuth = (req.get && req.get('authorization')) || '';
    if (opts.forwardUserAuth && incomingAuth) {
      headers['x-forwarded-authorization'] = incomingAuth;
    }

    if (CONFIG.MESSAGING_MODE === 'pubsub') {
      try {
        const authorization = await idTokenHeader(audience);
        if (authorization) headers.authorization = authorization;
      } catch (err) {
        log.error(`gateway proxy could not mint ID token for ${audience}: ${err && err.message ? err.message : err}`);
      }
    } else if (opts.forwardUserAuth && incomingAuth) {
      // Local/direct mode: no S2S OIDC — pass the user's bearer straight through.
      headers.authorization = incomingAuth;
    }

    // Trusted headers the gateway derives server-side (e.g. resolved org
    // membership). Safe: this service is reachable only via the gateway SA
    // (Cloud Run IAM) and `headers` starts from {} — client-supplied values are
    // never copied through, so these cannot be spoofed by the browser.
    if (typeof opts.injectHeaders === 'function') {
      const injected = opts.injectHeaders(req) || {};
      for (const [key, value] of Object.entries(injected)) {
        if (value !== undefined && value !== null && value !== '') headers[key.toLowerCase()] = String(value);
      }
    }

    try {
      const resp = await fetch(target, init);
      const text = await resp.text();
      res.status(resp.status);
      const contentType = resp.headers.get('content-type');
      if (contentType) res.set('content-type', contentType);
      res.send(text);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      log.error(`gateway proxy ${req.method} ${target} failed: ${message}`);
      res.status(502).json({ error: `Agent service unavailable: ${message}` });
    }
  };
}

module.exports = { createProxy };
