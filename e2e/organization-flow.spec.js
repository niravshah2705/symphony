'use strict';

// Full org/projects journey: a signed-in user creates a personal project, then
// creates an organization (becoming ORG_ADMIN), then creates an org project,
// adds a person to the org, and adds them to the project as a member.
//
// Auth is stubbed the same way as page-loading.spec.js (vendored Firebase module
// + /api/auth/*). The org service (/api/org/*) is stubbed statefully so the flow
// is deterministic and needs no live backend — the org service's own behavior is
// covered by its pytest suite (services/org/tests). This test asserts the SPA
// wiring end to end: the right calls fire and the UI reflects each step.

const { test, expect } = require('@playwright/test');

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const TS = '2026-01-01T00:00:00Z';
const uid = 'firebase|ada';

// Stateful in-memory org backend shared across the stubbed routes.
function makeOrgState() {
  return {
    hasOrg: false,
    org: { id: 'org-1', name: '', description: null, slug: 'acme-xyz', created_at: TS, updated_at: TS },
    personal: [],
    orgProjects: [],
    // The signed-in admin is the first org user.
    users: [{ id: uid, email: 'ada@example.com', full_name: 'Ada Operator', org_role: 'ORG_ADMIN' }],
    members: {}, // projectId -> [{ user_id, email, full_name, role }]
    seq: 0,
  };
}

async function installStubs(page, state) {
  // --- Firebase (already signed-in Google user) + app auth ---
  await page.route('**/vendor/firebase/firebase-app.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: 'export function initializeApp() { return {}; }',
  }));
  await page.route('**/vendor/firebase/firebase-auth.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: `
      const user = { uid: '${uid}', displayName: 'Ada Operator', email: 'ada@example.com', photoURL: '', getIdToken: async () => 'browser-access-token' };
      export function getAuth() { return { currentUser: user }; }
      export async function setPersistence() {}
      export const browserLocalPersistence = {};
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
  // Admin role so the Organization area (org domain) is accessible.
  await page.route('**/api/auth/me', (route) => json(route, {
    authenticated: true, role: 'admin',
    user: { sub: uid, name: 'Ada Operator', email: 'ada@example.com' },
    permissions: { workspace: 'write', planning: 'write', insights: 'write', settings: 'write', org: 'write' },
  }));
  // Quiet the optional boot calls so they neither hang nor error the flow.
  await page.route('**/api/locale/suggestions**', (route) => json(route, {
    locale: 'en', suggestions: [{ tag: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' }],
  }));
  await page.route('**/api/settings', (route) => json(route, { hasKey: false, planningConfigured: false }));
  await page.route('**/api/roles/assumed', (route) => json(route, { assumedRole: null }));

  // --- Org service (stateful) ---
  const page1 = (rows) => ({ data: rows, meta: { total: rows.length, page: 1, limit: 20 } });

  await page.route('**/api/org/me', (route) => json(route, {
    user_id: uid, email: 'ada@example.com', full_name: 'Ada Operator',
    has_organization: state.hasOrg,
    org_id: state.hasOrg ? state.org.id : null,
    org_role: state.hasOrg ? 'ORG_ADMIN' : null,
  }));

  await page.route('**/api/org/me/projects', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() || {};
      const proj = { id: `pp-${++state.seq}`, owner_id: uid, name: body.name, description: body.description || null, created_at: TS, updated_at: TS };
      state.personal.push(proj);
      return json(route, proj, 201);
    }
    return json(route, page1(state.personal));
  });

  await page.route('**/api/org/me/organization', (route) => {
    const body = route.request().postDataJSON() || {};
    state.org = { ...state.org, name: body.name, description: body.description || null };
    state.hasOrg = true;
    return json(route, state.org, 201);
  });

  await page.route('**/api/org/organizations/current', (route) => json(route, state.org));

  await page.route('**/api/org/projects', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() || {};
      const proj = { id: `op-${++state.seq}`, org_id: state.org.id, name: body.name, description: body.description || null, tags: [], created_at: TS, updated_at: TS };
      state.orgProjects.push(proj);
      return json(route, proj, 201);
    }
    return json(route, page1(state.orgProjects));
  });

  await page.route('**/api/org/users', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() || {};
      const usr = { id: `u-${++state.seq}`, email: body.email, full_name: body.full_name || null, org_role: body.org_role || 'MEMBER' };
      state.users.push(usr);
      return json(route, usr, 201);
    }
    return json(route, page1(state.users));
  });

  await page.route('**/api/org/projects/*/members', (route) => {
    const m = route.request().url().match(/\/projects\/([^/]+)\/members/);
    const pid = m && m[1];
    state.members[pid] = state.members[pid] || [];
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() || {};
      const u = state.users.find((x) => x.id === body.user_id) || { id: body.user_id, email: body.user_id };
      const member = { user_id: u.id, email: u.email, full_name: u.full_name, role: body.role };
      state.members[pid].push(member);
      return json(route, member, 201);
    }
    return json(route, state.members[pid]);
  });
}

test('signed-in user: personal project → create org → org project → add person → add member', async ({ page }) => {
  const state = makeOrgState();
  await page.addInitScript(() => localStorage.setItem('ai-fleet.locale', 'en'));
  await installStubs(page, state);

  await page.goto('/#/organization', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  // Signed in as the stubbed Google user (header chip proves the auth path ran).
  await expect(page.locator('.auth-user')).toContainText('Ada Operator');

  // --- Personal project (available with no org) ---
  await page.getByPlaceholder('New personal project name').fill('My first idea');
  await page.getByRole('button', { name: 'Create personal project' }).click();
  await expect(page.getByText('My first idea')).toBeVisible();

  // --- Create organization (the org-less → admin upgrade) ---
  await expect(page.getByPlaceholder('Organization name')).toBeVisible();
  await page.getByPlaceholder('Organization name').fill('Acme Inc');
  await page.getByRole('button', { name: 'Create organization' }).click();

  // Re-render as an org admin: org sections appear, the create-org form is gone.
  await expect(page.getByPlaceholder('New organization project name')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add person' })).toBeVisible();
  await expect(page.getByPlaceholder('Organization name')).toHaveCount(0);

  // --- Org project ---
  await page.getByPlaceholder('New organization project name').fill('Team project');
  await page.getByRole('button', { name: 'Create org project' }).click();
  await expect(page.getByText('Team project')).toBeVisible();

  // --- Add a person to the org ---
  await page.getByPlaceholder('person@company.com').fill('teammate@corp.com');
  await page.getByPlaceholder('Temporary password (min 8)').fill('password123');
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByText('teammate@corp.com')).toBeVisible();

  // --- Add that person to the project as a member ---
  const membersBtn = page.getByRole('button', { name: 'Members', exact: true }).first();
  await membersBtn.click();
  const members = page.locator('.org-members');
  await expect(members).toBeVisible();
  await members.getByLabel('Org user').selectOption({ label: 'teammate@corp.com' });
  await members.getByLabel('Project role').selectOption('DEVELOPER');
  await members.getByRole('button', { name: 'Add member' }).click();

  // Adding a member re-renders the view (which collapses the panel); re-open it
  // to confirm the person is now listed as a project member.
  await expect(page.locator('.org-members')).toHaveCount(0);
  await page.getByRole('button', { name: 'Members', exact: true }).first().click();
  const membersAfter = page.locator('.org-members');
  await expect(membersAfter.getByText('teammate@corp.com')).toBeVisible();
  await expect(membersAfter.getByText('Role: DEVELOPER')).toBeVisible();
});
