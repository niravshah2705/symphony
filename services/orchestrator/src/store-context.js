'use strict';

const store = require('@ai-fleet/shared/store');
const {
  normalizeWorkspaceContext,
  runWithWorkspaceContext,
} = require('@ai-fleet/shared/store/workspace-context');

const ORGANIZATION_HEADER = 'x-ai-fleet-organization-id';
const PROJECT_HEADER = 'x-ai-fleet-project-id';

function requestHeader(req, name) {
  if (req && typeof req.get === 'function') return req.get(name) || '';
  return req && req.headers ? req.headers[name] || '' : '';
}

/** Headers on this internal-only service were forwarded by the gateway. */
function forwardedRequestContext(req) {
  return normalizeWorkspaceContext(forwardedContextInput(req));
}

function forwardedContextInput(req) {
  return {
    organizationId: requestHeader(req, ORGANIZATION_HEADER),
    projectId: requestHeader(req, PROJECT_HEADER),
  };
}

function createStoreContextMiddleware({ initStore = store.initStore } = {}) {
  return function bindForwardedStoreContext(req, res, next) {
    try {
      const input = forwardedContextInput(req);
      const context = normalizeWorkspaceContext(input);
      // Downstream domain routers use req.fleetContext for record filtering;
      // only the gateway-derived internal headers are authoritative here.
      req.fleetContext = context;
      return Promise.resolve(runWithWorkspaceContext(input, async () => {
        await initStore();
        return next();
      })).catch(next);
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { createStoreContextMiddleware, forwardedRequestContext, forwardedContextInput };
