// Minimal shared app state persisted to localStorage where useful.

const KEY_PROJECT = 'lm.currentProjectId';
const KEY_WORKSPACE_ROUTE = 'lm.lastWorkspaceRoute';

export const IMMERSIVE_ROUTES = Object.freeze(['agent', 'calls', 'traces']);

export const state = {
  hasKey: false,
  planningConfigured: false,
  planningProvider: 'linear',
  currentProjectId: localStorage.getItem(KEY_PROJECT) || '',
  activeRoute: '',
  sidebarOpen: false,
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
