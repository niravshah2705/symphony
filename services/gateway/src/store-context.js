'use strict';

const store = require('@ai-fleet/shared-core/store');
const {
  normalizeWorkspaceContext,
  runWithWorkspaceContext,
} = require('@ai-fleet/shared-core/store/workspace-context');

/**
 * Enter the store scope selected by the gateway's authoritative context check.
 *
 * Deliberately read only `req.fleetContext`: request headers are still
 * attacker-controlled at this boundary and must never select a backend on their
 * own. Requests intentionally skipped by context validation (and auth-disabled
 * local development) retain the legacy empty workspace.
 */
function trustedRequestContext(req) {
  const validated = req && req.fleetContext;
  return normalizeWorkspaceContext(
    validated && typeof validated === 'object' ? validated : {},
  );
}

function trustedContextInput(req) {
  const validated = req && req.fleetContext;
  if (!validated || typeof validated !== 'object' || Array.isArray(validated)) return {};
  return {
    organizationId: validated.organizationId,
    projectId: validated.projectId,
  };
}

function createStoreContextMiddleware({ initStore = store.initStore } = {}) {
  return function bindValidatedStoreContext(req, res, next) {
    try {
      return Promise.resolve(runWithWorkspaceContext(trustedContextInput(req), async () => {
        await initStore();
        return next();
      })).catch(next);
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { createStoreContextMiddleware, trustedRequestContext, trustedContextInput };
