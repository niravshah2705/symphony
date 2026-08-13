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
