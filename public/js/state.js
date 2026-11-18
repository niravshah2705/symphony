// Minimal shared app state persisted to localStorage where useful.

const KEY_PROJECT = 'lm.currentProjectId';
const KEY_PROJECT_NAME = 'lm.currentProjectName';
const KEY_PROJECT_BY_ORG = 'lm.projectByOrganization';
const KEY_WORKSPACE_ROUTE = 'lm.lastWorkspaceRoute';
const KEY_SIDEBAR_COLLAPSED = 'lm.sidebarCollapsed';

export const IMMERSIVE_ROUTES = Object.freeze(['agent', 'calls', 'workflows']);

function read(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch (_) {
    // Storage can be unavailable in private browser contexts; in-memory state still works.
    return '';
  }
}

function write(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (_) {
    // Same: the in-memory value on `state` is what the session runs on.
  }
}

// The project a user last worked in belongs to an organization, so it is stored
// per organization. Under a single flat key, switching tenants restored the
// previous organization's project id into the new one — and `state.currentProjectId`
// is what the agent view puts on the wire (views/agent.js), so a tenant switch
// would address a project the caller has no context in.
//
// The pre-existing flat key is still honored as the fallback for an organization
// with no stored choice, so the upgrade does not silently reset where a user was
// working; the first explicit choice replaces it with a scoped record.
function scopedSelection(organizationId) {
  const scope = String(organizationId || '');
  let byOrg = {};
  try {
    byOrg = JSON.parse(read(KEY_PROJECT_BY_ORG) || '{}') || {};
  } catch (_) {
    byOrg = {};
  }
  const stored = byOrg[scope];
  if (stored && typeof stored === 'object') {
    return { id: String(stored.id || ''), name: String(stored.name || '') };
  }
  if (stored) return { id: String(stored), name: '' };
  return scope ? { id: '', name: '' } : { id: read(KEY_PROJECT), name: read(KEY_PROJECT_NAME) };
}

let scopeApplied = false;

// Before any organization resolves, the device is the only scope there is, so the
// flat legacy keys answer — the unscoped profile (local development, auth not
// configured) has no `setOrganizationScope` call to wait for.
const unscoped = scopedSelection('');

export const state = {
  hasKey: false,
  planningConfigured: false,
  planningProvider: 'linear',
  // Whether the configured planning key actually works (validated against the
  // provider). A present-but-rejected key is hasKey:true + connectionValid:false,
  // which the connection-dependent routes treat like "not connected" and guide
  // the user to Settings instead of firing calls that would 401.
  connectionValid: true,
  // The organization the persisted project choice belongs to. Empty until the
  // workspace context resolves; `setOrganizationScope` is what loads the choice.
  organizationId: '',
  currentProjectId: unscoped.id,
  currentProjectName: unscoped.name,
  activeRoute: '',
  sidebarOpen: false,
  sidebarCollapsed: read(KEY_SIDEBAR_COLLAPSED) === 'true',
  lastWorkspaceRoute: read(KEY_WORKSPACE_ROUTE) || 'agent',
};

/** Point the persisted project choice at one organization, loading that
 * organization's own last choice. Called from the workspace-context selection,
 * never from a view: a view cannot know whether the id it holds is the active
 * organization's. */
export function setOrganizationScope(organizationId) {
  const scope = String(organizationId || '');
  // Re-applying the same scope must not clobber a choice the session already made
  // in memory (a view can pick a project before the next context refresh lands).
  if (scopeApplied && scope === state.organizationId) return state.currentProjectId;
  scopeApplied = true;
  state.organizationId = scope;
  const selection = scopedSelection(scope);
  state.currentProjectId = selection.id;
  state.currentProjectName = selection.name;
  return state.currentProjectId;
}

/** Forget the scope *and* the in-memory choice, without erasing what this
 * organization has stored: sign-out must not leave the next user of this browser
 * pointed at the previous one's project. */
export function clearOrganizationScope() {
  scopeApplied = false;
  state.organizationId = '';
  state.currentProjectId = '';
  state.currentProjectName = '';
}

export function setCurrentProject(projectId, projectName = '') {
  state.currentProjectId = projectId || '';
  if (projectName) state.currentProjectName = projectName;
  const scope = state.organizationId;
  let byOrg = {};
  try {
    byOrg = JSON.parse(read(KEY_PROJECT_BY_ORG) || '{}') || {};
  } catch (_) {
    byOrg = {};
  }
  byOrg[scope] = { id: state.currentProjectId, name: state.currentProjectName };
  write(KEY_PROJECT_BY_ORG, JSON.stringify(byOrg));
  if (!scope) {
    // The unscoped profile (no organization resolved) is the one the flat key was
    // written for; keep it in step so a downgrade or a fresh scope still reads it.
    write(KEY_PROJECT, state.currentProjectId);
    if (projectName) write(KEY_PROJECT_NAME, state.currentProjectName);
  }
}

export function isImmersiveRoute(route) {
  return IMMERSIVE_ROUTES.includes(route);
}

export function setActiveRoute(route) {
  state.activeRoute = route;
  if (!isImmersiveRoute(route)) return;

  state.lastWorkspaceRoute = route;
  try {
    localStorage.setItem(KEY_WORKSPACE_ROUTE, route);
  } catch (_) {
    // Storage can be unavailable in private browser contexts; in-memory state still works.
  }
}

export function setSidebarOpen(open) {
  state.sidebarOpen = Boolean(open);
}

export function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = Boolean(collapsed);
  try {
    localStorage.setItem(KEY_SIDEBAR_COLLAPSED, String(state.sidebarCollapsed));
  } catch (_) {
    // In-memory state still provides a usable collapse control.
  }
}
