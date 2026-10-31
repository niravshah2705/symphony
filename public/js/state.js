// Minimal shared app state persisted to localStorage where useful.

const KEY_PROJECT = 'lm.currentProjectId';
const KEY_PROJECT_NAME = 'lm.currentProjectName';
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
  currentProjectName: localStorage.getItem(KEY_PROJECT_NAME) || '',
  activeRoute: '',
  sidebarOpen: false,
  sidebarCollapsed: localStorage.getItem(KEY_SIDEBAR_COLLAPSED) === 'true',
  lastWorkspaceRoute: localStorage.getItem(KEY_WORKSPACE_ROUTE) || 'agent',
  sandbox: null,
  sandboxesByProject: {},
  sandboxLoading: false,
};

export function setProjectSandbox(projectId, sandbox) {
  if (sandbox && typeof sandbox === 'object') {
    state.sandbox = sandbox;
    const key = projectId || sandbox.projectId || 'default';
    state.sandboxesByProject[key] = sandbox;
    if (sandbox.projectName) {
      state.currentProjectName = sandbox.projectName;
      try { localStorage.setItem(KEY_PROJECT_NAME, sandbox.projectName); } catch (_) { /* ignore */ }
    }
    try {
      window.dispatchEvent(new CustomEvent('lm:sandbox-updated', { detail: { projectId: key, sandbox } }));
    } catch (_) {
      // Non-browser test environments may not support CustomEvent.
    }
  }
}

export function setCurrentProject(projectId, projectName = '') {
  state.currentProjectId = projectId || '';
  if (projectName) state.currentProjectName = projectName;
  try {
    if (projectId) localStorage.setItem(KEY_PROJECT, projectId);
    else localStorage.removeItem(KEY_PROJECT);
    if (projectName) localStorage.setItem(KEY_PROJECT_NAME, projectName);
  } catch (_) {
    // Storage can be unavailable in private browser contexts.
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
