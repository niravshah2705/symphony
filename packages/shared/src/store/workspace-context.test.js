'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeWorkspaceContext,
  runWithWorkspaceContext,
  currentWorkspaceContext,
  workspaceOrganizationKey,
  workspaceProjectKey,
  workspaceCacheKey,
  pinnedWorkspaceOrganizationId,
  isWorkspaceOrganizationMismatch,
} = require('./workspace-context');

test('normalizes supported aliases into one immutable workspace shape', () => {
  const context = normalizeWorkspaceContext({ orgId: ' org:a ', nativeProjectId: ' project:1 ' });
  assert.deepEqual(context, { organizationId: 'org:a', projectId: 'project:1' });
  assert.equal(Object.isFrozen(context), true);

  assert.deepEqual(
    normalizeWorkspaceContext({ organization_id: 'org:b', project_id: 'project:2' }),
    { organizationId: 'org:b', projectId: 'project:2' },
  );
  assert.deepEqual(
    normalizeWorkspaceContext({ organizationId: 'bad/path', projectId: 'project:2' }),
    { organizationId: '', projectId: '' },
  );
  assert.deepEqual(
    normalizeWorkspaceContext({ projectId: 'project-without-org' }),
    { organizationId: '', projectId: '' },
  );
});

test('AsyncLocalStorage keeps concurrent workspace contexts independent', async () => {
  const observed = [];
  await Promise.all([
    runWithWorkspaceContext({ organizationId: 'org-a', projectId: 'project-a' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      observed.push(currentWorkspaceContext());
    }),
    runWithWorkspaceContext({ organizationId: 'org-b', projectId: 'project-b' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      observed.push(currentWorkspaceContext());
    }),
  ]);

  assert.deepEqual(currentWorkspaceContext(), { organizationId: '', projectId: '' });
  assert.deepEqual(
    observed.map((value) => `${value.organizationId}/${value.projectId}`).sort(),
    ['org-a/project-a', 'org-b/project-b'],
  );
});

test('organization and project cache keys are deterministic, scoped, and path-safe', () => {
  const orgA = workspaceOrganizationKey('Customer / unsafe raw id');
  // Invalid ids never become physical keys.
  assert.equal(orgA, 'legacy');

  const first = workspaceOrganizationKey('org:a');
  assert.equal(first, workspaceOrganizationKey({ organizationId: 'org:a' }));
  assert.match(first, /^org_[a-f0-9]{64}$/);
  assert.equal(first.includes('org:a'), false);
  assert.notEqual(first, workspaceOrganizationKey('org:b'));

  const projectA = workspaceProjectKey({ organizationId: 'org:a', projectId: 'project:1' });
  const projectB = workspaceProjectKey({ organizationId: 'org:b', projectId: 'project:1' });
  assert.match(projectA, /^org_[a-f0-9]{64}:project_[a-f0-9]{64}$/);
  assert.notEqual(projectA, projectB);
  assert.equal(workspaceCacheKey({ organizationId: 'org:a', projectId: 'project:1' }), projectA);
  assert.equal(workspaceCacheKey({ organizationId: 'org:a' }), first);
  assert.equal(workspaceCacheKey({}), 'legacy');
});

test('dedicated deployment organization pins reject conflicting selections', () => {
  assert.equal(pinnedWorkspaceOrganizationId({ AIFLEET_ORG_ID: 'org:pinned' }), 'org:pinned');
  assert.equal(pinnedWorkspaceOrganizationId({ FLEET_ORG_ID: 'org:fleet', AIFLEET_ORG_ID: 'org:old' }), 'org:fleet');

  const previous = process.env.AIFLEET_ORG_ID;
  process.env.AIFLEET_ORG_ID = 'org:pinned';
  try {
    let ran = false;
    assert.throws(
      () => runWithWorkspaceContext({ organizationId: 'org:other' }, () => { ran = true; }),
      (error) => isWorkspaceOrganizationMismatch(error) && error.status === 403,
    );
    assert.equal(ran, false);
    assert.equal(
      runWithWorkspaceContext({ organizationId: 'org:pinned' }, () => currentWorkspaceContext().organizationId),
      'org:pinned',
    );
  } finally {
    if (previous === undefined) delete process.env.AIFLEET_ORG_ID;
    else process.env.AIFLEET_ORG_ID = previous;
  }
});

test('runner rejects malformed and project-only inputs instead of falling back to legacy', () => {
  assert.throws(
    () => runWithWorkspaceContext({ organizationId: '../org' }, () => {}),
    (error) => error.code === 'invalid_workspace_organization_context' && error.status === 400,
  );
  assert.throws(
    () => runWithWorkspaceContext({ projectId: 'project:orphan' }, () => {}),
    (error) => error.code === 'workspace_organization_required' && error.status === 400,
  );
  assert.throws(
    () => pinnedWorkspaceOrganizationId({ FLEET_ORG_ID: '../org' }),
    (error) => error.code === 'invalid_workspace_organization_pin' && error.status === 500,
  );
});
