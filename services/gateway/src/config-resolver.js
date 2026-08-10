'use strict';

const { CONFIG } = require('@ai-fleet/shared/config');
const log = require('@ai-fleet/shared/logger');
const { callJson: defaultCallJson } = require('./service-client');

/**
 * GET /api/config — the SPA's per-org deployment resolver.
 *
 * The browser calls this after sign-in to learn which front-facing gateway to
 * use. It is SERVER-AUTHORITATIVE: the org is derived from the caller's token by
 * the org service (GET /api/v1/me/deployment); this endpoint accepts NO
 * client-supplied org id, so a caller can only ever learn their OWN org's
 * deployment (cross-tenant isolation). Only the browser-facing gateway URL is
 * returned — planner/coder/org/settings URLs are never sent to the client.
 *
 * `callJson` is injected so the handler is unit-testable without a live org
 * service. It fails OPEN to the shared gateway (gatewayUrl:'') on any org-service
 * error so the SPA keeps working on this origin.
 */
function createConfigResolver({ callJson = defaultCallJson } = {}) {
  return async function handleConfig(req, res) {
    res.set('Cache-Control', 'no-store');

    if (!req.auth || !req.auth.authenticated) {
      // Anonymous → same-origin (the shared gateway the SPA already loaded).
      return res.json({ authenticated: false, status: 'shared', gatewayUrl: '' });
    }
    if (!CONFIG.SERVICES.orgUrl) {
      return res.status(501).json({ error: 'Organization service is not configured (ORG_URL unset).' });
    }

    const userAuth = req.get ? req.get('authorization') : undefined;
    try {
      const { status, data } = await callJson(CONFIG.SERVICES.orgUrl, '/api/v1/me/deployment', { userAuth });
      if (status < 200 || status >= 300 || !data || typeof data !== 'object') {
        log.error(`gateway /api/config: org resolver returned ${status}`);
        return res.json({ authenticated: true, status: 'shared', gatewayUrl: '' });
      }
      // Only a PROVISIONED per-tenant stack re-points the browser's base; every
      // other state (shared/provisioning/failed) keeps the SPA on this gateway.
      const provisioned = data.status === 'provisioned' && data.gateway_url;
      return res.json({
        authenticated: true,
        status: typeof data.status === 'string' ? data.status : 'shared',
        gatewayUrl: provisioned ? String(data.gateway_url) : '',
        orgName: data.org_name || null,
      });
    } catch (err) {
      log.error(`gateway /api/config failed: ${err && err.message ? err.message : err}`);
      return res.json({ authenticated: true, status: 'shared', gatewayUrl: '' });
    }
  };
}

module.exports = { createConfigResolver };
