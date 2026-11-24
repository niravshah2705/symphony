import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The browser bundle uses ESM syntax in .js files while the repository's Node
// package is CommonJS. Import the module source as ESM so these stay pure unit
// tests without adding a DOM or changing the production module boundary.
const source = await readFile(new URL('./permissions.js', import.meta.url), 'utf8');
const { canAccessRoute, menuRouteVisible, toBeReleasedBlocked } = await import(
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
  for (const route of ['privacy', 'terms', 'refund', 'shipping']) {
    assert.equal(canAccessRoute(noSession, route), true);
    assert.equal(canAccessRoute(publicSession, route), true);
    assert.equal(canAccessRoute(viewerSession, route), true);
  }
});

test('deprecated routes are hidden by default and restored by the header opt-in', () => {
  const deprecatedRoutes = ['business', 'board', 'identity', 'agent-jobs'];
  const optedIn = Object.freeze({ ...viewerSession, deprecatedUiEnabled: true });
  for (const route of deprecatedRoutes) {
    assert.equal(menuRouteVisible(viewerSession, route), false, `${route} is hidden by default`);
    assert.equal(menuRouteVisible(optedIn, route), true, `${route} returns with x-ai-fleet-deprecated: true`);
  }
});

test('the deprecated opt-in does not bypass permissions or sign-in', () => {
  const publicOptIn = Object.freeze({ ...publicSession, deprecatedUiEnabled: true });
  assert.equal(menuRouteVisible(publicOptIn, 'agent-jobs'), false, 'agent jobs stays signed-in only');
  assert.equal(menuRouteVisible(publicOptIn, 'business'), false, 'planning read is still required');
  // Direct links are unchanged: the removal is nav-only.
  assert.equal(canAccessRoute(viewerSession, 'business'), true);
});

test('to-be-released pages are hidden by default and restored by the header opt-in', () => {
  const toBeReleasedRoutes = ['calls', 'projects', 'organization', 'analytics', 'cost', 'usage', 'troubleshooting', 'settings'];
  const optedIn = Object.freeze({ ...viewerSession, toBeReleasedUiEnabled: true });
  for (const route of toBeReleasedRoutes) {
    assert.equal(menuRouteVisible(viewerSession, route), false, `${route} is hidden by default`);
    assert.equal(toBeReleasedBlocked(viewerSession, route), true, `${route} is blocked at render by default`);
    // Calls needs workspace write, which the viewer session lacks — visibility
    // returns only for the routes the role already permits.
    const expectVisible = route !== 'calls';
    assert.equal(menuRouteVisible(optedIn, route), expectVisible, `${route} nav returns with x-ai-fleet-to-bereleased: true: ${expectVisible}`);
    assert.equal(toBeReleasedBlocked(optedIn, route), false, `${route} renders with the opt-in`);
  }
});

test('the to-be-released opt-in does not bypass permissions', () => {
  const publicOptIn = Object.freeze({ ...publicSession, toBeReleasedUiEnabled: true });
  assert.equal(menuRouteVisible(publicOptIn, 'analytics'), false, 'insights read is still required');
  const workspaceOperator = Object.freeze({
    authenticated: true,
    role: 'operator',
    permissions: { workspace: 'write', planning: 'read', insights: 'read', settings: 'read', org: 'read' },
    toBeReleasedUiEnabled: true,
  });
  assert.equal(menuRouteVisible(workspaceOperator, 'calls'), true, 'workspace write unlocks calls once released in');
  assert.equal(menuRouteVisible(workspaceOperator, 'settings'), true);
  // Permission checks themselves never consult the flag.
  assert.equal(canAccessRoute(publicOptIn, 'analytics'), false);
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
