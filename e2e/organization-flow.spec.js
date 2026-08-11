'use strict';

// Browser contract coverage for native AI Fleet organization/project context
// and email invitations. The stateful routes model /api/org without requiring
// the Python service, while still asserting the exact browser request shapes.

const { test, expect } = require('@playwright/test');

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const TS = '2026-01-01T00:00:00Z';
const uid = 'firebase|ada';

function makeOrgState() {
  return {
    organizations: [],
    userOrgIds: new Set(),
    personal: [],
    projectsByOrg: {},
    usersByOrg: {},
    invitationsByOrg: {},
    members: {},
    seq: 0,
  };
}

function createStateOrg(state, name, { joined = true } = {}) {
  const id = `org-${++state.seq}`;
  const org = { id, name, description: null, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${state.seq}`, created_at: TS, updated_at: TS };
  state.organizations.push(org);
  state.projectsByOrg[id] = [];
  state.usersByOrg[id] = joined
    ? [{ id: uid, email: 'ada@example.com', full_name: 'Ada Operator', org_role: 'ORG_ADMIN' }]
    : [];
  state.invitationsByOrg[id] = [];
  if (joined) state.userOrgIds.add(id);
  return org;
}

function organizationIdFor(route, state) {
  const selected = route.request().headers()['x-ai-fleet-organization-id'];
  return state.organizations.some((org) => org.id === selected)
    ? selected
    : [...state.userOrgIds][0] || null;
}

async function installStubs(page, state) {
  await page.route('**/vendor/firebase/firebase-app.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: 'export function initializeApp() { return {}; }',
  }));
  await page.route('**/vendor/firebase/firebase-auth.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: `
      const user = { uid: '${uid}', displayName: 'Ada Operator', email: 'ada@example.com', photoURL: '', getIdToken: async () => 'browser-access-token' };
      export const browserLocalPersistence = {};
      export const browserPopupRedirectResolver = {};
      export function initializeAuth(_app, options) {
        if (options.persistence !== browserLocalPersistence || 'popupRedirectResolver' in options) throw new Error('unexpected eager auth initialization');
        return { currentUser: user };
      }
      export function onAuthStateChanged(_a, cb) { Promise.resolve().then(() => cb(user)); return () => {}; }
      export class GoogleAuthProvider { static credential() { return {}; } setCustomParameters() {} }
      export class OAuthProvider { credential() { return {}; } }
      export async function signInWithCredential() { return { user }; }
      export async function signInWithPopup() { return { user }; }
      export async function signOut() {}
    `,
  }));
  await page.route('**/api/auth/config', (route) => json(route, {
    mode: 'firebase', enabled: true, provider: 'firebase',
    firebase: { apiKey: 'AIzaTESTKEY', authDomain: 'demo.firebaseapp.com', projectId: 'demo' },
  }));
  await page.route('**/api/auth/me', (route) => json(route, {
    authenticated: true, role: 'admin',
    user: { sub: uid, name: 'Ada Operator', email: 'ada@example.com' },
    permissions: { workspace: 'write', planning: 'write', insights: 'write', settings: 'write', org: 'write' },
  }));
  await page.route('**/api/config', (route) => json(route, {
    authenticated: true, status: 'shared', gatewayUrl: '', orgName: null,
  }));
  await page.route('**/api/settings', (route) => json(route, { hasKey: false, planningConfigured: false }));
  await page.route('**/api/roles/assumed', (route) => json(route, { assumedRole: null }));

  const page1 = (rows) => ({ data: rows, meta: { total: rows.length, page: 1, limit: 20 } });

  await page.route('**/api/org/me/context', (route) => json(route, {
    user: { id: uid, email: 'ada@example.com', full_name: 'Ada Operator' },
    organizations: state.organizations
      .filter((org) => state.userOrgIds.has(org.id))
      .map((org) => ({
        id: org.id,
        name: org.name,
        role: 'ORG_ADMIN',
        projects: state.projectsByOrg[org.id].map((project) => ({
          id: project.id, name: project.name, role: 'PROJECT_ADMIN',
        })),
      })),
  }));
  await page.route('**/api/org/me', (route) => {
    const firstOrgId = [...state.userOrgIds][0] || null;
    return json(route, {
      user_id: uid, email: 'ada@example.com', full_name: 'Ada Operator',
      has_organization: Boolean(firstOrgId), org_id: firstOrgId,
      // Deliberately stale: the UI must use /me/context roles, not this field.
      org_role: firstOrgId ? 'MEMBER' : null,
    });
  });
  await page.route('**/api/org/me/projects', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() || {};
      const project = { id: `personal-${++state.seq}`, owner_id: uid, name: body.name, description: body.description || null, created_at: TS, updated_at: TS };
      state.personal.push(project);
      return json(route, project, 201);
    }
    return json(route, page1(state.personal));
  });
  await page.route('**/api/org/me/organizations', (route) => {
    const body = route.request().postDataJSON() || {};
    const org = createStateOrg(state, body.name || 'Untitled');
    org.description = body.description || null;
    return json(route, org, 201);
  });
  await page.route('**/api/org/organizations/current', (route) => {
    const orgId = organizationIdFor(route, state);
    return json(route, state.organizations.find((org) => org.id === orgId) || { error: 'No organization' }, orgId ? 200 : 404);
  });
  await page.route('**/api/org/projects', (route) => {
    const orgId = organizationIdFor(route, state);
    const projects = state.projectsByOrg[orgId] || [];
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() || {};
      const project = { id: `project-${++state.seq}`, org_id: orgId, name: body.name, description: body.description || null, tags: [], created_at: TS, updated_at: TS };
      projects.push(project);
      return json(route, project, 201);
    }
    return json(route, page1(projects));
  });
  await page.route('**/api/org/users', (route) => {
    const orgId = organizationIdFor(route, state);
    return json(route, page1(state.usersByOrg[orgId] || []));
  });
  await page.route('**/api/org/invitations**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const orgId = organizationIdFor(route, state);
    const list = state.invitationsByOrg[orgId] || [];
    const accept = url.pathname.endsWith('/invitations/accept');
    const resend = url.pathname.match(/\/invitations\/([^/]+)\/resend$/);
    const item = url.pathname.match(/\/invitations\/([^/]+)$/);
    if (request.method() === 'POST' && accept) {
      const token = request.postDataJSON()?.token;
      const invitation = Object.values(state.invitationsByOrg).flat().find((candidate) => candidate.token === token);
      if (!invitation) return json(route, { error: 'Invalid invitation' }, 404);
      state.userOrgIds.add(invitation.org_id);
      state.usersByOrg[invitation.org_id].push({ id: uid, email: 'ada@example.com', full_name: 'Ada Operator', org_role: invitation.org_role });
      invitation.status = 'ACCEPTED';
      return json(route, { organization_id: invitation.org_id, status: 'ACCEPTED' });
    }
    if (request.method() === 'POST' && resend) {
      const invitation = list.find((candidate) => candidate.id === decodeURIComponent(resend[1]));
      if (invitation) invitation.resend_count = (invitation.resend_count || 0) + 1;
      return json(route, invitation || { error: 'Not found' }, invitation ? 200 : 404);
    }
    if (request.method() === 'DELETE' && item) {
      const index = list.findIndex((candidate) => candidate.id === decodeURIComponent(item[1]));
      if (index >= 0) list.splice(index, 1);
      return route.fulfill({ status: 204, body: '' });
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON() || {};
      const invitation = {
        id: `invitation-${++state.seq}`, token: `token-${state.seq}`,
        org_id: orgId, email: body.email, org_role: body.org_role,
        status: 'PENDING', created_at: TS,
      };
      list.push(invitation);
      return json(route, invitation, 201);
    }
    // The org service invitation list contract is a bare array.
    return json(route, list.filter((invitation) => invitation.status === 'PENDING'));
  });
  await page.route('**/api/org/projects/*/members', (route) => {
    const match = new URL(route.request().url()).pathname.match(/\/projects\/([^/]+)\/members/);
    const projectId = match && match[1];
    state.members[projectId] = state.members[projectId] || [];
    return json(route, state.members[projectId]);
  });
}

test('user creates orgs and projects, then manages pending invitations', async ({ page }) => {
  const state = makeOrgState();
  let invitationBody = null;
  let reloads = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) reloads += 1; });
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/org/invitations') {
      invitationBody = request.postDataJSON();
    }
  });
  await page.addInitScript(() => localStorage.setItem('ai-fleet.locale', 'en'));
  await installStubs(page, state);

  await page.goto('/#/organization', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.auth-user')).toContainText('Ada Operator');

  await page.getByPlaceholder('New personal project name').fill('My first idea');
  await page.getByRole('button', { name: 'Create personal project' }).click();
  await expect(page.getByText('My first idea')).toBeVisible();

  await page.getByPlaceholder('Organization name').fill('Acme Inc');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.getByRole('button', { name: 'Create organization' }).click(),
  ]);
  await expect(page.getByPlaceholder('New organization project name')).toBeVisible();
  // Legacy /me says MEMBER; selected /me/context says ORG_ADMIN and wins.
  await expect(page.getByRole('button', { name: 'Send invitation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create another organization' })).toBeVisible();

  await page.getByPlaceholder('New organization project name').fill('Team project');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.getByRole('button', { name: 'Create org project' }).click(),
  ]);
  await expect(page.locator('#view').getByText('Team project', { exact: true })).toBeVisible();

  await page.getByPlaceholder('person@company.com').fill('teammate@corp.com');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('teammate@corp.com')).toBeVisible();
  expect(invitationBody).toEqual({ email: 'teammate@corp.com', org_role: 'MEMBER' });
  expect(state.usersByOrg[state.organizations[0].id]).toHaveLength(1);

  await page.getByRole('button', { name: 'Resend' }).click();
  expect(state.invitationsByOrg[state.organizations[0].id][0].resend_count).toBe(1);
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('No pending invitations.')).toBeVisible();

  await page.getByPlaceholder('Organization name').fill('Second Org');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.getByRole('button', { name: 'Create another organization' }).click(),
  ]);
  await page.locator('.account-context-trigger').click();
  await expect(page.locator('#account-organization-select option')).toHaveCount(2);
  expect(reloads).toBeGreaterThanOrEqual(3);
});

test('fragment invitation requires an explicit accept and refreshes selectable context', async ({ page }) => {
  const state = makeOrgState();
  const org = createStateOrg(state, 'Invited Org', { joined: false });
  state.invitationsByOrg[org.id].push({
    id: 'invitation-1', token: 'opaque/token+value', org_id: org.id,
    email: 'ada@example.com', org_role: 'MEMBER', status: 'PENDING', created_at: TS,
  });
  let accepted = false;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/org/invitations/accept')) accepted = true;
  });
  await page.addInitScript(() => localStorage.setItem('ai-fleet.locale', 'en'));
  await installStubs(page, state);

  await page.goto('/#/invite?token=opaque%2Ftoken%2Bvalue', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.invitation-card')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeEnabled();
  expect(accepted).toBe(false);
  expect(new URL(page.url()).search).toBe('');

  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(/#\/organization$/);
  await expect(page.getByRole('heading', { name: 'Invited Org', exact: true })).toBeVisible();
  expect(accepted).toBe(true);
  expect(page.url()).not.toContain('opaque');
});
