'use strict';

const { test, expect } = require('@playwright/test');

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test('a terminal workspace stream-token rejection never opens or retries the SSE stream', async ({ page }) => {
  const tokenRequests = [];
  const streamRequests = [];

  // Register the broader stream matcher first. Playwright evaluates matching
  // routes in reverse registration order, so the token-specific handler below
  // wins for /workspace-stream-token.
  await page.route('**/api/agent/workspace-stream**', (route) => {
    streamRequests.push(route.request().url());
    return json(route, { error: 'Invalid or expired stream token.' }, 401);
  });
  await page.route('**/api/agent/workspace-stream-token**', (route) => {
    tokenRequests.push(route.request().headers());
    return json(route, {
      error: 'You do not have permission to access this resource',
      code: 'access_denied',
    }, 403);
  });

  // Use a same-origin static document so importing api.js does not boot the SPA.
  // This isolates openStream from the Agent and notification stream consumers.
  await page.goto('/llms.txt', { waitUntil: 'domcontentloaded' });
  const outcome = await page.evaluate(async () => {
    window.__openedWorkspaceStreams = [];
    window.EventSource = class FakeEventSource {
      constructor(url) { window.__openedWorkspaceStreams.push(String(url)); }
      close() {}
    };
    const { api, setAccessTokenProvider, setRequestContext } = await import('/js/api.js');
    setAccessTokenProvider(async () => 'authenticated-test-token');
    setRequestContext({ organizationId: 'org-acme', projectId: 'project-atlas' });

    try {
      window.__workspaceStreamTestController = await api.openWorkspaceStream(() => {});
      return { rejected: false };
    } catch (error) {
      return {
        rejected: true,
        status: error.status,
        code: error.code,
      };
    }
  });

  // The old implementation opened an empty-token EventSource after the 403 and
  // re-minted after a one-second backoff. Wait past that boundary before asserting.
  await page.waitForTimeout(1_750);
  await page.evaluate(() => window.__workspaceStreamTestController?.close());

  expect.soft(outcome).toEqual({ rejected: true, status: 403, code: 'access_denied' });
  expect.soft(tokenRequests).toHaveLength(1);
  expect(tokenRequests[0].authorization).toBe('Bearer authenticated-test-token');
  expect(tokenRequests[0]['x-ai-fleet-organization-id']).toBe('org-acme');
  expect(tokenRequests[0]['x-ai-fleet-project-id']).toBe('project-atlas');
  expect(await page.evaluate(() => window.__openedWorkspaceStreams)).toEqual([]);
  expect.soft(streamRequests).toEqual([]);
});

test('a blank minted token never opens the workspace SSE stream', async ({ page }) => {
  let tokenRequests = 0;
  const streamRequests = [];

  await page.route('**/api/agent/workspace-stream**', (route) => {
    streamRequests.push(route.request().url());
    return json(route, { error: 'Invalid or expired stream token.' }, 401);
  });
  await page.route('**/api/agent/workspace-stream-token**', (route) => {
    tokenRequests += 1;
    return json(route, { token: '   ' });
  });

  await page.goto('/llms.txt', { waitUntil: 'domcontentloaded' });
  const outcome = await page.evaluate(async () => {
    window.__openedWorkspaceStreams = [];
    window.EventSource = class FakeEventSource {
      constructor(url) { window.__openedWorkspaceStreams.push(String(url)); }
      close() {}
    };
    const { api, setAccessTokenProvider, setRequestContext } = await import('/js/api.js');
    setAccessTokenProvider(async () => 'authenticated-test-token');
    setRequestContext({ organizationId: 'org-acme', projectId: 'project-atlas' });

    try {
      await api.openWorkspaceStream(() => {});
      return { rejected: false };
    } catch (error) {
      return { rejected: true, code: error.code, message: error.message };
    }
  });

  expect(outcome).toEqual({
    rejected: true,
    code: 'stream_token_missing',
    message: 'Stream token is unavailable.',
  });
  expect(tokenRequests).toBe(1);
  expect(await page.evaluate(() => window.__openedWorkspaceStreams)).toEqual([]);
  expect(streamRequests).toEqual([]);
});

// A FakeEventSource that stays open (never used for the token-rejection tests
// above) so the reconnect circuit breaker's `onopen`/`onerror` interplay can
// be driven manually from the test, with Playwright's Clock virtualizing
// Date.now()/setTimeout so backoff delays and the 60s health threshold don't
// require real waiting.
async function setUpFlappingHarness(page) {
  // Register the broader stream matcher first. Playwright evaluates matching
  // routes in reverse registration order, so the token-specific handler below
  // wins for /workspace-stream-token.
  await page.route('**/api/agent/workspace-stream**', (route) => route.abort());
  await page.route('**/api/agent/workspace-stream-token**', (route) =>
    json(route, { token: 'tok', organizationId: 'org-acme', projectId: 'project-atlas' }));

  await page.clock.install();
  await page.goto('/llms.txt', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    window.__sources = [];
    window.EventSource = class FakeEventSource {
      constructor(url) {
        this.url = String(url);
        this.onopen = null;
        this.onerror = null;
        window.__sources.push(this);
      }
      close() {}
    };
    const { api, setAccessTokenProvider, setRequestContext } = await import('/js/api.js');
    setAccessTokenProvider(async () => 'authenticated-test-token');
    setRequestContext({ organizationId: 'org-acme', projectId: 'project-atlas' });
    window.__ctrl = await api.openWorkspaceStream(() => {});
  });
}

// Fires onopen immediately, then onerror before the 60s health threshold
// elapses ("flapping"), then advances the clock past the max 30s backoff so
// any scheduled reconnect fires. Returns the current EventSource count.
async function flapLatestSource(page) {
  await page.evaluate(() => {
    const source = window.__sources[window.__sources.length - 1];
    source.onopen();
    source.onerror();
  });
  await page.clock.fastForward(31_000);
  // fastForward only guarantees the fake setTimeout fired; the reconnect it
  // triggers mints a token over a real (mocked) fetch, which resolves on real
  // wall-clock microtasks the fake clock doesn't drive. Give it a moment.
  await page.waitForTimeout(100);
  return page.evaluate(() => window.__sources.length);
}

test('a stream that flaps (dies before 60s) on every open stops reconnecting after 6 failures', async ({ page }) => {
  await setUpFlappingHarness(page);
  expect(await page.evaluate(() => window.__sources.length)).toBe(1);

  const counts = [];
  for (let i = 0; i < 8; i += 1) {
    counts.push(await flapLatestSource(page));
  }

  // 1 initial connection + 6 reconnects (the failure cap) = 7, then no more.
  expect(counts).toEqual([2, 3, 4, 5, 6, 7, 7, 7]);
});

test('a connection that stays open past the 60s health threshold resets the failure budget', async ({ page }) => {
  await setUpFlappingHarness(page);

  // Five quick flaps bring the failure count to 5 — one short of the cap.
  for (let i = 0; i < 5; i += 1) {
    await flapLatestSource(page);
  }
  expect(await page.evaluate(() => window.__sources.length)).toBe(6);

  // This connection stays open well past the health threshold before erroring.
  await page.evaluate(() => window.__sources[window.__sources.length - 1].onopen());
  await page.clock.fastForward(61_000);
  await page.evaluate(() => window.__sources[window.__sources.length - 1].onerror());
  await page.clock.fastForward(31_000);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__sources.length)).toBe(7);

  // If the healthy connection reset the failure budget, a full fresh run of 6
  // more flaps is needed to exhaust it again (5 succeed, the 6th is refused) —
  // not just the 1 remaining slot from before the healthy connection.
  const counts = [];
  for (let i = 0; i < 6; i += 1) {
    counts.push(await flapLatestSource(page));
  }
  expect(counts).toEqual([8, 9, 10, 11, 12, 12]);

  await page.evaluate(() => window.__ctrl?.close());
});
