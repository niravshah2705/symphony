'use strict';

const { test, expect } = require('@playwright/test');

const USER_ID = 'firebase|workflow-operator';
const PRIMARY_ORG = Object.freeze({
  id: 'org-acme',
  name: 'Acme Platform',
  role: 'ORG_ADMIN',
  projects: [],
});
const SECONDARY_ORG = Object.freeze({
  id: 'org-beta-labs',
  name: 'Beta Labs',
  role: 'ORG_ADMIN',
  projects: [],
});
const STORAGE_PREFIX = 'ai-fleet.workflow-designer.v1:';

const FIREBASE_AUTH_STUB = `
  const user = {
    uid: '${USER_ID}',
    displayName: 'Workflow Operator',
    email: 'workflow@example.com',
    photoURL: '',
    getIdToken: async () => 'browser-access-token',
  };
  export const browserLocalPersistence = {};
  export const browserPopupRedirectResolver = {};
  export function initializeAuth(_app, options) {
    if (options.persistence !== browserLocalPersistence || 'popupRedirectResolver' in options) {
      throw new Error('unexpected eager auth initialization');
    }
    return { currentUser: user };
  }
  export function onAuthStateChanged(_auth, callback) {
    Promise.resolve().then(() => callback(user));
    return () => {};
  }
  export class GoogleAuthProvider { static credential() { return {}; } setCustomParameters() {} }
  export class OAuthProvider { credential() { return {}; } setCustomParameters() {} }
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

function workflowStorageKey(organizationId) {
  return `${STORAGE_PREFIX}${organizationId}`;
}

async function installDesignerStubs(page, {
  organizations = [PRIMARY_ORG],
  permissions = { org: 'read' },
} = {}) {
  const apiMutations = [];
  const workflowApiRequests = [];

  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
  });
  await page.route('**/vendor/firebase/firebase-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: 'export function initializeApp() { return {}; }',
  }));
  await page.route('**/vendor/firebase/firebase-auth.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: FIREBASE_AUTH_STUB,
  }));
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') apiMutations.push(`${request.method()} ${pathname}`);
    if (/workflow/i.test(pathname)) workflowApiRequests.push(`${request.method()} ${pathname}`);

    if (pathname === '/api/auth/config') {
      return json(route, {
        mode: 'firebase',
        enabled: true,
        provider: 'firebase',
        firebase: {
          apiKey: 'AIzaTESTKEY',
          authDomain: 'demo-proj.firebaseapp.com',
          projectId: 'demo-proj',
        },
      });
    }
    if (pathname === '/api/auth/me') {
      return json(route, {
        authenticated: true,
        role: 'viewer',
        permissions,
        user: {
          sub: USER_ID,
          name: 'Workflow Operator',
          email: 'workflow@example.com',
        },
      });
    }
    if (pathname === '/api/org/me/context') {
      return json(route, {
        user: {
          id: USER_ID,
          email: 'workflow@example.com',
          full_name: 'Workflow Operator',
        },
        organizations,
      });
    }
    if (pathname === '/api/config') {
      return json(route, {
        authenticated: true,
        status: 'shared',
        gatewayUrl: '',
        orgName: organizations[0]?.name || null,
      });
    }
    if (pathname === '/api/locale/suggestions') {
      return json(route, { locale: 'en', recommendedLocale: 'en' });
    }
    if (pathname === '/api/agent/workspace-stream-token') {
      return json(route, { token: 'workflow-stream-token' });
    }
    if (pathname === '/api/agent/workspace-stream') {
      return route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
        },
        body: ': ready\n\n',
      });
    }
    return json(route, {});
  });

  return { apiMutations, workflowApiRequests };
}

async function openDesigner(page) {
  const response = await page.goto('/#/workflows', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.workflow-page')).toBeVisible();
}

function profileField(form, name) {
  return form.locator('.workflow-field', { hasText: new RegExp(`^${name}`) })
    .locator('input, textarea, select')
    .first();
}

async function selectCanvasNode(page, name) {
  const node = page.locator('.workflow-node').filter({ hasText: name });
  await expect(node).toHaveCount(1);
  await node.focus();
  await node.press('Enter');
  await expect(page.locator('.workflow-inspector .workflow-panel-header')).toContainText(name);
  await expect(node).toBeFocused();
  return node;
}

async function expectNoWorkflowBackendCalls(recording) {
  expect(recording.workflowApiRequests).toEqual([]);
  expect(recording.apiMutations).toEqual([]);
}

test('lazy Workflows route renders the selected organization and five realistic examples', async ({ page }) => {
  const assets = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/js/views/') || pathname.startsWith('/styles/')) assets.push(pathname);
  });
  const recording = await installDesignerStubs(page);

  await openDesigner(page);

  await expect(page.locator('.workflow-page')).toHaveAttribute('data-organization-id', PRIMARY_ORG.id);
  await expect(page.locator('.workflow-page')).toHaveAttribute('data-editable', 'true');
  await expect(page.getByRole('heading', { name: 'Acme Platform workflows' })).toBeVisible();
  await expect(page.getByText('Does not execute', { exact: true })).toBeVisible();

  const workflowSelect = page.getByRole('combobox', { name: 'Active workflow' });
  await expect(workflowSelect.locator('option')).toHaveCount(5);
  expect(await workflowSelect.locator('option').allTextContents()).toEqual([
    'Environment release · example',
    'Research to decision · example',
    'Commercial launch · example',
    'Incident response · example',
    'Independent operations · example',
  ]);

  await workflowSelect.selectOption({ label: 'Independent operations · example' });
  await expect(page.locator('.workflow-node')).toHaveCount(4);
  await expect(page.locator('.workflow-node-status')).toHaveCount(4);
  await expect(page.locator('.workflow-node-status')).toHaveText([
    'Standalone', 'Standalone', 'Standalone', 'Standalone',
  ]);
  await expect(page.locator('.workflow-summary')).toContainText('4 independent lanes');
  await expect(page.getByText('4 lanes · 4 standalone', { exact: true })).toBeVisible();

  await expect.poll(() => assets.includes('/js/views/workflows.js')).toBe(true);
  await expect.poll(() => assets.includes('/styles/workflows.css')).toBe(true);
  expect(assets).not.toContain('/js/views/settings.js');
  expect(assets).not.toContain('/styles/settings.css');

  for (const width of [1081, 320]) {
    await page.setViewportSize({ width, height: 760 });
    await expect.poll(() => page.evaluate(() => ({
      documentContained: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      bodyContained: document.body.scrollWidth <= document.body.clientWidth,
      canvasScrollsInternally: (() => {
        const viewport = document.querySelector('.workflow-canvas-viewport');
        return Boolean(viewport && viewport.scrollWidth > viewport.clientWidth);
      })(),
    }))).toEqual({
      documentContained: true,
      bodyContained: true,
      canvasScrollsInternally: true,
    });
  }

  await expectNoWorkflowBackendCalls(recording);
});

test('organization admin creates a safe custom agent, links nodes, and persists isolated drafts', async ({ page }) => {
  const recording = await installDesignerStubs(page, {
    organizations: [PRIMARY_ORG, SECONDARY_ORG],
  });
  await openDesigner(page);

  await page.getByRole('button', { name: 'New blank', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Active workflow' })).toContainText('Untitled workflow');
  await expect(page.locator('.workflow-node')).toHaveCount(0);

  await page.getByRole('complementary', { name: 'Workflow inspector' })
    .getByLabel('Name', { exact: true })
    .fill('Immediate persistence flow');
  await page.locator('.workflow-canvas-viewport').evaluate((viewport) => {
    viewport.scrollLeft = 360;
    viewport.scrollTop = 120;
    viewport.dispatchEvent(new Event('scroll'));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('combobox', { name: 'Active workflow' })).toContainText('Immediate persistence flow');
  await expect.poll(() => page.evaluate((key) => {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    return saved?.workflows?.find((workflow) => workflow.id === saved.activeWorkflowId)?.viewport;
  }, workflowStorageKey(PRIMARY_ORG.id))).toMatchObject({ x: 360, y: 120 });

  await page.getByRole('button', { name: 'New custom agent', exact: true }).click();
  const form = page.locator('.workflow-profile-form');
  await expect(form).toBeVisible();
  await profileField(form, 'Name').fill('Observability Steward');
  await profileField(form, 'Category').selectOption('Operations');
  await profileField(form, 'Description').fill('Summarizes service health for release owners.');
  await profileField(form, 'Purpose').fill('Detect regressions and produce a bounded health recommendation.');
  await profileField(form, 'Inputs').fill('Service objectives\nRelease markers');
  await profileField(form, 'Outputs').fill('Health summary\nEscalation recommendation');
  await profileField(form, 'Guardrails').fill('Never include customer data\nState signal confidence');
  await form.locator('details').evaluate((details) => { details.open = true; });
  await profileField(form, 'Runtime').selectOption('deep-agent');
  await profileField(form, 'Model preference').selectOption('balanced');
  await profileField(form, 'Tools').fill('metrics, logs');
  await profileField(form, 'Skills').fill('observability-analysis');
  await form.getByRole('button', { name: 'Create agent', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Add Observability Steward to workflow' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add Observability Steward to workflow' }).click();
  await page.getByRole('button', { name: 'Add Support Agent to workflow' }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(2);

  await selectCanvasNode(page, 'Observability Steward');
  const inspector = page.getByRole('complementary', { name: 'Workflow inspector' });
  const dependencies = inspector.locator('.workflow-inspector-section', { hasText: /^Dependencies/ });
  await dependencies.locator('select').selectOption({ label: 'Support Agent' });
  await dependencies.getByRole('button', { name: 'Add dependency', exact: true }).click();
  await expect(page.locator('.workflow-edge-group')).toHaveCount(1);
  await expect(inspector.locator('.workflow-connection-summary')).toContainText('Support Agent');
  await expect(inspector.locator('.workflow-connection-summary')).toContainText('Observability Steward');

  await selectCanvasNode(page, 'Support Agent');
  const reverseDependencies = inspector.locator('.workflow-inspector-section', { hasText: /^Dependencies/ });
  await reverseDependencies.locator('select').selectOption({ label: 'Observability Steward' });
  await reverseDependencies.getByRole('button', { name: 'Add dependency', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('That connection would create a cycle.');
  await expect(page.locator('.workflow-edge-group')).toHaveCount(1);

  const primaryKey = workflowStorageKey(PRIMARY_ORG.id);
  await expect.poll(() => page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) || 'null');
    const workflow = state?.workflows?.find((item) => item.id === state.activeWorkflowId);
    return {
      customAgents: state?.customAgents?.length ?? -1,
      nodes: workflow?.nodes?.length ?? -1,
      edges: workflow?.edges?.length ?? -1,
    };
  }, primaryKey)).toEqual({ customAgents: 1, nodes: 2, edges: 1 });

  const savedPrimaryState = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), primaryKey);
  expect(savedPrimaryState.customAgents[0]).toMatchObject({
    name: 'Observability Steward',
    runtime: 'deep-agent',
    modelPreference: 'balanced',
    tools: ['metrics', 'logs'],
    skills: ['observability-analysis'],
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: 'Acme Platform workflows' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Active workflow' })).toHaveValue(savedPrimaryState.activeWorkflowId);
  await expect(page.locator('.workflow-node')).toHaveCount(2);
  await expect(page.locator('.workflow-edge-group')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add Observability Steward to workflow' })).toBeVisible();

  await page.locator('.account-context-trigger').click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.locator('#account-organization-select').selectOption(SECONDARY_ORG.id),
  ]);
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: 'Beta Labs workflows' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Observability Steward to workflow' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Active workflow' }).locator('option')).toHaveCount(5);

  const secondaryKey = workflowStorageKey(SECONDARY_ORG.id);
  expect(await page.evaluate((key) => localStorage.getItem(key), secondaryKey)).toBeNull();
  await page.getByRole('button', { name: 'New blank', exact: true }).click();
  await expect.poll(() => page.evaluate((key) => Boolean(localStorage.getItem(key)), secondaryKey)).toBe(true);
  const isolated = await page.evaluate(([firstKey, secondKey]) => {
    const first = JSON.parse(localStorage.getItem(firstKey));
    const second = JSON.parse(localStorage.getItem(secondKey));
    return {
      firstCustomAgents: first.customAgents.length,
      secondCustomAgents: second.customAgents.length,
      firstActiveName: first.workflows.find((item) => item.id === first.activeWorkflowId)?.name,
      secondActiveName: second.workflows.find((item) => item.id === second.activeWorkflowId)?.name,
    };
  }, [primaryKey, secondaryKey]);
  expect(isolated).toEqual({
    firstCustomAgents: 1,
    secondCustomAgents: 0,
    firstActiveName: 'Immediate persistence flow',
    secondActiveName: 'Untitled workflow',
  });

  await expectNoWorkflowBackendCalls(recording);
});

test('organization members can inspect workflows but cannot mutate the local copy', async ({ page }) => {
  const memberOrg = { ...PRIMARY_ORG, role: 'MEMBER' };
  const recording = await installDesignerStubs(page, { organizations: [memberOrg] });

  await openDesigner(page);

  await expect(page.locator('.workflow-page')).toHaveAttribute('data-editable', 'false');
  await expect(page.getByRole('note')).toContainText('Read-only organization view');
  await expect(page.getByRole('button', { name: 'New blank', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Duplicate', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reset examples', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New custom agent', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New context', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add Requirements Agent to workflow' })).toBeDisabled();

  await selectCanvasNode(page, 'Change intake');
  const inspector = page.getByRole('complementary', { name: 'Workflow inspector' });
  await expect(inspector.locator('.workflow-field input').first()).toBeDisabled();
  await expect(inspector.getByRole('button', { name: 'Add dependency', exact: true })).toBeDisabled();
  await expect(inspector.getByRole('button', { name: 'Delete node', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.getByRole('combobox', { name: 'Active workflow' }).selectOption({ label: 'Independent operations · example' });
  await page.waitForTimeout(400);
  expect(await page.evaluate((key) => localStorage.getItem(key), workflowStorageKey(memberOrg.id))).toBeNull();

  await expectNoWorkflowBackendCalls(recording);
});

test('an authenticated user without an organization gets a contextual empty state', async ({ page }) => {
  const recording = await installDesignerStubs(page, { organizations: [] });

  await openDesigner(page);

  await expect(page.getByRole('heading', { name: 'Select an organization to design workflows' })).toBeVisible();
  await expect(page.getByText('Workflow drafts are isolated by organization.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Organization', exact: true })).toHaveAttribute('href', '#/organization');
  await expect(page.locator('.workflow-designer')).toHaveCount(0);

  await expectNoWorkflowBackendCalls(recording);
});
