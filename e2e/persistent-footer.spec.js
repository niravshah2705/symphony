'use strict';

const { test, expect } = require('@playwright/test');

const APP_ROUTES = Object.freeze([
  'agent',
  'workflows',
  'agent-jobs',
  'calls',
  'business',
  'projects',
  'board',
  'analytics',
  'cost',
  'troubleshooting',
  'settings',
  'organization',
  'invite',
  'privacy',
  'terms',
]);

const FIREBASE_APP_STUB = 'export function initializeApp() { return {}; }';
const SIGNED_OUT_FIREBASE_STUB = `
  export const browserLocalPersistence = {};
  export const browserPopupRedirectResolver = {};
  export function initializeAuth(_app, options) {
    if (options.persistence !== browserLocalPersistence || 'popupRedirectResolver' in options) throw new Error('unexpected eager auth initialization');
    return { currentUser: null };
  }
  export function onAuthStateChanged(_auth, callback) { Promise.resolve().then(() => callback(null)); return () => {}; }
  export class GoogleAuthProvider { setCustomParameters() {} }
  export class OAuthProvider { constructor(id) { this.providerId = id; } setCustomParameters() {} }
  export async function signInWithCredential() { return { user: null }; }
  export async function signInWithPopup() { return { user: null }; }
  export async function signOut() {}
`;
const SIGNED_IN_FIREBASE_STUB = `
  const user = {
    uid: 'firebase|footer-viewer',
    displayName: 'Footer Viewer',
    email: 'viewer@example.com',
    photoURL: '',
    getIdToken: async () => 'footer-viewer-token',
    getIdTokenResult: async () => ({ expirationTime: '2099-01-01T00:00:00.000Z' }),
  };
  export const browserLocalPersistence = {};
  export const browserPopupRedirectResolver = {};
  export function initializeAuth(_app, options) {
    if (options.persistence !== browserLocalPersistence || 'popupRedirectResolver' in options) throw new Error('unexpected eager auth initialization');
    return { currentUser: user };
  }
  export function onAuthStateChanged(_auth, callback) { Promise.resolve().then(() => callback(user)); return () => {}; }
  export class GoogleAuthProvider { setCustomParameters() {} }
  export class OAuthProvider { constructor(id) { this.providerId = id; } setCustomParameters() {} }
  export async function signInWithCredential() { return { user }; }
  export async function signInWithPopup() { return { user }; }
  export async function signOut() {}
`;

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function disabledApiPayload(request) {
  const url = new URL(request.url());
  const path = url.pathname;

  if (path === '/api/auth/config') return { mode: 'disabled', enabled: false };
  if (path === '/api/settings') {
    return { hasKey: false, planningConfigured: false, planningProvider: 'linear' };
  }
  if (path === '/api/settings/llm-presets') return { presets: [], complexityTiers: [] };
  if (path === '/api/settings/json') return { settings: {} };
  if (path === '/api/settings/codex' || path === '/api/settings/claude') return { connected: false };
  if (path === '/api/roles/assumed') return { assumedRole: null };
  if (path === '/api/roles/members') return { members: [] };
  if (path === '/api/agent/status') return { scheduleEnabled: false, counts: {}, localActiveModel: 'Test model' };
  if (path === '/api/agent/jobs') return { jobs: [] };
  if (path === '/api/agent/conversations') return { conversations: [] };
  if (path === '/api/agent/config') return { config: {} };
  if (path === '/api/agent/models') return { intervals: [5, 10, 15] };
  if (path === '/api/agent/labels') return { labels: [] };
  if (path === '/api/agent/workspace-stream-token') return {};
  if (path === '/api/coder') return { running: false, paused: false, inFlight: [] };
  if (path === '/api/eula') return { accepted: true, version: 'test' };
  if (path === '/api/projects') return { projects: [] };
  if (path === '/api/businesses') return { businesses: [] };
  if (path === '/api/observability/analytics') return { configured: false, summary: {}, changes: [] };
  if (path === '/api/observability/troubleshooting') return { status: 'ok', checks: [] };
  if (path === '/api/billing/summary') {
    return {
      currency: 'INR',
      balancePaise: 0,
      balanceInr: 0,
      initialCreditInr: 0,
      fxUsdToInr: 83,
      sweepEnabled: false,
      isAdmin: false,
      spend: {
        week: { costInr: 0, runs: 0, tokens: 0 },
        month: { costInr: 0, runs: 0, tokens: 0 },
      },
      autoRecharge: { enabled: false },
    };
  }
  if (path === '/api/billing/usage') return { rows: [] };
  if (path === '/api/billing/ledger') return { entries: [] };
  if (path === '/api/org/me') {
    return {
      user_id: 'local-footer-test',
      email: 'local@example.com',
      full_name: 'Local Operator',
      has_organization: false,
      org_id: null,
      org_role: null,
    };
  }
  if (path === '/api/org/me/projects') return { data: [], meta: { total: 0, page: 1, limit: 20 } };
  if (path === '/api/locale/suggestions') return { locale: 'en', suggestions: [] };
  if (path === '/api/locale/translate') {
    let body = {};
    try { body = request.postDataJSON() || {}; } catch (_) { /* no JSON body */ }
    return { locale: body.locale || 'en', translations: body.texts || [] };
  }
  if (path === '/api/settings-policy/settings/universe') return { schemaVersion: 0, harnesses: [], domains: [] };
  if (path === '/api/settings-policy/settings/preflight') return { stages: [] };
  if (path.startsWith('/api/settings-policy/')) return { prefs: {}, locks: [] };
  return {};
}

async function installDisabledAuthStubs(page) {
  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
  });
  await page.route('**/api/**', (route) => json(route, disabledApiPayload(route.request())));
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

async function expectDisabledAuthentication(page) {
  await expect.poll(() => page.evaluate(async () => {
    const { getAuthenticationState } = await import('/js/auth.js');
    return getAuthenticationState().mode;
  })).toBe('disabled');
}

async function expectSingleVisibleFooter(page) {
  const footer = page.locator('footer#app-footer');
  await expect(page.locator('footer')).toHaveCount(1);
  await expect(footer).toBeVisible();
  await expect(page.locator('#view footer#app-footer')).toHaveCount(0);
  await expect(footer.getByText('© 2026 Nirav Shah. All rights reserved.', { exact: true })).toBeVisible();
  return footer;
}

async function expectToastOutsideFooter(page) {
  const geometry = await page.evaluate(() => {
    const toast = document.getElementById('toast').getBoundingClientRect();
    const footer = document.getElementById('app-footer').getBoundingClientRect();
    return {
      toast: { top: toast.top, right: toast.right, bottom: toast.bottom, left: toast.left },
      footer: { top: footer.top, right: footer.right, bottom: footer.bottom, left: footer.left },
      overlaps: !(
        toast.right <= footer.left
        || toast.left >= footer.right
        || toast.bottom <= footer.top
        || toast.top >= footer.bottom
      ),
    };
  });
  expect(geometry.overlaps, `toast ${JSON.stringify(geometry.toast)} overlaps footer ${JSON.stringify(geometry.footer)}`).toBe(false);
}

async function settlePublishedWork(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

test('one stable footer survives view replacement across every application and legal route', async ({ page }) => {
  await installDisabledAuthStubs(page);

  const response = await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expectDisabledAuthentication(page);
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expectSingleVisibleFooter(page);

  await page.evaluate(() => {
    window.__persistentFooterNode = document.getElementById('app-footer');
    window.__previousRouteView = document.getElementById('view');
  });

  for (const routeName of APP_ROUTES) {
    await test.step(`#/${routeName}`, async () => {
      await page.evaluate((name) => { window.location.hash = `#/${name}`; }, routeName);
      await expect(page.locator('body')).toHaveAttribute('data-route', routeName);
      await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');

      const identity = await page.evaluate(() => ({
        footerCount: document.querySelectorAll('footer#app-footer').length,
        footerOutsideView: !document.getElementById('view').contains(document.getElementById('app-footer')),
        sameFooter: document.getElementById('app-footer') === window.__persistentFooterNode,
        viewWasReplaced: document.getElementById('view') !== window.__previousRouteView,
      }));
      expect(identity).toEqual({
        footerCount: 1,
        footerOutsideView: true,
        sameFooter: true,
        viewWasReplaced: true,
      });
      await expect(page.locator('#app-footer')).toBeVisible();
      await page.evaluate(() => { window.__previousRouteView = document.getElementById('view'); });

      if (routeName === 'privacy') {
        await expect(page.locator('.legal-document')).toHaveAttribute('lang', 'en');
        await expect(page.getByRole('heading', { level: 1, name: 'Privacy Notice' })).toBeVisible();
        await expect(page.locator('.legal-document')).toContainText('Draft for qualified legal review');
      }
      if (routeName === 'terms') {
        await expect(page.locator('.legal-document')).toHaveAttribute('lang', 'en');
        await expect(page.getByRole('heading', { level: 1, name: 'End User License Agreement (EULA)' })).toBeVisible();
        await expect(page.locator('.legal-document')).toContainText('Template notice — not legal advice.');
      }
    });
  }
});

test('the non-Agent launcher copies its prompt and remains aligned without narrow-screen overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    window.__adlcCopiedPrompt = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => { window.__adlcCopiedPrompt = text; },
      },
    });
  });
  await installDisabledAuthStubs(page);

  await page.goto('/#/privacy', { waitUntil: 'domcontentloaded' });
  await expectDisabledAuthentication(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Notice' })).toBeVisible();

  const footer = await expectSingleVisibleFooter(page);
  const launcher = footer.locator('.adlc-ai-links');
  const assistantLinks = launcher.locator('a[data-ai-assistant]');
  await expect(launcher).toBeVisible();
  await expect(assistantLinks).toHaveCount(5);
  await expect(launcher.locator('.brand-icon')).toHaveCount(5);

  const targets = await assistantLinks.evaluateAll((links) => links.map((link) => {
    const rect = link.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      label: link.getAttribute('aria-label'),
    };
  }));
  expect(targets).toHaveLength(5);
  for (const target of targets) {
    expect(target.width).toBe(34);
    expect(target.height).toBe(34);
    expect(target.label).toMatch(/^Search ADLC on /);
  }

  const desktop = await footer.evaluate((node) => {
    const launcherNode = node.querySelector('.adlc-ai-links');
    const legalNode = node.querySelector('.footer-legal');
    const sidebarNode = document.getElementById('app-sidebar');
    const footerRect = node.getBoundingClientRect();
    const launcherRect = launcherNode.getBoundingClientRect();
    const legalRect = legalNode.getBoundingClientRect();
    const sidebarRect = sidebarNode.getBoundingClientRect();
    return {
      footerRight: footerRect.right,
      launcherRight: launcherRect.right,
      launcherLeft: launcherRect.left,
      legalLeft: legalRect.left,
      sidebarRight: sidebarRect.right,
      footerLeft: footerRect.left,
      sidebarBottom: sidebarRect.bottom,
      footerBottom: footerRect.bottom,
      justifySelf: getComputedStyle(launcherNode).justifySelf,
    };
  });
  expect(desktop.justifySelf).toBe('end');
  expect(desktop.footerRight - desktop.launcherRight).toBeGreaterThanOrEqual(10);
  expect(desktop.footerRight - desktop.launcherRight).toBeLessThanOrEqual(18);
  expect(desktop.launcherLeft).toBeGreaterThan(desktop.legalLeft);
  expect(Math.abs(desktop.sidebarRight - desktop.footerLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktop.sidebarBottom - desktop.footerBottom)).toBeLessThanOrEqual(1);

  const chatGpt = launcher.locator('[data-ai-assistant="ChatGPT"]');
  await chatGpt.evaluate((link) => link.addEventListener('click', (event) => event.preventDefault(), { once: true }));
  await chatGpt.click();
  await expect.poll(() => page.evaluate(() => window.__adlcCopiedPrompt)).toContain('Agentic Development Life Cycle');
  await expect(page.locator('#toast')).toContainText('Searching ADLC on ChatGPT');
  await expectToastOutsideFooter(page);

  await page.setViewportSize({ width: 320, height: 700 });
  await chatGpt.evaluate((link) => link.addEventListener('click', (event) => event.preventDefault(), { once: true }));
  await chatGpt.click();
  await expect(page.locator('#toast')).toBeVisible();
  await expectToastOutsideFooter(page);
  const mobile = await footer.evaluate((node) => {
    const legal = node.querySelector('.footer-legal').getBoundingClientRect();
    const launcherNode = node.querySelector('.adlc-ai-links');
    const launcherRect = launcherNode.getBoundingClientRect();
    const label = launcherNode.querySelector('.adlc-ai-label').getBoundingClientRect();
    const firstAssistant = launcherNode.querySelector('[data-ai-assistant]').getBoundingClientRect();
    return {
      legalBottom: legal.bottom,
      launcherTop: launcherRect.top,
      labelBottom: label.bottom,
      firstAssistantTop: firstAssistant.top,
      documentOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      footerOverflows: node.scrollWidth > node.clientWidth,
      launcherOverflows: launcherNode.scrollWidth > launcherNode.clientWidth,
      footerLeft: node.getBoundingClientRect().left,
      footerRight: node.getBoundingClientRect().right,
      viewportWidth: window.innerWidth,
    };
  });
  expect(mobile.launcherTop).toBeGreaterThanOrEqual(mobile.legalBottom);
  expect(mobile.firstAssistantTop).toBeGreaterThanOrEqual(mobile.labelBottom);
  expect(mobile.documentOverflows).toBe(false);
  expect(mobile.footerOverflows).toBe(false);
  expect(mobile.launcherOverflows).toBe(false);
  expect(mobile.footerLeft).toBeGreaterThanOrEqual(0);
  expect(mobile.footerRight).toBeLessThanOrEqual(mobile.viewportWidth);
});

test('Cookie Preferences contains keyboard focus and persists analytics opt-out and opt-in across reloads', async ({ page }) => {
  let googleTagRequests = 0;
  await installDisabledAuthStubs(page);
  await page.route('**/config.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: "window.__API_BASE__=''; window.__GA_MEASUREMENT_ID__='G-FOOTER123';",
  }));
  await page.route('https://www.googletagmanager.com/gtag/js**', (route) => {
    googleTagRequests += 1;
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
  });

  await page.goto('/#/privacy', { waitUntil: 'domcontentloaded' });
  await expectDisabledAuthentication(page);
  await expect.poll(() => page.evaluate(() => (
    window.dataLayer?.filter(([command, event]) => command === 'event' && event === 'page_view').length || 0
  ))).toBe(1);
  expect(googleTagRequests).toBe(1);

  const trigger = page.getByRole('button', { name: 'Cookie Preferences' });
  const dialog = page.getByRole('dialog', { name: 'Cookie Preferences' });
  const essential = dialog.locator('#cookie-essential');
  const analytics = dialog.locator('#cookie-analytics');
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const save = dialog.getByRole('button', { name: 'Save preferences' });

  expect(await page.evaluate(() => localStorage.getItem('ai-fleet.analytics-consent'))).toBeNull();
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(essential).toBeChecked();
  await expect(essential).toBeDisabled();
  await expect(analytics).toBeChecked();
  await expect(analytics).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(save).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(analytics).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await analytics.uncheck();
  await page.evaluate(() => {
    document.cookie = '_ga=footer-test; Path=/';
    document.cookie = '_ga_FOOTER=footer-test; Path=/';
  });
  const requestsBeforeOptOut = googleTagRequests;
  const disabledReload = page.waitForEvent('load');
  await save.click();
  await disabledReload;
  await expectDisabledAuthentication(page);
  await expect(page).toHaveURL(/#\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Notice' })).toBeVisible();

  expect(await page.evaluate(() => localStorage.getItem('ai-fleet.analytics-consent'))).toBe('disabled');
  expect(await page.evaluate(() => ({
    hasDataLayer: Object.prototype.hasOwnProperty.call(window, 'dataLayer'),
    hasGtag: Object.prototype.hasOwnProperty.call(window, 'gtag'),
    tagScripts: document.querySelectorAll('script[src^="https://www.googletagmanager.com/gtag/js"]').length,
    gaCookies: document.cookie.split(';').map((part) => part.trim()).filter((part) => /^_ga(?:=|_)/.test(part)),
  }))).toEqual({ hasDataLayer: false, hasGtag: false, tagScripts: 0, gaCookies: [] });
  expect(googleTagRequests).toBe(requestsBeforeOptOut);

  await page.evaluate(() => { window.location.hash = '#/terms'; });
  await expect(page.locator('body')).toHaveAttribute('data-route', 'terms');
  await expect(page.getByRole('heading', { level: 1, name: 'End User License Agreement (EULA)' })).toBeVisible();
  expect(googleTagRequests).toBe(requestsBeforeOptOut);
  expect(await page.evaluate(() => ({
    hasDataLayer: Object.prototype.hasOwnProperty.call(window, 'dataLayer'),
    hasGtag: Object.prototype.hasOwnProperty.call(window, 'gtag'),
  }))).toEqual({ hasDataLayer: false, hasGtag: false });

  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(analytics).not.toBeChecked();
  await analytics.check();
  const requestsBeforeOptIn = googleTagRequests;
  const enabledReload = page.waitForEvent('load');
  await save.click();
  await enabledReload;
  await expectDisabledAuthentication(page);
  await expect(page).toHaveURL(/#\/terms$/);
  await expect.poll(() => googleTagRequests).toBe(requestsBeforeOptIn + 1);
  await expect.poll(() => page.evaluate(() => (
    window.dataLayer?.filter(([command, event]) => command === 'event' && event === 'page_view').length || 0
  ))).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('ai-fleet.analytics-consent'))).toBe('enabled');
  expect(await page.evaluate(() => ({
    hasDataLayer: Array.isArray(window.dataLayer),
    hasGtag: typeof window.gtag === 'function',
  }))).toEqual({ hasDataLayer: true, hasGtag: true });
});

test('Cookie Preferences reports a storage failure without changing consent or reloading', async ({ page }) => {
  await installDisabledAuthStubs(page);
  await page.goto('/#/privacy', { waitUntil: 'domcontentloaded' });
  await expectDisabledAuthentication(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Notice' })).toBeVisible();

  await page.evaluate(() => {
    const originalSetItem = Storage.prototype.setItem;
    window.__cookiePreferenceDocument = document;
    window.__consentUpdateCalls = [];
    window.gtag = (...args) => { window.__consentUpdateCalls.push(args); };
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === 'ai-fleet.analytics-consent') {
        throw new DOMException('Storage is blocked for this test.', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    };
  });

  const trigger = page.getByRole('button', { name: 'Cookie Preferences' });
  const dialog = page.getByRole('dialog', { name: 'Cookie Preferences' });
  const analytics = dialog.locator('#cookie-analytics');
  const save = dialog.getByRole('button', { name: 'Save preferences' });
  const error = dialog.getByRole('alert');

  await trigger.click();
  await expect(dialog).toBeVisible();
  await analytics.uncheck();
  await save.click();

  await expect(dialog).toBeVisible();
  await expect(error).toBeVisible();
  await expect(error).toHaveText('We could not save your choice. Check browser storage settings and try again.');
  await expect(save).toBeEnabled();
  await expect(save).toBeFocused();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => ({
    sameDocument: document === window.__cookiePreferenceDocument,
    consent: localStorage.getItem('ai-fleet.analytics-consent'),
    consentUpdates: window.__consentUpdateCalls,
    dialogOpen: document.getElementById('cookie-preferences-dialog').open,
  }))).toEqual({ sameDocument: true, consent: null, consentUpdates: [], dialogOpen: true });
});

test('the footer is visible while authentication configuration is loading', async ({ page }) => {
  let releaseConfiguration;
  const configurationGate = new Promise((resolve) => { releaseConfiguration = resolve; });
  await page.route('**/api/**', (route) => json(route, disabledApiPayload(route.request())));
  await page.route('**/api/auth/config', async (route) => {
    await configurationGate;
    return json(route, { mode: 'disabled', enabled: false });
  });

  await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.auth-progress')).toBeVisible();
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'true');
  await expectSingleVisibleFooter(page);

  releaseConfiguration();
  await expectDisabledAuthentication(page);
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
});

test('a stalled auth failure follows a privacy-to-application hash transition', async ({ page }) => {
  let releaseConfiguration;
  const configurationGate = new Promise((resolve) => { releaseConfiguration = resolve; });
  await page.route('**/api/auth/config', async (route) => {
    await configurationGate;
    return json(route, { error: 'Authentication configuration is unavailable.' }, 503);
  });

  await page.goto('/#/privacy', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Notice' })).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/settings'; });
  await expect(page.locator('body')).toHaveAttribute('data-route', 'settings');

  const rejected = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/auth/config' && response.status() === 503
  ));
  releaseConfiguration();
  await rejected;
  await settlePublishedWork(page);

  await expect(page.locator('body')).toHaveAttribute('data-route', 'authentication');
  await expect(page.locator('.auth-card .error-banner')).toHaveText('We could not verify your session. Try signing in again.');
  await expect(page.locator('.auth-continue')).toHaveText('Retry');
  await expectSingleVisibleFooter(page);
});

test('a stalled auth failure preserves an application-to-privacy hash transition', async ({ page }) => {
  let releaseConfiguration;
  const configurationGate = new Promise((resolve) => { releaseConfiguration = resolve; });
  await page.route('**/api/auth/config', async (route) => {
    await configurationGate;
    return json(route, { error: 'Authentication configuration is unavailable.' }, 503);
  });

  await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.auth-progress')).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#/privacy'; });
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Notice' })).toBeVisible();

  const rejected = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/auth/config' && response.status() === 503
  ));
  releaseConfiguration();
  await rejected;
  await settlePublishedWork(page);

  await expect(page.locator('body')).toHaveAttribute('data-route', 'privacy');
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Notice' })).toBeVisible();
  await expect(page.locator('.auth-card .error-banner')).toHaveCount(0);
  await expectSingleVisibleFooter(page);
});

test('the footer remains available on an authentication configuration error', async ({ page }) => {
  await page.route('**/api/auth/config', (route) => json(route, {
    mode: 'firebase',
    enabled: true,
    provider: 'firebase',
    firebase: {},
  }));

  await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.auth-card .error-banner')).toHaveText('We could not verify your session. Try signing in again.');
  await expect(page.locator('.auth-continue')).toHaveText('Retry');
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expectSingleVisibleFooter(page);
});

test('the footer remains available on the signed-out sign-in screen', async ({ page }) => {
  await installFirebaseAssets(page, SIGNED_OUT_FIREBASE_STUB);
  await page.route('**/api/auth/config', (route) => json(route, {
    mode: 'firebase',
    enabled: true,
    provider: 'firebase',
    firebase: {
      apiKey: 'AIzaTESTKEY',
      authDomain: 'demo.firebaseapp.com',
      projectId: 'demo',
      googleEnabled: true,
    },
    publicPermissions: { workspace: 'read' },
  }));

  await page.goto('/#/agent-jobs', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.auth-card #auth-title')).toHaveText('Sign in to continue');
  await expectSingleVisibleFooter(page);
});

test('the footer remains available on an authenticated access-denied screen', async ({ page }) => {
  await installFirebaseAssets(page, SIGNED_IN_FIREBASE_STUB);
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/config') {
      return json(route, {
        mode: 'firebase',
        enabled: true,
        provider: 'firebase',
        firebase: {
          apiKey: 'AIzaTESTKEY',
          authDomain: 'demo.firebaseapp.com',
          projectId: 'demo',
        },
      });
    }
    if (path === '/api/auth/me') {
      return json(route, {
        authenticated: true,
        role: 'viewer',
        permissions: { workspace: 'read' },
        user: { sub: 'firebase|footer-viewer', name: 'Footer Viewer', email: 'viewer@example.com' },
      });
    }
    if (path === '/api/org/me/context') {
      return json(route, {
        user: { id: 'firebase|footer-viewer', email: 'viewer@example.com', full_name: 'Footer Viewer' },
        organizations: [{
          id: 'org-footer',
          name: 'Footer Org',
          role: 'MEMBER',
          projects: [],
        }],
      });
    }
    if (path === '/api/config') {
      return json(route, { authenticated: true, status: 'shared', gatewayUrl: '', orgName: 'Footer Org' });
    }
    return json(route, {});
  });

  await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 2, name: 'You do not have access' })).toBeVisible();
  await expectSingleVisibleFooter(page);
});
