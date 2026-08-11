'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { currentWorkspaceContext } = require('@ai-fleet/shared/store/workspace-context');
const { createStoreContextMiddleware, forwardedRequestContext } = require('./store-context');

const pause = () => new Promise((resolve) => setImmediate(resolve));

function request(organizationId, projectId) {
  const headers = {
    ...(organizationId ? { 'x-ai-fleet-organization-id': organizationId } : {}),
    ...(projectId ? { 'x-ai-fleet-project-id': projectId } : {}),
  };
  return { headers, get: (name) => headers[String(name).toLowerCase()] };
}

test('coder binds exact forwarded headers and preserves A/B async isolation', async () => {
  assert.deepEqual(forwardedRequestContext(request('org-a', 'project-a')), {
    organizationId: 'org-a', projectId: 'project-a',
  });
  const initialized = [];
  const middleware = createStoreContextMiddleware({
    initStore: async () => {
      await pause();
      initialized.push(currentWorkspaceContext());
    },
  });
  const invoke = (org, project) => middleware(request(org, project), {}, async (error) => {
    if (error) throw error;
    await pause();
    return currentWorkspaceContext();
  });

  const [a, b] = await Promise.all([
    invoke('org-a', 'project-a'),
    invoke('org-b', 'project-b'),
  ]);
  assert.deepEqual(a, { organizationId: 'org-a', projectId: 'project-a' });
  assert.deepEqual(b, { organizationId: 'org-b', projectId: 'project-b' });
  initialized.sort((left, right) => left.organizationId.localeCompare(right.organizationId));
  assert.deepEqual(initialized, [a, b]);
});

test('coder missing forwarded headers retains the legacy empty workspace', async () => {
  const middleware = createStoreContextMiddleware({ initStore: async () => {} });
  const observed = await middleware(request(), {}, () => currentWorkspaceContext());
  assert.deepEqual(observed, { organizationId: '', projectId: '' });
});

test('coder refuses a forwarded project without its organization', async () => {
  let initialized = false;
  let receivedError;
  const middleware = createStoreContextMiddleware({
    initStore: async () => { initialized = true; },
  });
  await middleware(request('', 'project-only'), {}, (error) => { receivedError = error; });
  assert.equal(initialized, false);
  assert.equal(receivedError.code, 'workspace_organization_required');
});
