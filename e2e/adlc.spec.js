'use strict';

const { test, expect } = require('@playwright/test');

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test('ADLC landing renders without an auth prompt and links to the workspace', async ({ page }) => {
  await page.route('**/api/**', (route) => json(route, {}));
  await page.route('**/api/auth/config', (route) => json(route, { mode: 'disabled', enabled: false }));

  const response = await page.goto('/adlc/', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expect(page.locator('h1')).toContainText('Ship software with agents');
  await expect(page.locator('.auth-card')).toHaveCount(0);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/adlc/manifest.webmanifest');

  await page.locator('[data-try-now]').first().click();
  await expect(page).toHaveURL(/\/#\/agent$/);
  await expect(page.locator('.agent-workspace')).toBeVisible();
});

test('ADLC manifest is served as a static resource', async ({ request }) => {
  const response = await request.get('/adlc/manifest.webmanifest');
  expect(response.ok()).toBeTruthy();
  expect(response.headers()['content-type']).toContain('manifest');
  const manifest = await response.json();
  expect(manifest.start_url).toBe('/adlc/');
  expect(manifest.scope).toBe('/adlc/');
});

test('existing Agent workspace route still renders directly', async ({ page }) => {
  await page.route('**/api/**', (route) => json(route, {}));
  await page.route('**/api/auth/config', (route) => json(route, { mode: 'disabled', enabled: false }));

  const response = await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expect(page.locator('.agent-workspace')).toBeVisible();
  await expect(page.locator('#route-title')).toHaveText('Agent workspace');
});
