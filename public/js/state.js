// Minimal shared app state persisted to localStorage where useful.

const KEY_PROJECT = 'lm.currentProjectId';
const KEY_WORKSPACE_ROUTE = 'lm.lastWorkspaceRoute';
const KEY_SIDEBAR_COLLAPSED = 'lm.sidebarCollapsed';

export const IMMERSIVE_ROUTES = Object.freeze(['agent', 'calls', 'workflows']);

export const state = {
  hasKey: false,
  planningConfigured: false,
  planningProvider: 'linear',
  // Whether the configured planning key actually works (validated against the
  // provider). A present-but-rejected key is hasKey:true + connectionValid:false,
  // which the connection-dependent routes treat like "not connected" and guide
  // the user to Settings instead of firing calls that would 401.
  connectionValid: true,
  currentProjectId: localStorage.getItem(KEY_PROJECT) || '',
  activeRoute: '',
  sidebarOpen: false,
  sidebarCollapsed: localStorage.getItem(KEY_SIDEBAR_COLLAPSED) === 'true',
  lastWorkspaceRoute: localStorage.getItem(KEY_WORKSPACE_ROUTE) || 'agent',
};

export function setCurrentProject(projectId) {
  state.currentProjectId = projectId || '';
  if (projectId) localStorage.setItem(KEY_PROJECT, projectId);
  else localStorage.removeItem(KEY_PROJECT);
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
