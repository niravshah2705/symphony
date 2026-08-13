'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');
const log = require('@ai-fleet/shared-core/logger');
const { callJson: defaultCallJson } = require('./service-client');
const { requestContext, cleanContextId } = require('./request-context');

function items(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function itemId(item, primary, legacy) {
  return cleanContextId(String((item && (item[primary] || item[legacy])) || ''));
}

/** Re-check a selected pair against the org service's authoritative access list. */
function normalizeValidatedContext(data, requested = {}) {
  if (!data || typeof data !== 'object') throw Object.assign(new Error('Invalid organization context response.'), { status: 503 });
  const organizations = items(data.organizations || data.orgs);
  const requestedOrg = cleanContextId(requested.organizationId);
  const requestedProject = cleanContextId(requested.projectId);
  if (requestedProject && !requestedOrg) {
    throw Object.assign(new Error('A project context requires an organization context.'), { status: 400 });
  }

  const hintedOrg = cleanContextId(data.selected_organization_id || data.default_organization_id || data.org_id);
  const wantedOrg = requestedOrg || hintedOrg;
  if (!requestedOrg && organizations.length > 1) {
    throw Object.assign(new Error('An explicit organization selection is required.'), { status: 400 });
  }
  let organization = organizations.find((org) => itemId(org, 'id', 'org_id') === wantedOrg) || null;
  if (!organization && !wantedOrg) organization = organizations[0] || null;
  if (wantedOrg && !organization) {
    throw Object.assign(new Error('Selected organization is not accessible.'), { status: 403 });
  }
  if (!organization) return Object.freeze({ organizationId: '', projectId: '' });

  const organizationId = itemId(organization, 'id', 'org_id');
  const projects = items(organization.projects);
  const hintedProject = cleanContextId(
    data.selected_project_id || data.default_project_id
      || organization.selected_project_id || organization.default_project_id
  );
  const wantedProject = requestedProject || hintedProject;
  if (!requestedProject && projects.length > 1) {
    throw Object.assign(new Error('An explicit project selection is required.'), { status: 400 });
  }
  let project = projects.find((entry) => itemId(entry, 'id', 'project_id') === wantedProject) || null;
  if (!project && !wantedProject) project = projects[0] || null;
  if (wantedProject && !project) {
    throw Object.assign(new Error('Selected project is not accessible in this organization.'), { status: 404 });
  }
  return Object.freeze({
    organizationId,
    projectId: project ? itemId(project, 'id', 'project_id') : '',
  });
}

function shouldSkip(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return path === '/api/auth/me'
    // Location/language suggestions are advisory and store-free. Translation,
    // however, resolves model settings and must follow the selected workspace.
    || path === '/api/locale/suggestions'
    || path === '/api/org/me/context';
}

/**
 * Resolve context before gateway-owned/proxied application routes. The org
 * service remains the membership source; downstream calls receive only the
 * validated/fallback pair via requestContext(req).
 */
function createContextValidationMiddleware({
  callJson = defaultCallJson,
  orgUrl = CONFIG.SERVICES.orgUrl,
  pinnedOrganizationId = CONFIG.BILLING.orgId,
} = {}) {
  return async function validateContext(req, res, next) {
    if (shouldSkip(req)) return next();
    if (!req.auth || !req.auth.authenticated) {
      // Never forward a public caller's unvalidated tenant-shaped headers.
      req.fleetContext = Object.freeze({ organizationId: '', projectId: '' });
      return next();
    }
    if (req.auth.mode === 'disabled') return next();
    if (!orgUrl) return res.status(503).json({ error: 'Organization context service is not configured.', code: 'context_unavailable' });

    const requested = requestContext(req);
    const authorization = req.get ? req.get('authorization') : '';
    try {
      const { status, data } = await callJson(orgUrl, '/api/v1/me/context', {
        userAuth: authorization,
        context: requested,
      });
      if (status === 401) return res.status(401).json({ error: 'Authentication required.', code: 'authentication_required' });
      if (status < 200 || status >= 300) {
        const safeStatus = [400, 403, 404].includes(status) ? status : 503;
        return res.status(safeStatus).json({
          error: safeStatus === 503 ? 'Organization context is temporarily unavailable.' : 'Selected organization/project context is not accessible.',
          code: safeStatus === 503 ? 'context_unavailable' : 'invalid_context',
        });
      }
      const validated = normalizeValidatedContext(data, requested);
      const pinned = cleanContextId(pinnedOrganizationId);
      // A dedicated gateway is a tenant boundary. Empty context is not a valid
      // substitute for membership: an org-less/removed user must not fall
      // through to this process's pinned STORE_NAMESPACE.
      if (pinned && pinned !== validated.organizationId) {
        return res.status(404).json({ error: 'Organization context not found.', code: 'context_not_found' });
      }
      req.fleetContext = validated;
      return next();
    } catch (err) {
      const status = [400, 403, 404].includes(err && err.status) ? err.status : 503;
      if (status === 503) log.error(`gateway context validation failed: ${err && err.message ? err.message : err}`);
      return res.status(status).json({
        error: status === 503 ? 'Organization context is temporarily unavailable.' : err.message,
        code: status === 503 ? 'context_unavailable' : 'invalid_context',
      });
    }
  };
}

module.exports = { createContextValidationMiddleware, normalizeValidatedContext, shouldSkip };
