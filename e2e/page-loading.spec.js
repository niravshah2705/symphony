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
    localStorage.setItem('ai-fleet.locale', 'en');
    localStorage.setItem('lm.lastWorkspaceRoute', 'agent');
  });
  await page.route('**/api/locale/suggestions**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await json(route, {
      locale: 'en',
      suggestions: [{ tag: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' }],
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

test('authenticated Firebase session adds a bearer token and ignores an unrelated provider 401', async ({ page }) => {
  const authenticatedRequests = [];
  const authStartupRequests = [];
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
  await page.route('**/api/locale/suggestions**', (route) => authorizedJson(route, {
    locale: 'en',
    suggestions: [{ tag: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' }],
  }));
  // This 401 belongs to the Linear connector, not application authentication.
  // It must update connection health without clearing the Firebase session.
  await page.route('**/api/settings', (route) => authorizedJson(route, {
    error: 'Linear credential needs attention',
  }, 401));
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

  const response = await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expect(page.locator('.agent-workspace')).toBeVisible();
  await expect(page.locator('.auth-user')).toContainText('Ada Operator');
  await expect(page.locator('.auth-sign-out')).toBeVisible();
  await expect(page.locator('.auth-card')).toHaveCount(0);
  expect(authenticatedRequests).toContain('GET /api/auth/me');
  expect(authenticatedRequests).toContain('GET /api/settings');
  expect(authStartupRequests[0]).toBe('/api/auth/config');
  expect(authStartupRequests).toContain('/vendor/firebase/firebase-app.js');
  expect(authStartupRequests).toContain('/vendor/firebase/firebase-auth.js');
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

  // /#/settings needs settings:write, so a signed-out visitor gets the sign-in card.
  await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });
  const actions = page.locator('.auth-actions .auth-continue');
  await expect(actions).toHaveCount(2);
  await expect(actions.nth(0)).toHaveText('Continue with Google');
  await expect(actions.nth(1)).toHaveText('Continue with Microsoft');
  await expect(actions.nth(1)).toHaveClass(/microsoft/);

  await actions.nth(1).click(); // sign in with Microsoft → popup → confirm → reload
  await expect(page.locator('.auth-user')).toContainText('Max Operator');
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
