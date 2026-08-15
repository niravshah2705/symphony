import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The browser bundle uses ESM syntax in .js files while the repository's Node
// package is CommonJS. Import the module source as ESM so these stay pure unit
// tests without adding a DOM or changing the production module boundary.
const source = await readFile(new URL('./permissions.js', import.meta.url), 'utf8');
const { canAccessRoute } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

const publicSession = Object.freeze({
  authenticated: false,
  role: 'public',
  permissions: Object.freeze({ workspace: 'read' }),
});

const viewerSession = Object.freeze({
  authenticated: true,
  role: 'viewer',
  permissions: Object.freeze({
    workspace: 'read',
    planning: 'read',
    insights: 'read',
    settings: 'read',
    org: 'read',
  }),
});

test('public workspace read grants Agent but keeps Agent Jobs signed-in only', () => {
  assert.equal(canAccessRoute(publicSession, 'agent'), true);
  assert.equal(canAccessRoute(publicSession, 'agent-jobs'), false);
});

test('a signed-in viewer with workspace read can access Agent and Agent Jobs', () => {
  assert.equal(canAccessRoute(viewerSession, 'agent'), true);
  assert.equal(canAccessRoute(viewerSession, 'agent-jobs'), true);
});

test('legal routes remain public and organization-independent', () => {
  const noSession = { authenticated: false, permissions: {} };
  for (const route of ['privacy', 'terms']) {
    assert.equal(canAccessRoute(noSession, route), true);
    assert.equal(canAccessRoute(publicSession, route), true);
    assert.equal(canAccessRoute(viewerSession, route), true);
  }
});

test('session-aware route checks preserve unrelated permission requirements', () => {
  assert.equal(canAccessRoute(viewerSession, 'business'), true, 'planning read remains sufficient');
  assert.equal(canAccessRoute(viewerSession, 'calls'), false, 'workspace read remains insufficient for write');

  const workspaceOperator = {
    authenticated: true,
    role: 'operator',
    permissions: { workspace: 'write' },
  };
  assert.equal(canAccessRoute(workspaceOperator, 'calls'), true, 'workspace write remains sufficient');
  assert.equal(canAccessRoute(workspaceOperator, 'business'), false, 'a missing planning grant remains denied');
});
