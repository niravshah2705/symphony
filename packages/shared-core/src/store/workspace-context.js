'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');

const MAX_CONTEXT_ID_CHARS = 160;
const CONTEXT_ID_RE = /^[A-Za-z0-9._:-]+$/;
const EMPTY_WORKSPACE_CONTEXT = Object.freeze({ organizationId: '', projectId: '' });
const workspaceStorage = new AsyncLocalStorage();

class WorkspaceContextError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'WorkspaceContextError';
    this.code = code;
    this.status = status;
  }
}

class WorkspaceOrganizationMismatchError extends WorkspaceContextError {
  constructor() {
    super(
      'Selected organization does not match this deployment.',
      'workspace_organization_mismatch',
      403,
    );
    this.name = 'WorkspaceOrganizationMismatchError';
  }
}

function cleanContextId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  if (!id || id.length > MAX_CONTEXT_ID_CHARS || !CONTEXT_ID_RE.test(id)) return '';
  return id;
}

function firstId(source, keys) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return '';
  for (const key of keys) {
    const value = cleanContextId(source[key]);
    if (value) return value;
  }
  return '';
}

function assertValidInputIds(source, keys, kind) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const raw = source[key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string' || (raw.trim() && !cleanContextId(raw))) {
      throw new WorkspaceContextError(
        `Invalid ${kind} workspace context.`,
        `invalid_workspace_${kind}_context`,
      );
    }
  }
}

/**
 * Normalize the trusted workspace shape used across HTTP, Pub/Sub, and jobs.
 * Aliases are accepted only at this boundary; consumers receive the canonical
 * organizationId/projectId pair. A project without an organization is ignored
 * because it can never identify a tenant by itself.
 */
function normalizeWorkspaceContext(context = {}) {
  const organizationId = firstId(context, [
    'organizationId', 'orgId', 'organization_id', 'org_id',
  ]);
  const projectId = organizationId
    ? firstId(context, [
        'projectId', 'nativeProjectId', 'project_id', 'native_project_id',
      ])
    : '';
  if (!organizationId && !projectId) return EMPTY_WORKSPACE_CONTEXT;
  return Object.freeze({ organizationId, projectId });
}

/** The organization identity pin carried by a dedicated deployment, if any. */
function pinnedWorkspaceOrganizationId(env = process.env) {
  const raw = env.FLEET_ORG_ID || env.AIFLEET_ORG_ID || env.PROXY_ORG_ID || '';
  const pinned = cleanContextId(raw);
  if (String(raw).trim() && !pinned) {
    throw new WorkspaceContextError(
      'The deployment organization pin is invalid.',
      'invalid_workspace_organization_pin',
      500,
    );
  }
  return pinned;
}

function assertCompatibleWithPinnedOrganization(context, pinnedOrganizationId) {
  const normalized = normalizeWorkspaceContext(context);
  const pinned = cleanContextId(
    pinnedOrganizationId === undefined
      ? pinnedWorkspaceOrganizationId()
      : pinnedOrganizationId,
  );
  if (pinned && normalized.organizationId && pinned !== normalized.organizationId) {
    throw new WorkspaceOrganizationMismatchError();
  }
  return normalized;
}

/**
 * Run fn with an immutable request/job-local workspace selection. Async local
 * storage keeps concurrent organization A/B work independent without a mutable
 * process-global "current tenant" variable.
 */
function runWithWorkspaceContext(context, fn) {
  if (typeof fn !== 'function') throw new TypeError('runWithWorkspaceContext requires a function');
  const organizationKeys = ['organizationId', 'orgId', 'organization_id', 'org_id'];
  const projectKeys = ['projectId', 'nativeProjectId', 'project_id', 'native_project_id'];
  assertValidInputIds(context, organizationKeys, 'organization');
  assertValidInputIds(context, projectKeys, 'project');
  const normalized = assertCompatibleWithPinnedOrganization(context);
  const suppliedProjectId = firstId(context, projectKeys);
  if (suppliedProjectId && !normalized.organizationId) {
    throw new WorkspaceContextError(
      'A project workspace context requires an organization.',
      'workspace_organization_required',
    );
  }
  return workspaceStorage.run(normalized, fn);
}

function currentWorkspaceContext() {
  return workspaceStorage.getStore() || EMPTY_WORKSPACE_CONTEXT;
}

function stableIdDigest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function organizationIdFrom(value) {
  if (typeof value === 'string') return cleanContextId(value);
  return normalizeWorkspaceContext(value).organizationId;
}

/** Stable, path-safe, non-reversible key for an organization-scoped resource. */
function workspaceOrganizationKey(value) {
  const organizationId = organizationIdFrom(value);
  return organizationId ? `org_${stableIdDigest(organizationId)}` : 'legacy';
}

/**
 * Stable cache key for a native project. It includes the organization digest,
 * so equal project ids in different organizations can never alias.
 */
function workspaceProjectKey(context, projectIdOverride) {
  const normalized = typeof context === 'string'
    ? normalizeWorkspaceContext({ organizationId: context, projectId: projectIdOverride })
    : normalizeWorkspaceContext(context);
  if (!normalized.organizationId) return 'legacy';
  const organizationKey = workspaceOrganizationKey(normalized.organizationId);
  const projectId = cleanContextId(projectIdOverride) || normalized.projectId;
  return projectId
    ? `${organizationKey}:project_${stableIdDigest(projectId)}`
    : organizationKey;
}

/** Most-specific stable cache key for the supplied workspace selection. */
function workspaceCacheKey(context = currentWorkspaceContext()) {
  const normalized = normalizeWorkspaceContext(context);
  return normalized.projectId
    ? workspaceProjectKey(normalized)
    : workspaceOrganizationKey(normalized);
}

function isWorkspaceOrganizationMismatch(error) {
  return Boolean(error && error.code === 'workspace_organization_mismatch');
}

module.exports = {
  MAX_CONTEXT_ID_CHARS,
  normalizeWorkspaceContext,
  runWithWorkspaceContext,
  currentWorkspaceContext,
  workspaceOrganizationKey,
  workspaceProjectKey,
  workspaceCacheKey,
  pinnedWorkspaceOrganizationId,
  assertCompatibleWithPinnedOrganization,
  isWorkspaceOrganizationMismatch,
  WorkspaceContextError,
  WorkspaceOrganizationMismatchError,
};
