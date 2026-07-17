'use strict';

const { test, expect } = require('@playwright/test');

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test('workspace renders while optional Linear validation is stalled', async ({ page }) => {
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
  await page.route('**/api/locale/suggestions**', (route) => json(route, {
    locale: 'en',
    suggestions: [{ tag: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' }],
  }));
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

  // This is intentionally shorter than the delayed validation. The shell and
  // useful route must paint without waiting on optional integration health.
  await expect(page.locator('.agent-workspace')).toBeVisible({ timeout: 2_000 });
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#route-title')).toHaveText('Agent workspace');
  expect(browserErrors).toEqual([]);
  expect(failedAssets).toEqual([]);
});

test('authentication configuration failure locks the workspace before protected API calls', async ({ page }) => {
  const protectedRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/auth/config') {
      protectedRequests.push(`${request.method()} ${url.pathname}`);
    }
  });
  await page.route('**/api/auth/config', (route) => json(route, {
    mode: 'istio',
    enabled: true,
    provider: 'auth0',
    auth0: {},
  }));

  const response = await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expect(page.locator('.auth-card')).toBeVisible();
  await expect(page.locator('.auth-card .error-banner')).toHaveText('We could not verify your session. Try signing in again.');
  await expect(page.locator('.auth-continue')).toHaveText('Retry');
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  expect(protectedRequests).toEqual([]);
});

test('authenticated Auth0 session adds a bearer token and ignores an unrelated provider 401', async ({ page }) => {
  const authenticatedRequests = [];
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
  await page.route('**/vendor/auth0-spa-js.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: `
      export async function createAuth0Client() {
        return {
          handleRedirectCallback: async () => ({ appState: {} }),
          isAuthenticated: async () => true,
          getTokenSilently: async () => 'browser-access-token',
          getUser: async () => ({ name: 'Ada Operator', email: 'ada@example.com' }),
          loginWithRedirect: async () => {},
          logout: async () => {},
        };
      }
    `,
  }));
  await page.route('**/api/auth/config', (route) => json(route, {
    mode: 'istio',
    enabled: true,
    provider: 'auth0',
    auth0: {
      domain: 'tenant.example.auth0.com',
      clientId: 'browser-client',
      audience: 'https://api.ai-fleet.example.com',
      redirectUri: 'https://fleet.example.com/',
      logoutReturnTo: 'https://fleet.example.com/',
      scope: 'openid profile email',
    },
  }));
  await page.route('**/api/auth/me', (route) => authorizedJson(route, {
    mode: 'istio',
    authenticated: true,
    user: { sub: 'auth0|ada', name: 'Ada Operator', email: 'ada@example.com' },
  }));
  await page.route('**/api/locale/suggestions**', (route) => authorizedJson(route, {
    locale: 'en',
    suggestions: [{ tag: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' }],
  }));
  // This 401 belongs to the Linear connector, not application authentication.
  // It must update connection health without clearing the Auth0 session.
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
});
