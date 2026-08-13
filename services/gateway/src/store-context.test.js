'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { currentWorkspaceContext } = require('@ai-fleet/shared-core/store/workspace-context');
const { createStoreContextMiddleware, trustedRequestContext } = require('./store-context');

const pause = () => new Promise((resolve) => setImmediate(resolve));

test('gateway store binding uses only the authoritative validated context', async () => {
  assert.deepEqual(trustedRequestContext({
    fleetContext: { organizationId: 'org-a', projectId: 'project-a' },
    headers: {
      'x-ai-fleet-organization-id': 'org-attacker',
      'x-ai-fleet-project-id': 'project-attacker',
    },
  }), { organizationId: 'org-a', projectId: 'project-a' });

  assert.deepEqual(trustedRequestContext({
    headers: {
      'x-ai-fleet-organization-id': 'org-unvalidated',
      'x-ai-fleet-project-id': 'project-unvalidated',
    },
  }), { organizationId: '', projectId: '' });
});

test('gateway keeps concurrent validated workspaces isolated through async initialization', async () => {
  const initialized = [];
  const middleware = createStoreContextMiddleware({
    initStore: async () => {
      await pause();
      initialized.push(currentWorkspaceContext());
    },
  });

  async function invoke(organizationId, projectId) {
    const req = { fleetContext: { organizationId, projectId } };
    return middleware(req, {}, async (error) => {
      if (error) throw error;
      await pause();
      return currentWorkspaceContext();
    });
  }

  const [a, b] = await Promise.all([
    invoke('org-a', 'project-a'),
    invoke('org-b', 'project-b'),
  ]);

  assert.deepEqual(a, { organizationId: 'org-a', projectId: 'project-a' });
  assert.deepEqual(b, { organizationId: 'org-b', projectId: 'project-b' });
  initialized.sort((left, right) => left.organizationId.localeCompare(right.organizationId));
  assert.deepEqual(initialized, [
    { organizationId: 'org-a', projectId: 'project-a' },
    { organizationId: 'org-b', projectId: 'project-b' },
  ]);
});

test('gateway missing context retains the legacy empty workspace', async () => {
  const middleware = createStoreContextMiddleware({ initStore: async () => {} });
  const observed = await middleware({ auth: { mode: 'disabled' } }, {}, () => currentWorkspaceContext());
  assert.deepEqual(observed, { organizationId: '', projectId: '' });
});

test('gateway binding fails closed if an authoritative context is malformed', async () => {
  let initialized = false;
  let receivedError;
  const middleware = createStoreContextMiddleware({
    initStore: async () => { initialized = true; },
  });
  await middleware({
    fleetContext: { organizationId: 'bad organization', projectId: 'project-a' },
  }, {}, (error) => { receivedError = error; });
  assert.equal(initialized, false);
  assert.equal(receivedError.code, 'invalid_workspace_organization_context');
});
