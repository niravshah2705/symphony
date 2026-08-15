'use strict';

/** Browser-selected native AI Fleet scope. These names are part of the public API. */
const ORGANIZATION_HEADER = 'x-ai-fleet-organization-id';
const PROJECT_HEADER = 'x-ai-fleet-project-id';
// Per-request LLM gateway feature flag (browser opt-in). Unlike the tenant ids
// above it is not identity — just an allowlisted selector — so it is parsed
// directly from the header on both the validated and raw context branches.
const LLM_GATEWAY_HEADER = 'x-ai-fleet-llm-gateway';
const LLM_GATEWAY_MODES = new Set(['langsmith']);
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

/** Normalize the llm-gateway selector; anything off the allowlist is dropped. */
function cleanLlmGateway(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LLM_GATEWAY_MODES.has(mode) ? mode : '';
}

/**
 * Availability gate for the per-request llm-gateway flag: a deployment without
 * the gateway configured drops the header at ingestion, so no task record ever
 * carries a dead flag. Lazy require keeps this module import-light for tests.
 */
function llmGatewayAvailable() {
  return require('@ai-fleet/shared-core/config').CONFIG.LLM_GATEWAY.enabled;
}

function requestContext(req, { llmGatewayEnabled = llmGatewayAvailable() } = {}) {
  const llmGateway = llmGatewayEnabled ? cleanLlmGateway(header(req, LLM_GATEWAY_HEADER)) : '';
  const validated = req && req.fleetContext;
  if (validated && typeof validated === 'object') {
    return Object.freeze({
      organizationId: cleanContextId(validated.organizationId),
      projectId: cleanContextId(validated.projectId),
      llmGateway,
    });
  }
  return Object.freeze({
    organizationId: cleanContextId(header(req, ORGANIZATION_HEADER)),
    projectId: cleanContextId(header(req, PROJECT_HEADER)),
    llmGateway,
  });
}

function contextHeaders(context) {
  const source = context || {};
  const organizationId = cleanContextId(source.organizationId);
  const projectId = cleanContextId(source.projectId);
  const llmGateway = cleanLlmGateway(source.llmGateway);
  return {
    ...(organizationId ? { [ORGANIZATION_HEADER]: organizationId } : {}),
    ...(projectId ? { [PROJECT_HEADER]: projectId } : {}),
    ...(llmGateway ? { [LLM_GATEWAY_HEADER]: llmGateway } : {}),
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
  LLM_GATEWAY_HEADER,
  MAX_CONTEXT_ID_CHARS,
  cleanContextId,
  cleanLlmGateway,
  requestContext,
  contextHeaders,
  forwardRequestContext,
  enforcePinnedOrganization,
  requireOrganizationContext,
};
