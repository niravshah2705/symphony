'use strict';

const { CONFIG } = require('@ai-fleet/shared/config');
const log = require('@ai-fleet/shared/logger');
const { callJson: defaultCallJson } = require('./service-client');
const { requestContext } = require('./request-context');

/**
 * GET /api/config — the SPA's per-org deployment resolver.
 *
 * The browser calls this after sign-in to learn which front-facing gateway to
 * use. It is SERVER-AUTHORITATIVE: the selected organization header is first
 * validated against `/me/context`, then the org service independently resolves
 * membership for `/me/deployment`. Only the browser-facing gateway URL is
 * returned — planner/coder/org/settings URLs are never sent to the client.
 *
 * `callJson` is injected so the handler is unit-testable without a live org
 * service. Authenticated resolution fails closed: inferring "shared" from an
 * upstream error could move a tenant session onto a different store namespace.
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
      const { status, data } = await callJson(CONFIG.SERVICES.orgUrl, '/api/v1/me/deployment', {
        userAuth,
        context: requestContext(req),
      });
      if (status < 200 || status >= 300 || !data || typeof data !== 'object') {
        log.error(`gateway /api/config: org resolver returned ${status}`);
        return res.status(503).json({ error: 'Organization deployment context is temporarily unavailable.' });
      }
      const deploymentStatus = typeof data.status === 'string' ? data.status : '';
      if (!['shared', 'provisioning', 'failed', 'provisioned'].includes(deploymentStatus)
          || (deploymentStatus === 'provisioned' && !data.gateway_url)) {
        log.error('gateway /api/config: org resolver returned an invalid deployment record');
        return res.status(503).json({ error: 'Organization deployment context is temporarily unavailable.' });
      }
      // Only a PROVISIONED per-tenant stack re-points the browser's base; every
      // other state (shared/provisioning/failed) keeps the SPA on this gateway.
      const provisioned = deploymentStatus === 'provisioned';
      return res.json({
        authenticated: true,
        status: deploymentStatus,
        gatewayUrl: provisioned ? String(data.gateway_url) : '',
        orgName: data.org_name || null,
      });
    } catch (err) {
      log.error(`gateway /api/config failed: ${err && err.message ? err.message : err}`);
      return res.status(503).json({ error: 'Organization deployment context is temporarily unavailable.' });
    }
  };
}

module.exports = { createConfigResolver };
