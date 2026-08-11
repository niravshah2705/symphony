'use strict';

const { test, expect } = require('@playwright/test');

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test('Agent scaffold survives auth restore and inactive route assets stay lazy', async ({ page }) => {
  const assets = [];
  const stalledSeeds = new Set();
  let releaseSeeds;
  const seedGate = new Promise((resolve) => { releaseSeeds = resolve; });
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/js/views/') || path.startsWith('/styles/')) assets.push(path);
  });

  await page.route('**/api/**', (route) => json(route, {}));
  for (const pattern of [
    '**/api/agent/status',
    '**/api/agent/jobs**',
    '**/api/coder',
    '**/api/agent/conversations**',
  ]) {
    await page.route(pattern, async (route) => {
      stalledSeeds.add(new URL(route.request().url()).pathname);
      await seedGate;
      await json(route, route.request().url().includes('conversations') ? { conversations: [] }
        : route.request().url().includes('/jobs') ? { jobs: [] } : {});
    });
  }
  await page.route('**/api/auth/config', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await json(route, { mode: 'disabled', enabled: false });
  });

  const response = await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();

  const hero = page.locator('[data-agent-hero]');
  await expect(hero).toBeVisible();
  const initialHero = await hero.elementHandle();
  expect(initialHero).toBeTruthy();

  await expect.poll(() => stalledSeeds.size).toBeGreaterThan(0);
  await expect(hero).toBeVisible();
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'true');
  releaseSeeds();
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  expect(await initialHero.evaluate((node) => node === document.querySelector('[data-agent-hero]'))).toBe(true);

  const initialViewModules = [...new Set(assets.filter((path) => path.startsWith('/js/views/')))];
  expect(initialViewModules).toEqual(['/js/views/agent.js']);
  expect(assets).toContain('/styles/immersive.css');
  expect(assets).not.toContain('/styles/settings.css');
  expect(assets).not.toContain('/styles/planning.css');
  expect(assets).not.toContain('/styles/operations.css');

  const settingsLink = page.locator('#tabs a[data-route="settings"]');
  await settingsLink.focus();
  await expect(page.locator('link[rel="stylesheet"][href$="/styles/settings.css"]')).toHaveCount(1);
  await page.locator('#tabs a[data-route="agent"]').focus();
  await settingsLink.focus();
  expect(assets.filter((path) => path === '/styles/settings.css')).toHaveLength(1);
});

test('a non-Agent hash never exposes or preloads the Agent scaffold', async ({ page }) => {
  const assets = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/js/views/') || path.startsWith('/styles/')) assets.push(path);
  });
  await page.route('**/api/**', (route) => json(route, {}));
  await page.route('**/api/auth/config', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await json(route, { mode: 'disabled', enabled: false });
  });

  await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-initial-route', 'other');
  await expect(page.locator('[data-initial-agent-view]')).not.toBeVisible();
  expect(assets).not.toContain('/js/views/agent.js');
  expect(assets).not.toContain('/styles/immersive.css');

  await expect(page.locator('link[rel="stylesheet"][href$="/styles/settings.css"]')).toHaveCount(1);
  await expect(page.locator('body')).toHaveAttribute('data-route', 'settings');
  await expect(page.locator('[data-initial-agent-view]')).toHaveCount(0);
  expect(assets).toContain('/js/views/settings.js');
});
