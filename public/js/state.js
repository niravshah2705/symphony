// Minimal shared app state persisted to localStorage where useful.

const KEY_PROJECT = 'lm.currentProjectId';

export const state = {
  hasKey: false,
  currentProjectId: localStorage.getItem(KEY_PROJECT) || '',
};

export function setCurrentProject(projectId) {
  state.currentProjectId = projectId || '';
  if (projectId) localStorage.setItem(KEY_PROJECT, projectId);
  else localStorage.removeItem(KEY_PROJECT);
}
