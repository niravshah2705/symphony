import { api, setRequestContext } from './api.js';
import {
  normalizeWorkspaceContext,
  persistUserContextPreference,
  readUserContextPreference,
  resolveWorkspaceSelection,
  selectWorkspaceOrganization,
  selectWorkspaceProject,
} from './workspace-context.mjs';

let snapshot = Object.freeze({
  status: 'idle',
  user: null,
  organizations: [],
  organizationId: null,
  projectId: null,
  projectIdsByOrganization: {},
  error: '',
});

function storage() {
  try {
    return window.localStorage;
  } catch (_) {
    return null;
  }
}

function applySelection(context, selection, { persist = true } = {}) {
  snapshot = Object.freeze({
    ...snapshot,
    status: 'ready',
    user: context.user,
    organizations: context.organizations,
    organizationId: selection.organizationId,
    projectId: selection.projectId,
    projectIdsByOrganization: { ...selection.projectIdsByOrganization },
    error: '',
  });
  setRequestContext({
    organizationId: snapshot.organizationId,
    projectId: snapshot.projectId,
  });
  if (persist && snapshot.user?.id) {
    persistUserContextPreference(storage(), snapshot.user.id, snapshot);
  }
  return snapshot;
}

/** Load and validate the device-local selection against accessible server context. */
export async function initializeWorkspaceContext(fallbackUser = {}) {
  setRequestContext(null);
  let payload;
  try {
    payload = await api.org.getContext();
  } catch (error) {
    snapshot = Object.freeze({
      ...snapshot,
      status: 'error',
      user: normalizeWorkspaceContext({}, fallbackUser).user,
      organizations: [],
      organizationId: null,
      projectId: null,
      projectIdsByOrganization: {},
      error: error?.message || 'Workspace context is unavailable.',
    });
    return snapshot;
  }

  const context = normalizeWorkspaceContext(payload, fallbackUser);
  const preference = readUserContextPreference(storage(), context.user.id);
  const selection = resolveWorkspaceSelection(context, preference);
  return applySelection(context, selection);
}

export function getWorkspaceContext() {
  return snapshot;
}

export function activeWorkspaceOrganization(value = snapshot) {
  return value.organizations.find((organization) => organization.id === value.organizationId) || null;
}

export function activeWorkspaceProject(value = snapshot) {
  const organization = activeWorkspaceOrganization(value);
  return organization?.projects.find((project) => project.id === value.projectId) || null;
}

function selectionChanged(next) {
  return next.organizationId !== snapshot.organizationId || next.projectId !== snapshot.projectId;
}

export function changeWorkspaceOrganization(organizationId) {
  const context = { user: snapshot.user, organizations: snapshot.organizations };
  const next = selectWorkspaceOrganization(context, snapshot, organizationId);
  if (!selectionChanged(next)) return false;
  applySelection(context, next);
  return true;
}

export function changeWorkspaceProject(projectId) {
  const context = { user: snapshot.user, organizations: snapshot.organizations };
  const next = selectWorkspaceProject(context, snapshot, projectId);
  if (!selectionChanged(next)) return false;
  applySelection(context, next);
  return true;
}

export function clearWorkspaceContext() {
  setRequestContext(null);
  snapshot = Object.freeze({
    status: 'idle',
    user: null,
    organizations: [],
    organizationId: null,
    projectId: null,
    projectIdsByOrganization: {},
    error: '',
  });
}
