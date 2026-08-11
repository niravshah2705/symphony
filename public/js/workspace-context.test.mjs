import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_STORAGE_KEY,
  normalizeWorkspaceContext,
  persistUserContextPreference,
  readUserContextPreference,
  resolveWorkspaceSelection,
  selectWorkspaceOrganization,
} from './workspace-context.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

const context = normalizeWorkspaceContext({
  user: { id: 'user-1', email: 'ada@example.com', full_name: 'Ada Operator' },
  organizations: [
    { id: 'org-a', name: 'Alpha', role: 'ORG_ADMIN', projects: [
      { id: 'project-a1', name: 'Atlas', role: 'PROJECT_ADMIN' },
      { id: 'project-a2', name: 'Apollo', role: 'DEVELOPER' },
    ] },
    { org_id: 'org-b', org_name: 'Beta', projects: [
      { project_id: 'project-b1', project_name: 'Beacon' },
    ] },
  ],
});

test('normalizes the context contract and tolerated snake-case identifiers', () => {
  assert.deepEqual(context.user, { id: 'user-1', email: 'ada@example.com', fullName: 'Ada Operator' });
  assert.equal(context.organizations[1].id, 'org-b');
  assert.equal(context.organizations[1].name, 'Beta');
  assert.equal(context.organizations[1].projects[0].id, 'project-b1');
});

test('stale choices fall back to the first accessible organization and project', () => {
  const selection = resolveWorkspaceSelection(context, {
    organizationId: 'deleted-org',
    projectIdsByOrganization: { 'org-a': 'deleted-project' },
  });
  assert.equal(selection.organizationId, 'org-a');
  assert.equal(selection.projectId, 'project-a1');
  assert.equal(selection.projectIdsByOrganization['org-a'], 'project-a1');
});

test('organization switching restores the last accessible project for each organization', () => {
  const initial = resolveWorkspaceSelection(context, {
    organizationId: 'org-a',
    projectIdsByOrganization: { 'org-a': 'project-a2', 'org-b': 'project-b1' },
  });
  const beta = selectWorkspaceOrganization(context, initial, 'org-b');
  const alpha = selectWorkspaceOrganization(context, beta, 'org-a');
  assert.equal(beta.projectId, 'project-b1');
  assert.equal(alpha.projectId, 'project-a2');
});

test('persists the versioned preference independently for each signed-in user', () => {
  const storage = memoryStorage();
  persistUserContextPreference(storage, 'user-1', {
    organizationId: 'org-a',
    projectIdsByOrganization: { 'org-a': 'project-a2' },
  });
  persistUserContextPreference(storage, 'user-2', {
    organizationId: 'org-b',
    projectIdsByOrganization: { 'org-b': 'project-b1' },
  });

  assert.deepEqual(readUserContextPreference(storage, 'user-1'), {
    organizationId: 'org-a',
    projectIdsByOrganization: { 'org-a': 'project-a2' },
  });
  assert.deepEqual(readUserContextPreference(storage, 'user-2'), {
    organizationId: 'org-b',
    projectIdsByOrganization: { 'org-b': 'project-b1' },
  });
  assert.deepEqual(JSON.parse(storage.getItem(CONTEXT_STORAGE_KEY)), {
    version: 1,
    users: {
      'user-1': { organizationId: 'org-a', projectIdsByOrganization: { 'org-a': 'project-a2' } },
      'user-2': { organizationId: 'org-b', projectIdsByOrganization: { 'org-b': 'project-b1' } },
    },
  });
});
