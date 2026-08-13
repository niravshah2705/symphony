'use strict';

/**
 * Codex browser credential management was removed from the gateway. Keep
 * explicit tombstones so old clients receive a terminal response instead of
 * authentication, proxy, or SPA fallback behavior that could make an endpoint
 * appear alive. Token import/deletion is operator-only and never browser-proxied.
 */
const REMOVED_CODEX_ROUTE_TOMBSTONES = Object.freeze([
  Object.freeze({ method: 'get', path: '/api/settings/codex/login' }),
  Object.freeze({ method: 'get', path: '/api/settings/codex/_pending' }),
  Object.freeze({ method: 'get', path: '/auth/callback' }),
  Object.freeze({ method: 'delete', path: '/api/settings/codex' }),
]);

function gone(req, res) {
  return res
    .status(410)
    .set('Cache-Control', 'no-store')
    .json({
      error: 'Codex browser credential management has been removed.',
      code: 'endpoint_gone',
    });
}

function mountRemovedAgentRouteTombstones(app) {
  for (const { method, path } of REMOVED_CODEX_ROUTE_TOMBSTONES) app[method](path, gone);
  return app;
}

module.exports = { REMOVED_CODEX_ROUTE_TOMBSTONES, gone, mountRemovedAgentRouteTombstones };
