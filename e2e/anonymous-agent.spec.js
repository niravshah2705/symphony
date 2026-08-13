'use strict';

const { test, expect } = require('@playwright/test');

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

const FIREBASE_APP_STUB = 'export function initializeApp() { return {}; }';

// A production-shaped Firebase boot with a resolved, signed-out session. The
// callback is asynchronous because Firebase does not synchronously know the
// persisted browser session when initializeAuth() returns.
const SIGNED_OUT_FIREBASE_STUB = `
  export const browserLocalPersistence = {};
  export const browserPopupRedirectResolver = {};
  export function initializeAuth(_app, options) {
    if (options.persistence !== browserLocalPersistence || 'popupRedirectResolver' in options) throw new Error('unexpected eager auth initialization');
    return { currentUser: null };
  }
  export function onAuthStateChanged(_auth, callback) {
    Promise.resolve().then(() => callback(null));
    return () => {};
  }
  export class GoogleAuthProvider { setCustomParameters() {} }
  export class OAuthProvider { constructor(id) { this.providerId = id; } setCustomParameters() {} }
  export async function signInWithCredential() { return { user: null }; }
  export async function signInWithPopup() { return { user: null }; }
  export async function signOut() {}
`;

function authConfig() {
  return {
    mode: 'firebase',
    enabled: true,
    provider: 'firebase',
    firebase: {
      apiKey: 'AIzaTESTKEY',
      authDomain: 'demo-proj.firebaseapp.com',
      projectId: 'demo-proj',
      googleEnabled: true,
      microsoftEnabled: false,
    },
    publicPermissions: { workspace: 'read' },
  };
}

function apiRecord(request) {
  const url = new URL(request.url());
  let body = null;
  try { body = request.postDataJSON(); } catch (_) { /* no JSON body */ }
  const authorization = request.headers().authorization || '';
  return {
    method: request.method(),
    pathname: url.pathname,
    body,
    authorization: authorization === 'Bearer stale-browser-token'
      ? 'stale'
      : authorization === 'Bearer fresh-browser-token' ? 'fresh' : authorization ? 'other' : 'none',
  };
}

function callLabel(call) {
  return `${call.method} ${call.pathname}`;
}

function isShellRequest(call) {
  return call.pathname === '/api/auth/config'
    || call.pathname === '/api/config'
    || call.pathname.startsWith('/api/locale/');
}

function isTenantPrivateRequest(call) {
  if (call.pathname === '/api/agent/knowledge-search') return false;
  return call.pathname.startsWith('/api/agent/')
    || call.pathname === '/api/coder'
    || call.pathname.startsWith('/api/coder/')
    || call.pathname === '/api/projects'
    || call.pathname.startsWith('/api/projects/')
    || call.pathname === '/api/businesses'
    || call.pathname.startsWith('/api/businesses/')
    || call.pathname === '/api/issues'
    || call.pathname.startsWith('/api/issues/')
    || call.pathname.startsWith('/api/observability/');
}

async function installFirebaseAssets(page, authModule) {
  await page.route('**/vendor/firebase/firebase-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: FIREBASE_APP_STUB,
  }));
  await page.route('**/vendor/firebase/firebase-auth.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: authModule,
  }));
}

/** Let promise continuations, DOM publication, and immediately-started fetches run. */
async function settlePublishedWork(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function installSignedOutHarness(page, { firstPrivateRequestIs401 = false } = {}) {
  const requests = [];
  let sentAuthenticationRequired = false;

  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
    localStorage.setItem('lm.lastWorkspaceRoute', 'agent');
    window.__anonymousAuthRequiredEvents = 0;
    window.addEventListener('ai-fleet:auth-required', () => {
      window.__anonymousAuthRequiredEvents += 1;
    });
  });
  await installFirebaseAssets(page, SIGNED_OUT_FIREBASE_STUB);

  await page.route('**/api/**', (route) => {
    const call = apiRecord(route.request());
    requests.push(call);

    if (call.pathname === '/api/auth/config') return json(route, authConfig());
    if (call.pathname === '/api/config') {
      return json(route, { authenticated: false, status: 'shared', gatewayUrl: '', orgName: '' });
    }
    if (call.pathname === '/api/locale/suggestions') {
      return json(route, {
        locale: 'en',
        suggestions: [{ tag: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' }],
      });
    }
    if (call.pathname === '/api/locale/translate') {
      return json(route, { locale: 'en', translations: call.body?.texts || [] });
    }
    if (call.pathname === '/api/agent/knowledge-search') {
      return json(route, {
        indexedFiles: 1,
        results: [{
          type: 'Workspace document',
          title: 'Public ADLC guide',
          path: 'docs/adlc.md',
          snippet: 'ADLC keeps implementation work behind explicit human approval.',
        }],
      });
    }
    if (call.method === 'GET' && call.pathname === '/api/eula') {
      return json(route, { accepted: false, version: 'test' });
    }

    // The real gateway answers a protected anonymous request with this 401. One
    // such response is enough to expose an erroneous bootstrap/auth transition.
    // Later unexpected calls get a terminal 403 so a broken implementation
    // cannot recursively rerender fast enough to flood the Playwright worker.
    if (firstPrivateRequestIs401 && !sentAuthenticationRequired && isTenantPrivateRequest(call)) {
      sentAuthenticationRequired = true;
      return json(route, { error: 'Authentication required', code: 'authentication_required' }, 401);
    }
    return json(route, { error: 'Private endpoint reached by anonymous browser', code: 'access_denied' }, 403);
  });

  return {
    requests,
    resetRequests() { requests.length = 0; },
  };
}

async function openPublicAgent(page) {
  const response = await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  const workspace = page.locator('.agent-workspace');
  await expect(workspace).toBeVisible();
  await expect(workspace).toHaveAttribute('data-agent-scaffold', 'public');
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('textbox', { name: 'Ask or act from the Agent omnibox' })).toBeEnabled();
  await settlePublishedWork(page);
}

async function sendAgentRequest(page, text) {
  const composer = page.getByRole('textbox', { name: 'Ask or act from the Agent omnibox' });
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('anonymous Firebase Agent boundary', () => {
  test('public Agent hydrates without tenant state requests or 401 auth churn', async ({ page }) => {
    const harness = await installSignedOutHarness(page, { firstPrivateRequestIs401: true });

    await openPublicAgent(page);

    const privateCalls = harness.requests.filter(isTenantPrivateRequest).map(callLabel);
    expect(privateCalls).toEqual([]);
    expect(await page.evaluate(() => window.__anonymousAuthRequiredEvents)).toBe(0);
    await expect(page).toHaveURL(/#\/agent$/);
  });

  test('public knowledge search uses only the reviewed documentation endpoint', async ({ page }) => {
    const harness = await installSignedOutHarness(page);
    await openPublicAgent(page);
    harness.resetRequests();

    const query = 'Search the docs for ADLC human approval';
    await sendAgentRequest(page, query);
    await expect(page.locator('.intent-message[data-agent-intent="knowledge"]')).toBeVisible();
    await settlePublishedWork(page);

    const workspaceCalls = harness.requests.filter((call) => !isShellRequest(call));
    expect(workspaceCalls.map(callLabel)).toEqual(['POST /api/agent/knowledge-search']);
    expect(workspaceCalls[0].body).toEqual({ query });
    await expect(page.locator('#agent-details-panel [data-panel-section="matches"]')).toContainText('Public ADLC guide');
  });

  test('public implementation intent stays read-only and explains that sign-in is required', async ({ page }) => {
    const harness = await installSignedOutHarness(page);
    await openPublicAgent(page);
    harness.resetRequests();

    await sendAgentRequest(page, 'Implement a retry button in the failed-run screen');
    await expect(page.locator('.intent-message[data-agent-intent="implementation"]')).toBeVisible();
    await settlePublishedWork(page);

    const protectedOrMutating = harness.requests.filter((call) => (
      isTenantPrivateRequest(call) || (call.method !== 'GET' && call.pathname !== '/api/agent/knowledge-search')
    ));
    expect(protectedOrMutating.map(callLabel)).toEqual([]);
    await expect(
      page.locator('.conversation-stream, #agent-details-panel').getByText(/sign in/i).first()
    ).toBeVisible();
  });

  test('direct Agent jobs navigation is hidden and gated for a public visitor', async ({ page }) => {
    const harness = await installSignedOutHarness(page);

    const response = await page.goto('/#/agent-jobs', { waitUntil: 'domcontentloaded' });
    expect(response && response.ok()).toBeTruthy();
    await expect(page.locator('.auth-card #auth-title')).toHaveText('Sign in to continue');
    await expect(page.locator('#tabs a[data-route="agent-jobs"]')).toBeHidden();
    await expect(page.locator('.job-history-page')).toHaveCount(0);
    expect(harness.requests.filter((call) => call.pathname.startsWith('/api/agent/jobs')).map(callLabel)).toEqual([]);
  });
});

const SIGNED_IN_FIREBASE_STUB = `
  const user = {
    uid: 'firebase|expiring',
    displayName: 'Expiring Operator',
    email: 'expiring@example.com',
    photoURL: '',
    getIdTokenResult: async () => ({ expirationTime: '2099-01-01T00:00:00.000Z' }),
    getIdToken: async (forceRefresh = false) => {
      if (!forceRefresh) return 'stale-browser-token';
      window.__forcedTokenRefreshes += 1;
      return new Promise((resolve) => { window.__releaseForcedTokenRefresh = () => resolve('fresh-browser-token'); });
    },
  };
  export const browserLocalPersistence = {};
  export const browserPopupRedirectResolver = {};
  export function initializeAuth(_app, options) {
    if (options.persistence !== browserLocalPersistence || 'popupRedirectResolver' in options) throw new Error('unexpected eager auth initialization');
    return { currentUser: user };
  }
  export function onAuthStateChanged(_auth, callback) {
    Promise.resolve().then(() => callback(user));
    return () => {};
  }
  export class GoogleAuthProvider { setCustomParameters() {} }
  export class OAuthProvider { constructor(id) { this.providerId = id; } setCustomParameters() {} }
  export async function signInWithCredential() { return { user }; }
  export async function signInWithPopup() { return { user }; }
  export async function signOut() {}
`;

async function installExpiringSessionHarness(page) {
  const requests = [];
  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
    localStorage.setItem('lm.lastWorkspaceRoute', 'agent');
    window.__forcedTokenRefreshes = 0;
    window.__authRequiredTransitions = 0;
    window.addEventListener('ai-fleet:auth-required', () => {
      window.__authRequiredTransitions += 1;
    });
  });
  await installFirebaseAssets(page, SIGNED_IN_FIREBASE_STUB);

  await page.route('**/api/**', (route) => {
    const call = apiRecord(route.request());
    requests.push(call);

    if (call.pathname === '/api/auth/config') return json(route, authConfig());
    if (call.pathname === '/api/auth/me') {
      return json(route, {
        mode: 'firebase',
        authenticated: true,
        role: 'operator',
        permissions: { workspace: 'write' },
        user: { sub: 'firebase|expiring', name: 'Expiring Operator', email: 'expiring@example.com' },
      });
    }
    if (call.pathname === '/api/org/me/context') {
      return json(route, {
        user: { id: 'firebase|expiring', email: 'expiring@example.com', full_name: 'Expiring Operator' },
        organizations: [{
          id: 'org-expiring',
          name: 'Expiring Org',
          role: 'MEMBER',
          projects: [{ id: 'project-expiring', name: 'Expiring Project', role: 'MEMBER' }],
        }],
      });
    }
    if (call.pathname === '/api/config') {
      return json(route, { authenticated: true, status: 'shared', gatewayUrl: '', orgName: 'Expiring Org' });
    }
    if (call.pathname === '/api/locale/suggestions') {
      return json(route, {
        locale: 'en',
        suggestions: [{ tag: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' }],
      });
    }
    if (call.pathname === '/api/locale/translate') {
      return json(route, { locale: 'en', translations: call.body?.texts || [] });
    }

    if (isTenantPrivateRequest(call)) {
      // Requests from the formerly-authenticated batch are genuine application
      // auth failures. If broken code starts a second anonymous batch, keep its
      // response terminal but non-notifying so this regression remains bounded.
      const code = call.authorization === 'none' ? 'anonymous_request_rejected' : 'authentication_required';
      return json(route, { error: 'Authentication required', code }, 401);
    }
    return json(route, { error: 'Unexpected API request', code: 'access_denied' }, 403);
  });
  return { requests };
}

test('parallel application-auth failures expire an authenticated session once and stop private loading', async ({ page }) => {
  const harness = await installExpiringSessionHarness(page);

  const response = await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();

  // Hold the single-flight refresh pending until all four one-shot workspace
  // seed requests have joined it, then release their shared fresh token.
  await expect.poll(() => harness.requests.filter((call) => (
    isTenantPrivateRequest(call) && call.authorization === 'stale'
  )).length).toBe(4);
  await expect.poll(() => page.evaluate(() => window.__forcedTokenRefreshes)).toBe(1);
  await settlePublishedWork(page);
  await page.evaluate(() => window.__releaseForcedTokenRefresh());

  await expect(page.locator('.agent-workspace')).toHaveAttribute('data-agent-scaffold', 'public');
  await expect(page.locator('#auth-control .auth-sign-in')).toBeVisible();
  await expect(page.locator('#auth-control .auth-user')).toHaveCount(0);
  await settlePublishedWork(page);

  expect(await page.evaluate(() => window.__forcedTokenRefreshes)).toBe(1);
  expect(await page.evaluate(() => window.__authRequiredTransitions)).toBe(1);
  expect(harness.requests.filter((call) => (
    isTenantPrivateRequest(call) && call.authorization === 'none'
  )).map(callLabel)).toEqual([]);
});
