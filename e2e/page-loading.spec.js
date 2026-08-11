'use strict';

const { test, expect } = require('@playwright/test');

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

// A stub of the vendored Firebase Web SDK whose sign-in state is driven by a
// localStorage flag so it survives the post-sign-in window.location.reload().
// signInWithPopup (Google OR Microsoft OAuthProvider) flips the flag; the next
// boot then sees a signed-in user — mirroring how Firebase federates any
// provider into the same session.
const FIREBASE_AUTH_STUB = `
  const user = { uid: 'firebase|max', displayName: 'Max Operator', email: 'max@example.com', photoURL: '', getIdToken: async () => 'browser-access-token' };
  const signedIn = () => localStorage.getItem('e2e.signedin') === '1';
  export const browserLocalPersistence = {};
  export const browserPopupRedirectResolver = {};
  export function initializeAuth(_app, options) {
    if (options.persistence !== browserLocalPersistence || 'popupRedirectResolver' in options) throw new Error('unexpected eager auth initialization');
    return { get currentUser() { return signedIn() ? user : null; } };
  }
  export function onAuthStateChanged(_auth, cb) { Promise.resolve().then(() => cb(signedIn() ? user : null)); return () => {}; }
  export class GoogleAuthProvider { static credential() { return {}; } setCustomParameters() {} }
  export class OAuthProvider { constructor(id) { this.providerId = id; } credential() { return {}; } setCustomParameters() {} }
  export async function signInWithCredential() { localStorage.setItem('e2e.signedin', '1'); return { user }; }
  export async function signInWithPopup(_auth, _provider, resolver) {
    if (resolver !== browserPopupRedirectResolver) throw new Error('popup resolver was not supplied explicitly');
    localStorage.setItem('e2e.signedin', '1');
    return { user };
  }
  export async function signOut() { localStorage.removeItem('e2e.signedin'); }
`;

test('settings renders task-model controls without a view error', async ({ page }) => {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));

  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
  });

  const response = await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();

  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#settings-models')).toBeVisible();
  await expect(page.locator('.settings-layout')).toBeVisible();
  await expect(page.locator('.settings-index')).toHaveCount(0);
  await expect(page.locator('#view > .error-banner')).toHaveCount(0);
  // Redesign: scope ladder (org/project/user) + sticky right rail must render.
  await expect(page.locator('.sx-scopes .sx-scope')).toHaveCount(3);
  await expect(page.locator('.settings-rail')).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test('workspace renders while optional locale and Linear discovery are stalled', async ({ page }) => {
  const browserErrors = [];
  const failedAssets = [];

  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    if (['document', 'script', 'stylesheet'].includes(request.resourceType())) {
      failedAssets.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || 'failed'}`);
    }
  });

  await page.addInitScript(() => {
    localStorage.setItem('lm.lastWorkspaceRoute', 'agent');
  });
  await page.route('**/api/locale/suggestions**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await json(route, {
      locale: 'en',
      recommendedLocale: 'gu-IN',
    });
  });
  await page.route('**/api/settings/validate', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await json(route, { ok: true });
  });
  await page.route('**/api/settings', (route) => json(route, {
    hasKey: true,
    planningConfigured: true,
    planningProvider: 'linear',
  }));
  await page.route('**/api/roles/assumed', (route) => json(route, { assumedRole: null }));
  await page.route('**/api/agent/status', (route) => json(route, {
    scheduleEnabled: false,
    counts: {},
    localActiveModel: 'Local test model',
  }));
  await page.route('**/api/agent/jobs', (route) => json(route, { jobs: [] }));
  await page.route('**/api/coder', (route) => json(route, {
    running: false,
    paused: false,
    pauseReason: null,
    inFlight: [],
  }));

  const response = await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();

  // This is intentionally shorter than both delayed requests. The shell and
  // useful route must paint without waiting on locale or integration discovery.
  await expect(page.locator('.agent-workspace')).toBeVisible({ timeout: 2_000 });
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#route-title')).toHaveText('Agent workspace');
  expect(browserErrors).toEqual([]);
  expect(failedAssets).toEqual([]);
});

test('authentication configuration failure locks the workspace before protected API calls', async ({ page }) => {
  const protectedRequests = [];
  const firebaseRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/vendor/firebase/')) firebaseRequests.push(url.pathname);
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/auth/config') {
      protectedRequests.push(`${request.method()} ${url.pathname}`);
    }
  });
  await page.route('**/api/auth/config', (route) => json(route, {
    mode: 'firebase',
    enabled: true,
    provider: 'firebase',
    firebase: {},
  }));

  const response = await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expect(page.locator('.auth-card')).toBeVisible();
  await expect(page.locator('.auth-card .error-banner')).toHaveText('We could not verify your session. Try signing in again.');
  await expect(page.locator('.auth-continue')).toHaveText('Retry');
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  expect(protectedRequests).toEqual([]);
  // Validate the public config before paying the Firebase download/parse cost.
  expect(firebaseRequests).toEqual([]);
});

test('disabled auth skips Firebase and bodyless API GETs omit the JSON content type', async ({ page }) => {
  const firebaseRequests = [];
  const getContentTypes = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/vendor/firebase/')) firebaseRequests.push(url.pathname);
    if (request.method() === 'GET' && url.pathname.startsWith('/api/') && url.pathname !== '/api/auth/config') {
      getContentTypes.push(request.headers()['content-type']);
    }
  });

  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
    localStorage.setItem('lm.lastWorkspaceRoute', 'agent');
  });
  // Catch-all keeps this request-header regression test independent of local
  // service data. The specific auth route is registered last so it wins.
  await page.route('**/api/**', (route) => json(route, {}));
  await page.route('**/api/auth/config', (route) => json(route, { mode: 'disabled', enabled: false }));

  await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.agent-workspace')).toBeVisible();
  expect(firebaseRequests).toEqual([]);
  expect(getContentTypes.length).toBeGreaterThan(0);
  expect(getContentTypes.every((value) => value === undefined)).toBe(true);

  const mutation = page.waitForRequest((request) => (
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/eula'
  ));
  await page.evaluate(async () => {
    const { api } = await import('/js/api.js');
    await api.recordEulaDecision('accepted', 'user');
  });
  expect((await mutation).headers()['content-type']).toContain('application/json');
});

test('fixed language groups mark, but never auto-apply, the IP recommendation', async ({ page }) => {
  let suggestionRequests = 0;
  await page.route('**/api/**', (route) => json(route, {}));
  await page.route('**/api/locale/translate', (route) => {
    const body = route.request().postDataJSON() || {};
    return json(route, { locale: body.locale, translations: body.texts || [] });
  });
  await page.route('**/api/locale/suggestions**', (route) => {
    suggestionRequests += 1;
    return json(route, { locale: 'en', recommendedLocale: 'mr-IN' });
  });
  await page.route('**/api/auth/config', (route) => json(route, { mode: 'disabled', enabled: false }));

  await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  const select = page.locator('#language-select');
  await expect(select).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(select.locator('option[data-recommended="true"]')).toHaveText('मराठी — Recommended');
  expect(await select.locator('optgroup').evaluateAll((groups) => groups.map((group) => group.label))).toEqual([
    'Regional', 'National', 'International', 'Others',
  ]);
  expect(await select.locator('option').evaluateAll((options) => options.map((option) => option.value))).toEqual([
    'mr-IN', 'gu-IN', 'hi-IN', 'en', 'es', 'fr', 'de', 'pt-BR', 'ja-JP', 'ar',
  ]);

  await select.selectOption('mr-IN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'mr-IN');
  await expect(page.locator('#route-title')).toHaveText('एजंट कार्यक्षेत्र');
  expect(suggestionRequests).toBe(1);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#language-select')).toHaveValue('mr-IN');
  await expect(page.locator('#route-title')).toHaveText('एजंट कार्यक्षेत्र');
  // A saved locale is authoritative; VPN/IP recommendation lookup is skipped.
  expect(suggestionRequests).toBe(1);
});

test('authenticated Firebase session adds a bearer token and ignores an unrelated provider 401', async ({ page }) => {
  const authenticatedRequests = [];
  const authStartupRequests = [];
  let settingsContextHeaders = null;
  let streamContext = null;
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/config' || pathname.startsWith('/vendor/firebase/')) {
      authStartupRequests.push(pathname);
    }
  });
  const authorizedJson = (route, body, status = 200) => {
    const authorization = route.request().headers().authorization;
    authenticatedRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    expect(authorization).toBe('Bearer browser-access-token');
    return json(route, body, status);
  };

  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
    localStorage.setItem('lm.lastWorkspaceRoute', 'agent');
  });
  // Stub the vendored Firebase Web SDK with an already signed-in Google user.
  await page.route('**/vendor/firebase/firebase-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: 'export function initializeApp() { return {}; }',
  }));
  await page.route('**/vendor/firebase/firebase-auth.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: `
      const user = { uid: 'firebase|ada', displayName: 'Ada Operator', email: 'ada@example.com', photoURL: '', getIdToken: async () => 'browser-access-token' };
      export const browserLocalPersistence = {};
      export const browserPopupRedirectResolver = {};
      export function initializeAuth(_app, options) {
        if (options.persistence !== browserLocalPersistence || 'popupRedirectResolver' in options) throw new Error('unexpected eager auth initialization');
        return { currentUser: user };
      }
      export function onAuthStateChanged(_auth, cb) { Promise.resolve().then(() => cb(user)); return () => {}; }
      export class GoogleAuthProvider { static credential() { return {}; } setCustomParameters() {} }
      export class OAuthProvider { credential() { return {}; } }
      export async function signInWithCredential() { return { user }; }
      export async function signInWithPopup() { return { user }; }
      export async function signOut() {}
    `,
  }));
  await page.route('**/api/auth/config', (route) => json(route, {
    mode: 'firebase',
    enabled: true,
    provider: 'firebase',
    firebase: {
      apiKey: 'AIzaTESTKEY',
      authDomain: 'demo-proj.firebaseapp.com',
      projectId: 'demo-proj',
    },
  }));
  await page.route('**/api/auth/me', (route) => authorizedJson(route, {
    mode: 'firebase',
    authenticated: true,
    role: 'admin',
    // The gateway always returns the resolved permissions; the SPA gates routes
    // on them (empty set → the agent workspace route is blocked). Mirror that so
    // the authenticated workspace actually renders.
    permissions: { workspace: 'write', planning: 'write', insights: 'write', settings: 'write', org: 'write' },
    user: { sub: 'firebase|ada', name: 'Ada Operator', email: 'ada@example.com' },
  }));
  await page.route('**/api/org/me/context', (route) => authorizedJson(route, {
    user: { id: 'firebase|ada', email: 'ada@example.com', full_name: 'Ada Operator' },
    organizations: [{
      id: 'org-primary', name: 'Primary Org', role: 'ORG_ADMIN',
      projects: [{ id: 'fleet-project', name: 'Fleet Project', role: 'PROJECT_ADMIN' }],
    }],
  }));
  await page.route('**/api/config', (route) => authorizedJson(route, {
    authenticated: true, status: 'shared', gatewayUrl: '', orgName: 'Primary Org',
  }));
  await page.route('**/api/locale/suggestions**', (route) => authorizedJson(route, {
    locale: 'en',
    suggestions: [{ tag: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' }],
  }));
  // This 401 belongs to the Linear connector, not application authentication.
  // It must update connection health without clearing the Firebase session.
  await page.route('**/api/settings', (route) => {
    settingsContextHeaders = route.request().headers();
    return authorizedJson(route, { error: 'Linear credential needs attention' }, 401);
  });
  await page.route('**/api/roles/assumed', (route) => authorizedJson(route, { assumedRole: null }));
  await page.route('**/api/agent/status', (route) => authorizedJson(route, {
    scheduleEnabled: false,
    counts: {},
    localActiveModel: 'Local test model',
  }));
  await page.route('**/api/agent/jobs', (route) => authorizedJson(route, { jobs: [] }));
  await page.route('**/api/coder', (route) => authorizedJson(route, {
    running: false,
    paused: false,
    pauseReason: null,
    inFlight: [],
  }));
  // EventSource cannot set headers. Its short-lived token is bound to the same
  // selected context, repeated as query parameters on the stream URL.
  await page.route('**/api/agent/workspace-stream**', (route) => {
    const url = new URL(route.request().url());
    streamContext = {
      organizationId: url.searchParams.get('organizationId'),
      projectId: url.searchParams.get('projectId'),
    };
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      body: ': ready\n\n',
    });
  });
  await page.route('**/api/agent/workspace-stream-token**', (route) => authorizedJson(route, {
    token: 'context-bound-stream-token',
  }));

  const response = await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expect(page.locator('.agent-workspace')).toBeVisible();
  await expect(page.locator('.auth-user')).toContainText('Ada Operator');
  await page.locator('.account-context-trigger').click();
  await expect(page.locator('.auth-sign-out')).toBeVisible();
  await expect(page.locator('#account-organization-select')).toHaveValue('org-primary');
  await expect(page.locator('#account-project-select')).toHaveValue('fleet-project');
  await expect(page.locator('#language-select optgroup')).toHaveCount(4);
  await expect(page.locator('.auth-card')).toHaveCount(0);
  expect(settingsContextHeaders['x-ai-fleet-organization-id']).toBe('org-primary');
  expect(settingsContextHeaders['x-ai-fleet-project-id']).toBe('fleet-project');
  await expect.poll(() => streamContext).toEqual({
    organizationId: 'org-primary',
    projectId: 'fleet-project',
  });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ai-fleet.context')))).toEqual({
    version: 1,
    users: {
      'firebase|ada': {
        organizationId: 'org-primary',
        projectIdsByOrganization: { 'org-primary': 'fleet-project' },
      },
    },
  });
  expect(authenticatedRequests).toContain('GET /api/auth/me');
  expect(authenticatedRequests).toContain('GET /api/settings');
  expect(authStartupRequests[0]).toBe('/api/auth/config');
  expect(authStartupRequests).toContain('/vendor/firebase/firebase-app.js');
  expect(authStartupRequests).toContain('/vendor/firebase/firebase-auth.js');
});

test('Settings Policy uses the active native project and selected-context roles', async ({ page }) => {
  const policyRequests = [];
  let personalProjectRequests = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/settings-policy/')) {
      policyRequests.push({ url, headers: request.headers() });
    }
    if (url.pathname === '/api/org/me/projects') personalProjectRequests += 1;
  });
  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
    localStorage.setItem('e2e.signedin', '1');
  });
  await page.route('**/api/**', (route) => json(route, {}));
  await page.route('**/vendor/firebase/firebase-app.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: 'export function initializeApp() { return {}; }',
  }));
  await page.route('**/vendor/firebase/firebase-auth.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: FIREBASE_AUTH_STUB,
  }));
  await page.route('**/api/auth/config', (route) => json(route, {
    mode: 'firebase', enabled: true, provider: 'firebase',
    firebase: { apiKey: 'AIzaTESTKEY', authDomain: 'demo-proj.firebaseapp.com', projectId: 'demo-proj' },
  }));
  await page.route('**/api/auth/me', (route) => json(route, {
    authenticated: true, role: 'admin',
    permissions: { workspace: 'write', settings: 'write', org: 'write' },
    user: { sub: 'firebase|max', name: 'Max Operator', email: 'max@example.com' },
  }));
  await page.route('**/api/org/me/context', (route) => json(route, {
    user: { id: 'firebase|max', email: 'max@example.com', full_name: 'Max Operator' },
    organizations: [{
      id: 'org-selected', name: 'Selected Org', role: 'MEMBER',
      projects: [{ id: 'native-project', name: 'Native Fleet Project', role: 'PROJECT_ADMIN' }],
    }],
  }));
  // This legacy role intentionally conflicts with the selected org role.
  await page.route('**/api/org/me', (route) => json(route, {
    user_id: 'firebase|max', email: 'max@example.com', has_organization: true,
    org_id: 'legacy-org', org_role: 'ORG_ADMIN',
  }));
  await page.route('**/api/agent/config', (route) => json(route, { config: {} }));
  await page.route('**/api/agent/models', (route) => json(route, { intervals: [5, 10, 15] }));
  await page.route('**/api/agent/labels', (route) => json(route, { labels: [] }));

  await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#settings-models')).toBeVisible();
  const activeScope = page.locator('.sx-scope.active');
  await expect(activeScope).toContainText('Project');
  await expect(activeScope).toContainText('Native Fleet Project');
  await expect.poll(() => policyRequests.length).toBeGreaterThan(0);
  expect(personalProjectRequests).toBe(0);
  expect(policyRequests.some(({ url }) => url.pathname.endsWith('/settings/effective')
    && url.searchParams.get('project_id') === 'native-project')).toBe(true);
  for (const request of policyRequests) {
    expect(request.headers['x-ai-fleet-organization-id']).toBe('org-selected');
    expect(request.headers['x-ai-fleet-project-id']).toBe('native-project');
  }

  await page.locator('.sx-scope').filter({ hasText: 'Organization' }).click();
  await expect(page.getByText('Organization admins only.').first()).toBeVisible();
});

test('selected organization admins can open scoped policy without global settings write', async ({ page }) => {
  const policyRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/settings-policy/')) policyRequests.push(url.pathname);
  });
  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
    localStorage.setItem('e2e.signedin', '1');
  });
  await page.route('**/api/**', (route) => json(route, {}));
  await page.route('**/vendor/firebase/firebase-app.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: 'export function initializeApp() { return {}; }',
  }));
  await page.route('**/vendor/firebase/firebase-auth.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: FIREBASE_AUTH_STUB,
  }));
  await page.route('**/api/auth/config', (route) => json(route, {
    mode: 'firebase', enabled: true, provider: 'firebase',
    firebase: { apiKey: 'AIzaTESTKEY', authDomain: 'demo-proj.firebaseapp.com', projectId: 'demo-proj' },
  }));
  await page.route('**/api/auth/me', (route) => json(route, {
    authenticated: true, role: 'viewer',
    permissions: { workspace: 'read', settings: 'read', org: 'read' },
    user: { sub: 'firebase|viewer-admin', name: 'Selected Admin', email: 'admin@example.com' },
  }));
  await page.route('**/api/org/me/context', (route) => json(route, {
    user: { id: 'firebase|viewer-admin', email: 'admin@example.com', full_name: 'Selected Admin' },
    organizations: [{
      id: 'org-selected', name: 'Selected Org', role: 'ORG_ADMIN',
      projects: [{ id: 'native-project', name: 'Native Fleet Project', role: 'PROJECT_ADMIN' }],
    }],
  }));

  await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#tabs a[data-route="settings"]')).toBeVisible();
  await expect(page.getByText(/Operational models, connections, and runtime defaults require/)).toBeVisible();
  await expect(page.locator('.sx-scope.active')).toContainText('Organization');
  await expect(page.getByText('Default provider')).toHaveCount(0);
  await expect.poll(() => policyRequests.length).toBeGreaterThan(0);
});

test('Microsoft popup sign-in renders Google-first, federates into Firebase, and carries a bearer', async ({ page }) => {
  const bearerSeen = [];
  // Fresh context → localStorage starts empty (signed out). The sign-in flag set
  // by signInWithPopup must SURVIVE the reload, so we do NOT clear it here.
  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
  });
  await page.route('**/vendor/firebase/firebase-app.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: 'export function initializeApp() { return {}; }',
  }));
  await page.route('**/vendor/firebase/firebase-auth.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: FIREBASE_AUTH_STUB,
  }));
  // Catch-all so the post-login settings view never reaches a real backend.
  // Registered first → lowest precedence (Playwright tries the last-registered
  // matching route first), so the specific routes below win.
  await page.route('**/api/**', (route) => json(route, {}));
  await page.route('**/api/auth/config', (route) => json(route, {
    mode: 'firebase', enabled: true, provider: 'firebase',
    firebase: { apiKey: 'AIzaTESTKEY', authDomain: 'demo-proj.firebaseapp.com', projectId: 'demo-proj', googleEnabled: true, microsoftEnabled: true },
    publicPermissions: { workspace: 'read' },
  }));
  await page.route('**/api/auth/me', (route) => {
    const authorization = route.request().headers().authorization;
    if (authorization) bearerSeen.push(authorization);
    return json(route, {
      mode: 'firebase', authenticated: true, role: 'admin',
      permissions: { workspace: 'write', planning: 'write', insights: 'write', settings: 'write', org: 'write' },
      user: { sub: 'firebase|max', name: 'Max Operator', email: 'max@example.com' },
    });
  });
  await page.route('**/api/org/me/context', (route) => json(route, {
    user: { id: 'firebase|max', email: 'max@example.com', full_name: 'Max Operator' },
    organizations: [{ id: 'org-max', name: 'Max Org', role: 'ORG_ADMIN', projects: [] }],
  }));

  // /#/settings needs settings:write, so a signed-out visitor gets the sign-in card.
  await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });
  const actions = page.locator('.auth-actions .auth-continue');
  await expect(actions).toHaveCount(2);
  await expect(actions.nth(0)).toHaveText('Continue with Google');
  await expect(actions.nth(1)).toHaveText('Continue with Microsoft');
  await expect(actions.nth(1)).toHaveClass(/microsoft/);

  await actions.nth(1).click(); // sign in with Microsoft → popup → confirm → reload
  await expect(page.locator('.auth-user')).toContainText('Max Operator');
  await page.locator('.account-context-trigger').click();
  await expect(page.locator('#auth-control .auth-sign-out')).toBeVisible();
  expect(bearerSeen).toContain('Bearer browser-access-token');
});

test('sign-in card shows only the enabled provider (Microsoft-only, primary)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
  });
  await page.route('**/vendor/firebase/firebase-app.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: 'export function initializeApp() { return {}; }',
  }));
  await page.route('**/vendor/firebase/firebase-auth.js', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: FIREBASE_AUTH_STUB,
  }));
  await page.route('**/api/**', (route) => json(route, {}));
  await page.route('**/api/auth/config', (route) => json(route, {
    mode: 'firebase', enabled: true, provider: 'firebase',
    firebase: { apiKey: 'AIzaTESTKEY', authDomain: 'demo-proj.firebaseapp.com', projectId: 'demo-proj', googleEnabled: false, microsoftEnabled: true },
    publicPermissions: { workspace: 'read' },
  }));

  await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });
  const actions = page.locator('.auth-actions .auth-continue');
  await expect(actions).toHaveCount(1);
  await expect(actions.nth(0)).toHaveText('Continue with Microsoft');
  await expect(actions.nth(0)).toHaveClass(/primary/);
  await expect(actions.nth(0)).toHaveClass(/microsoft/);
});
