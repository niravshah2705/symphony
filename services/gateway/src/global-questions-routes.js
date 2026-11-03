'use strict';

/**
 * Gateway mount table for the global discovery-question bank.
 *
 * These paths are registered BEFORE the general /api/agent catch-all so their
 * gates win, and the catch-all's `workspace:write` cannot be used to reach them.
 * Two consequences worth keeping straight when editing:
 *
 *  - `/coverage` reads tenant memories, so it needs `requireAuthenticated()`
 *    explicitly: `workspace:read` alone also passes an anonymous visitor (see
 *    PUBLIC_PERMISSIONS), which would leak another tenant's memory fragments.
 *  - `/coverage` and `/ai-assist` do model work (embeddings, recall, the local
 *    model), so they are EULA-gated; plain bank reads and edits are not.
 *
 * `updatedBy` comes from the verified session header injected here. The proxy
 * builds its headers from scratch, so a browser cannot spoof it.
 */

const { CONFIG } = require('@ai-fleet/shared-core/config');
const { requireAuthenticated, requirePermission } = require('./auth');
const { requireOrganizationContext } = require('./request-context');
const { requireEulaAccepted } = require('./eula');
const { createProxy } = require('./proxy');

const BASE_PATH = '/api/agent/global-questions';

function callerIdentity(req) {
  const user = req.auth && req.auth.user;
  return { 'x-ai-fleet-user-id': user ? String(user.sub || user.email || '') : '' };
}

function mountGlobalQuestionsRoutes(app, options = {}) {
  const proxy = options.proxy
    || createProxy(options.plannerUrl || CONFIG.SERVICES.plannerUrl, { injectHeaders: callerIdentity });
  const gates = {
    requireAuthenticated,
    requirePermission,
    requireOrganizationContext,
    requireEulaAccepted,
    ...(options.gates || {}),
  };

  // Reads the assessment: any signed-in member of the org may see it, and a
  // viewer must not be able to trigger the write-shaped refresh.
  app.post(`${BASE_PATH}/coverage`,
    gates.requireAuthenticated(),
    gates.requirePermission('workspace', { level: 'read' }),
    gates.requireOrganizationContext(),
    gates.requireEulaAccepted(),
    proxy);

  // Drafts bank edits with the local model — settings write, preview only.
  app.post(`${BASE_PATH}/ai-assist`,
    gates.requireAuthenticated(),
    gates.requirePermission('settings', { level: 'write' }),
    gates.requireOrganizationContext(),
    gates.requireEulaAccepted(),
    proxy);

  // The bank itself: GET → settings:read, PUT/POST/DELETE → settings:write.
  app.use(BASE_PATH,
    gates.requireAuthenticated(),
    gates.requirePermission('settings'),
    gates.requireOrganizationContext(),
    proxy);

  return app;
}

module.exports = { mountGlobalQuestionsRoutes, callerIdentity, BASE_PATH };
