'use strict';

/** Browser-selected native AI Fleet scope. These names are part of the public API. */
const ORGANIZATION_HEADER = 'x-ai-fleet-organization-id';
const PROJECT_HEADER = 'x-ai-fleet-project-id';
const MAX_CONTEXT_ID_CHARS = 160;

function cleanContextId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  if (!id || id.length > MAX_CONTEXT_ID_CHARS) return '';
  // Context ids are opaque, but never allow control characters or separators
  // that cannot occur in UUID/document ids and are unsafe in HTTP headers.
  return /^[A-Za-z0-9._:-]+$/.test(id) ? id : '';
}

function header(req, name) {
  if (req && typeof req.get === 'function') return req.get(name) || '';
  return req && req.headers ? req.headers[name] || '' : '';
}

function requestContext(req) {
  const validated = req && req.fleetContext;
  if (validated && typeof validated === 'object') {
    return Object.freeze({
      organizationId: cleanContextId(validated.organizationId),
      projectId: cleanContextId(validated.projectId),
    });
  }
  return Object.freeze({
    organizationId: cleanContextId(header(req, ORGANIZATION_HEADER)),
    projectId: cleanContextId(header(req, PROJECT_HEADER)),
  });
}

function contextHeaders(context) {
  const source = context || {};
  const organizationId = cleanContextId(source.organizationId);
  const projectId = cleanContextId(source.projectId);
  return {
    ...(organizationId ? { [ORGANIZATION_HEADER]: organizationId } : {}),
    ...(projectId ? { [PROJECT_HEADER]: projectId } : {}),
  };
}

function forwardRequestContext(req, headers) {
  Object.assign(headers, contextHeaders(requestContext(req)));
  return headers;
}

/** A dedicated tenant gateway must never act for a different selected org. */
function enforcePinnedOrganization(pinnedOrganizationId) {
  const pinned = cleanContextId(pinnedOrganizationId);
  return function pinnedOrganization(req, res, next) {
    const selected = requestContext(req).organizationId;
    if (pinned && selected && selected !== pinned) {
      return res.status(404).json({ error: 'Organization context not found.', code: 'context_not_found' });
    }
    return next();
  };
}

/** Operational tenant routes require an authoritative selected organization. */
function requireOrganizationContext() {
  return function selectedOrganization(req, res, next) {
    if (req && req.auth && req.auth.mode === 'disabled') return next();
    const selected = requestContext(req).organizationId;
    if (!selected) {
      return res.status(403).json({
        error: 'Select an organization before using this workspace.',
        code: 'organization_context_required',
      });
    }
    return next();
  };
}

module.exports = {
  ORGANIZATION_HEADER,
  PROJECT_HEADER,
  MAX_CONTEXT_ID_CHARS,
  cleanContextId,
  requestContext,
  contextHeaders,
  forwardRequestContext,
  enforcePinnedOrganization,
  requireOrganizationContext,
};
