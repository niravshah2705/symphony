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
  await page.addInitScript(() => {
    window.__adlcCopiedPrompt = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => { window.__adlcCopiedPrompt = text; },
      },
    });
  });
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
  const aiLauncher = page.locator('.adlc-ai-links');
  await expect(hero).toBeVisible();
  await expect(aiLauncher).toBeVisible();
  await expect(aiLauncher.locator('a[data-ai-assistant]')).toHaveCount(4);
  await expect(aiLauncher.locator('.brand-icon')).toHaveCount(4);
  const initialHero = await hero.elementHandle();
  const initialAiLauncher = await aiLauncher.elementHandle();
  expect(initialHero).toBeTruthy();
  expect(initialAiLauncher).toBeTruthy();

  await expect.poll(() => stalledSeeds.size).toBeGreaterThan(0);
  await expect(hero).toBeVisible();
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'true');
  releaseSeeds();
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  expect(await initialHero.evaluate((node) => node === document.querySelector('[data-agent-hero]'))).toBe(true);
  expect(await initialAiLauncher.evaluate((node) => node === document.querySelector('.adlc-ai-links'))).toBe(true);
  const assistantTargets = await aiLauncher.locator('a[data-ai-assistant]').evaluateAll((links) => links.map((link) => {
    const rect = link.getBoundingClientRect();
    return { width: rect.width, height: rect.height, label: link.getAttribute('aria-label') };
  }));
  expect(assistantTargets.every((target) => target.width >= 34 && target.height >= 34 && target.label)).toBe(true);
  const chatGptLink = aiLauncher.locator('[data-ai-assistant="ChatGPT"]');
  await chatGptLink.evaluate((link) => link.addEventListener('click', (event) => event.preventDefault(), { once: true }));
  await chatGptLink.click();
  await expect.poll(() => page.evaluate(() => window.__adlcCopiedPrompt)).toContain('Agentic Development Life Cycle');
  await expect(page.locator('#toast')).toContainText('ADLC prompt copied');

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

  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  const overflow = await aiLauncher.evaluate((node) => ({
    launcher: node.scrollWidth > node.clientWidth,
    document: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  expect(overflow).toEqual({ launcher: false, document: false });
  if (desktopViewport) await page.setViewportSize(desktopViewport);
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

  // A later Agent mount rebuilds the scaffold, including the same compact
  // discovery launcher and locally rendered provider icons.
  await page.evaluate(() => { window.location.hash = '#/agent/new'; });
  await expect(page.locator('body')).toHaveAttribute('data-route', 'agent');
  await expect(page.locator('.adlc-ai-links')).toHaveCount(1);
  await expect(page.locator('.adlc-ai-links a[data-ai-assistant]')).toHaveCount(4);
  await expect(page.locator('.adlc-ai-links .brand-icon')).toHaveCount(4);
});

test('SEO and AI discovery resources bypass the SPA fallback', async ({ request }) => {
  const resources = [
    ['/robots.txt', 'text/plain', 'User-agent: OAI-SearchBot'],
    ['/sitemap.xml', 'xml', '<urlset'],
    ['/llms.txt', 'text/plain', 'Agentic Development Life Cycle'],
    ['/llms-full.txt', 'text/plain', '## Lifecycle'],
  ];

  for (const [url, contentType, expected] of resources) {
    const response = await request.get(url);
    expect(response.ok(), `${url} should be served as a static file`).toBeTruthy();
    expect(response.headers()['content-type']).toContain(contentType);
    const body = await response.text();
    expect(body).toContain(expected);
    expect(body).not.toContain('<!DOCTYPE html>');
  }
});
