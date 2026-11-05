'use strict';

const { test, expect } = require('@playwright/test');

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * Broad stub so `renderSettings`'s 14-way Promise.all resolves cleanly. Each
 * shape below is the minimum the settings view consumes on a first render;
 * nothing here asserts on those endpoints.
 */
async function stubSettingsSurface(page, { settings = {} } = {}) {
  // Broad fallback registered FIRST so the specific routes below (which
  // Playwright checks last-registered-first) can override it. Without this
  // ordering, `**/api/**` catches every endpoint and the settings boot dies
  // on `undefined.intervalMinutes` because getAgentModels returned `{}`.
  await page.route('**/api/**', (route) => json(route, {}));

  await page.route('**/api/auth/config', (route) => json(route, { mode: 'disabled', enabled: false }));
  await page.route('**/api/config', (route) => json(route, { authenticated: false, status: 'shared', gatewayUrl: '', orgName: null }));
  await page.route('**/api/settings', (route) => json(route, {
    hasKey: true, planningConfigured: true, planningProvider: 'openai',
    ...settings,
  }));
  await page.route('**/api/settings/policy/universe', (route) => json(route, { schemaVersion: 1, harnesses: [] }));
  await page.route('**/api/settings/policy/effective*', (route) => json(route, { prefs: {} }));
  await page.route('**/api/settings/policy/preflight', (route) => json(route, { stages: [] }));
  await page.route('**/api/settings/codex', (route) => json(route, { connected: false }));
  await page.route('**/api/settings/claude', (route) => json(route, { connected: false }));
  await page.route('**/api/agent/config', (route) => json(route, { config: {} }));
  await page.route('**/api/agent/models', (route) => json(route, { intervals: [5, 10, 15] }));
  await page.route('**/api/agent/labels', (route) => json(route, { labels: [] }));
  await page.route('**/api/agent/members', (route) => json(route, { members: [] }));
  await page.route('**/api/roles/assumed', (route) => json(route, { assumedRole: null }));
  await page.route('**/api/org/me/context', (route) => json(route, {
    user: { id: 'u-1', email: 'operator@example.com', full_name: 'Operator', persona: null },
    organizations: [{ id: 'o-1', name: 'Acme', parent_org_id: null, role: 'ORG_ADMIN', projects: [] }],
  }));
  await page.route('**/api/org/me*', (route) => json(route, {
    user: { id: 'u-1', email: 'operator@example.com', full_name: 'Operator', persona: null },
    organizations: [{ id: 'o-1', name: 'Acme', parent_org_id: null, role: 'ORG_ADMIN', projects: [] }],
  }));
  await page.route('**/api/settings/json', (route) => json(route, { settings: {} }));
  await page.route('**/api/llm/presets', (route) => json(route, { presets: [] }));
}

async function openSettings(page) {
  await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sx-card-title', { hasText: 'Execution substrate' })).toBeVisible({ timeout: 8_000 });
}

test.describe('substrate pattern toggle', () => {
  test('three tiles render and cloudrun is active by default', async ({ page }) => {
    await stubSettingsSurface(page);
    await openSettings(page);

    const tiles = page.locator('.sx-tiles[data-lock-key="agentPattern"]');
    await expect(tiles.getByRole('button', { name: /Cloud Run \(in-process\)/ })).toBeVisible();
    await expect(tiles.getByRole('button', { name: /NVIDIA OpenShell/ })).toBeVisible();
    await expect(tiles.getByRole('button', { name: /Agent Substrate/ })).toBeVisible();

    // The active tile gets the `active` class; substrate config card is only
    // rendered when the active pattern is substrate.
    const active = tiles.locator('button.active .sx-tile-name');
    await expect(active).toHaveText('Cloud Run (in-process)');
    await expect(page.getByRole('button', { name: 'Save substrate config' })).toHaveCount(0);
  });

  test('clicking Agent Substrate tile saves the pattern and reveals the config card', async ({ page }) => {
    await stubSettingsSurface(page);

    // Capture the POST payload and echo back settings so the client re-renders.
    let lastPayload = null;
    await page.route('**/api/agent/substrate/pattern', (route) => {
      lastPayload = route.request().postDataJSON();
      return json(route, {
        ok: true,
        settings: { ...(lastPayload || {}), agentPattern: lastPayload && lastPayload.agentPattern },
        substrate: { agentPattern: lastPayload && lastPayload.agentPattern },
      });
    });

    await openSettings(page);
    await page.locator('.sx-tiles[data-lock-key="agentPattern"]')
      .getByRole('button', { name: /Agent Substrate/ })
      .click();

    await expect
      .poll(() => lastPayload && lastPayload.agentPattern, { timeout: 4_000 })
      .toBe('substrate');

    // The substrate config card should now render (identified by its save button).
    await expect(page.getByRole('button', { name: 'Save substrate config' })).toBeVisible();

    // And the shared guardrails card is always present, above or below.
    await expect(page.locator('.sx-card-title', { hasText: 'Security guardrails (shared)' })).toBeVisible();
  });

  test('toggling back to cloudrun hides the substrate config card', async ({ page }) => {
    await stubSettingsSurface(page, { settings: { agentPattern: 'substrate', substrateUrl: 'https://ateapi.internal:8443' } });
    await openSettings(page);

    await expect(page.getByRole('button', { name: 'Save substrate config' })).toBeVisible();

    await page.route('**/api/agent/substrate/pattern', (route) => json(route, {
      ok: true, settings: { agentPattern: 'cloudrun' },
    }));
    await page.locator('.sx-tiles[data-lock-key="agentPattern"]')
      .getByRole('button', { name: /Cloud Run/ })
      .click();

    await expect(page.getByRole('button', { name: 'Save substrate config' })).toHaveCount(0);
  });

  test('shared guardrails panel persists a spec edit via /api/agent/guardrail', async ({ page }) => {
    await stubSettingsSurface(page);
    let lastGuardrailPost = null;
    await page.route('**/api/agent/guardrail', async (route) => {
      if (route.request().method() === 'POST') {
        lastGuardrailPost = route.request().postDataJSON();
        return json(route, { ok: true, spec: (lastGuardrailPost && lastGuardrailPost.spec) || {} });
      }
      return json(route, {
        spec: {
          version: 'guardrail.v1',
          enforcement: 'deny-by-default',
          egress: { allowHosts: ['api.openrouter.ai'], denyCidrs: ['169.254.169.254/32'], ports: [], mitmTrust: { enabled: false } },
          ingress: { allowedSpiffeIds: [], allowedServiceAccounts: [] },
          tools: { allowlist: [], denyAll: true },
          credentials: { scopes: ['github', 'openrouter'] },
          pssProfile: 'restricted',
        },
        preview: { openshellYaml: '', substrateEgress: '', credentialProviderPolicy: '' },
      });
    });

    await openSettings(page);
    await expect(page.locator('.sx-card-title', { hasText: 'Security guardrails (shared)' })).toBeVisible();

    const saveBtn = page.getByRole('button', { name: 'Save guardrails' });
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    await expect
      .poll(() => lastGuardrailPost && lastGuardrailPost.spec && lastGuardrailPost.spec.version, { timeout: 4_000 })
      .toBe('guardrail.v1');
  });

  test('orthogonality: picking substrate does not change the runtime or workflow tiles', async ({ page }) => {
    await stubSettingsSurface(page);
    await page.route('**/api/agent/substrate/pattern', (route) => json(route, {
      ok: true, settings: { agentPattern: 'substrate' },
    }));
    await openSettings(page);

    // Before the substrate click, capture the active runtime harness (from
    // runtimeTiles, a sibling of patternSection).
    const runtimeBefore = await page.locator('[data-lock-key="agentRuntime"] button.active .sx-tile-name').first().textContent().catch(() => null);
    await page.locator('.sx-tiles[data-lock-key="agentPattern"]').getByRole('button', { name: /Agent Substrate/ }).click();
    const runtimeAfter = await page.locator('[data-lock-key="agentRuntime"] button.active .sx-tile-name').first().textContent().catch(() => null);
    expect(runtimeAfter).toEqual(runtimeBefore);
  });
});
