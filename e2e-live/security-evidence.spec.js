'use strict';

const { test, expect } = require('@playwright/test');

const { loadLiveConfig, resolveBootstrapApiBase } = require('./support/config');
const {
  apiProbe,
  freshAuthenticatedBrowserSession,
  isTerminalPipelineStatus,
  mergeScenarioEvidence,
  requireSecurityFixtures,
  saveSecurityVideo,
  setSecurityEvidenceHud,
  settleEvidenceFrame,
} = require('./support/security-evidence');

let cachedConfig;

const MAIN_NAVIGATION_ROUTES = Object.freeze([
  'agent',
  'workflows',
  'agent-jobs',
  'calls',
  'business',
  'projects',
  'board',
  'organization',
  'analytics',
  'cost',
  'troubleshooting',
  'settings',
]);

function liveConfig() {
  if (!cachedConfig) cachedConfig = loadLiveConfig({ requireAuth: true });
  return cachedConfig;
}

test.describe.configure({ mode: 'serial' });

function requestRecord(request) {
  const url = new URL(request.url());
  return Object.freeze({ method: request.method(), pathname: url.pathname });
}

function requestLabel(call) {
  return `${call.method} ${call.pathname}`;
}

function isTenantPrivateRequest(call) {
  if (call.pathname === '/api/agent/knowledge-search') return false;
  return call.pathname === '/api/agent'
    || call.pathname.startsWith('/api/agent/')
    || call.pathname === '/api/coder'
    || call.pathname.startsWith('/api/coder/')
    || call.pathname === '/api/projects'
    || call.pathname.startsWith('/api/projects/')
    || call.pathname === '/api/businesses'
    || call.pathname.startsWith('/api/businesses/')
    || call.pathname === '/api/issues'
    || call.pathname.startsWith('/api/issues/')
    || call.pathname === '/api/observability'
    || call.pathname.startsWith('/api/observability/')
    || call.pathname === '/api/settings'
    || call.pathname.startsWith('/api/settings/')
    || call.pathname === '/api/settings-policy'
    || call.pathname.startsWith('/api/settings-policy/')
    || call.pathname === '/api/org'
    || call.pathname.startsWith('/api/org/')
    || call.pathname === '/api/pipeline'
    || call.pathname.startsWith('/api/pipeline/')
    || call.pathname === '/api/billing'
    || call.pathname.startsWith('/api/billing/');
}

function privateRequestLabels(requests) {
  return requests.filter(isTenantPrivateRequest).map(requestLabel);
}

async function openAgent(page, { publicMode = false } = {}) {
  const response = await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), 'the Agent SPA document loads').toBeTruthy();
  await expect(page.locator('.agent-workspace')).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false', { timeout: 25_000 });
  if (publicMode) {
    await expect(page.locator('.agent-workspace')).toHaveAttribute('data-agent-scaffold', 'public');
  } else {
    await expect(page.locator('.auth-user')).toBeVisible({ timeout: 25_000 });
  }
  await expect(page.getByRole('textbox', { name: 'Ask or act from the Agent omnibox' })).toBeEnabled();
  await settlePublishedWork(page);
}

async function settlePublishedWork(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function sendAgentRequest(page, text) {
  const composer = page.getByRole('textbox', { name: 'Ask or act from the Agent omnibox' });
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function accountContextSnapshot(page) {
  const account = page.locator('.account-context');
  if (!(await account.evaluate((element) => element.open))) {
    await page.locator('.account-context-trigger').click();
  }
  const organizations = page.locator('#account-organization-select');
  const projects = page.locator('#account-project-select');
  await expect(organizations).toBeVisible();
  await expect(projects).toBeVisible();
  return {
    organizationValue: await organizations.inputValue(),
    projectValue: await projects.inputValue(),
    organizationOptions: await organizations.locator('option').evaluateAll((options) => (
      options.map((option) => ({ value: option.value, text: option.textContent || '' }))
    )),
    projectOptions: await projects.locator('option').evaluateAll((options) => (
      options.map((option) => ({ value: option.value, text: option.textContent || '' }))
    )),
    panelText: await account.locator('.account-context-panel').innerText(),
  };
}

function containsText(value, needle) {
  return String(value || '').toLocaleLowerCase().includes(String(needle || '').toLocaleLowerCase());
}

function payloadContainsAny(payload, sensitiveValues) {
  let serialized = '';
  try { serialized = JSON.stringify(payload); } catch (_) { serialized = ''; }
  return sensitiveValues.some((value) => value && containsText(serialized, value));
}

function expectNoFixtureDisclosure(payload, tenant, label) {
  expect(
    payloadContainsAny(payload, [
      tenant.canary,
      tenant.organizationId,
      tenant.projectId,
      tenant.conversationId,
      tenant.terminalRunId,
    ]),
    `${label} returns a generic denial without Tenant B fixture values`,
  ).toBe(false);
}

function runStatus(payload) {
  return String((payload && payload.run && payload.run.status) || (payload && payload.status) || '');
}

async function traverseMainNavigation(page, tenantB) {
  const visited = [];
  const protectedValues = [
    tenantB.canary,
    tenantB.organizationId,
    tenantB.projectId,
    tenantB.conversationId,
    tenantB.terminalRunId,
  ];

  for (const route of MAIN_NAVIGATION_ROUTES) {
    const link = page.locator(`#tabs a[data-route="${route}"]`);
    await expect(link, `${route} is available to the synthetic Tenant A operator`).toBeVisible();
    await link.scrollIntoViewIfNeeded();
    await link.click();
    await expect(page, `${route} navigation updates the SPA route`).toHaveURL(new RegExp(`#/${route}$`));
    const view = page.locator('#view');
    await expect(view, `${route} finishes rendering`).toHaveAttribute('aria-busy', 'false', {
      timeout: 30_000,
    });
    expect((await view.innerText()).trim(), `${route} renders visible content`).not.toBe('');

    if (route === 'workflows') {
      await expect(page.locator('.workflow-page')).toBeVisible();
      await expect(page.getByText('Does not execute', { exact: true })).toBeVisible();
      const selector = page.getByRole('combobox', { name: 'Active workflow' });
      await selector.selectOption({ label: 'Environment release · example' });
      for (const environment of ['Dev context', 'Beta context', 'Prod context']) {
        await expect(
          page.locator('.workflow-node').filter({ hasText: environment }),
          `the descriptive workflow includes ${environment}`,
        ).toBeVisible();
      }
    }

    const rendered = await view.evaluate((element) => ({
      text: element.innerText,
      html: element.innerHTML,
    }));
    expect(
      payloadContainsAny(rendered, protectedValues),
      `${route} contains no Tenant B fixture value`,
    ).toBe(false);
    visited.push(route);
  }

  return Object.freeze({
    routes: Object.freeze(visited),
    workflowEnvironments: Object.freeze(['Dev', 'Beta', 'Prod']),
  });
}

async function persistRecordedResult({ page, testInfo, evidenceDir, videoName, key, result, error }) {
  let finalError = error || null;
  let finalResult = result;
  try {
    await saveSecurityVideo(page, evidenceDir, videoName, testInfo);
  } catch (videoError) {
    if (!finalError) finalError = videoError;
    finalResult = {
      ...result,
      result: 'failed',
      completedAt: new Date().toISOString(),
      video: null,
      error: 'The sanitized evidence video could not be saved; see the Playwright report.',
    };
  }
  try {
    mergeScenarioEvidence(evidenceDir, key, finalResult);
  } catch (evidenceError) {
    if (!finalError) finalError = evidenceError;
  }
  if (finalError) throw finalError;
}

test.describe('recorded anonymous security journey', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('01 — public questions and RAG work, while every pipeline start is denied', async ({ page }, testInfo) => {
    test.setTimeout(4 * 60 * 1_000);
    const activeConfig = liveConfig();
    const startedAt = new Date().toISOString();
    const requests = [];
    let recordedError = null;
    let result = {
      result: 'failed',
      startedAt,
      completedAt: startedAt,
      video: '01-anonymous.webm',
      error: 'The anonymous security journey did not complete.',
    };
    page.on('request', (request) => {
      const record = requestRecord(request);
      if (record.pathname.startsWith('/api/')) requests.push(record);
    });

    try {
      await openAgent(page, { publicMode: true });
      const anonymousApiBaseUrl = await resolveBootstrapApiBase(activeConfig);
      await setSecurityEvidenceHud(page, 'Anonymous boundary', [
        'mode: signed out',
        'allowed: greeting, project question, reviewed-doc RAG',
        'blocked: plan → code → test → deploy',
      ]);
      await settleEvidenceFrame(page);

      requests.length = 0;
      await sendAgentRequest(page, 'Hi');
      await expect(page.locator('.intent-message[data-agent-intent="salutation"]')).toBeVisible();
      await settlePublishedWork(page);
      expect(privateRequestLabels(requests), 'a greeting never touches tenant state').toEqual([]);

      requests.length = 0;
      await sendAgentRequest(page, 'What is the AI Fleet project?');
      await expect(page.locator('.intent-message[data-agent-intent="general"]')).toBeVisible();
      await settlePublishedWork(page);
      expect(privateRequestLabels(requests), 'a generic project question never touches tenant state').toEqual([]);

      requests.length = 0;
      const knowledgeResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'POST'
          && url.pathname === '/api/agent/knowledge-search';
      }, { timeout: 25_000 });
      await sendAgentRequest(page, 'Search the docs and RAG index for authentication and tenant isolation');
      await expect(page.locator('.intent-message[data-agent-intent="knowledge"]')).toBeVisible();
      const knowledgeResponse = await knowledgeResponsePromise;
      expect(knowledgeResponse.status(), 'reviewed-document search succeeds').toBe(200);
      await expect(page.locator('#agent-details-panel')).toContainText('Reviewed documentation');
      await settlePublishedWork(page);
      expect(
        requests.filter((call) => call.pathname === '/api/agent/knowledge-search').map(requestLabel),
        'RAG uses the single reviewed-document endpoint',
      ).toEqual(['POST /api/agent/knowledge-search']);
      expect(privateRequestLabels(requests), 'public RAG never touches tenant state').toEqual([]);

      requests.length = 0;
      await sendAgentRequest(
        page,
        'Build a software application and execute the entire plan, code, test, and deploy pipeline',
      );
      await expect(page.locator('.intent-message[data-agent-intent="build"]')).toBeVisible();
      await expect(page.locator('#agent-details-panel [data-panel-section="authentication"]')).toBeVisible();
      await expect(page.locator('#agent-details-panel')).toContainText('Sign in to continue');
      await settlePublishedWork(page);
      expect(privateRequestLabels(requests), 'the gated UI does not attempt a pipeline call').toEqual([]);

      const denials = [
        ['canonical pipeline', '/api/pipeline/runs', {
          requestedStages: ['plan', 'code', 'test', 'deploy'],
          request: { purpose: 'synthetic anonymous denial probe' },
        }],
        ['planner compatibility start', '/api/agent/enqueue', { projectId: 'synthetic-denial-probe' }],
        ['coder compatibility start', '/api/coder/run', { issueId: 'synthetic-denial-probe' }],
        ['business pipeline', '/api/agent/business/prepare', { input: 'Synthetic anonymous denial probe' }],
      ];
      const denialEvidence = {};
      for (const [label, pathname, body] of denials) {
        const denial = await apiProbe(anonymousApiBaseUrl, pathname, { method: 'POST', body });
        expect(denial.status, `${label} rejects an anonymous caller`).toBe(401);
        expect(denial.code, `${label} identifies the authentication boundary`).toBe('authentication_required');
        denialEvidence[label] = { status: denial.status, code: denial.code };
      }

      await setSecurityEvidenceHud(page, 'Anonymous boundary — PASS', [
        'Hi: local response; private calls 0',
        'project question: local response; private calls 0',
        'RAG: reviewed docs only; HTTP 200',
        'pipeline + legacy starts: HTTP 401',
      ]);
      await settleEvidenceFrame(page);
      result = {
        result: 'passed',
        startedAt,
        completedAt: new Date().toISOString(),
        video: '01-anonymous.webm',
        checks: {
          greeting: { intent: 'salutation', tenantPrivateRequests: 0 },
          projectQuestion: { intent: 'general', tenantPrivateRequests: 0 },
          reviewedDocumentationRag: { status: 200, tenantPrivateRequests: 0 },
          fullPipelineUi: { signInRequired: true, tenantPrivateRequests: 0 },
          directApiDenials: denialEvidence,
        },
      };
    } catch (error) {
      recordedError = error;
      result = {
        result: 'failed',
        startedAt,
        completedAt: new Date().toISOString(),
        video: '01-anonymous.webm',
        error: 'An anonymous-boundary assertion failed; see the Playwright report.',
      };
      try {
        await setSecurityEvidenceHud(page, 'Anonymous boundary — FAIL', [
          'sanitized result: assertion failed',
          'details: Playwright report only',
        ]);
        await settleEvidenceFrame(page);
      } catch (_) {
        // A browser-level failure can close the page before the final frame.
      }
    }

    await persistRecordedResult({
      page,
      testInfo,
      evidenceDir: activeConfig.evidenceDir,
      videoName: '01-anonymous.webm',
      key: 'anonymous',
      result,
      error: recordedError,
    });
  });
});

test.describe('recorded authenticated tenant-isolation journey', () => {
  test.use({ storageState: liveConfig().authStateAPath });

  test('02 — Tenant A cannot discover or control Tenant B through UI or API', async ({ page, browser }, testInfo) => {
    test.setTimeout(6 * 60 * 1_000);
    const activeConfig = liveConfig();
    const { tenantA, tenantB } = requireSecurityFixtures(activeConfig.fixtures);
    const startedAt = new Date().toISOString();
    let recordedError = null;
    let result = {
      result: 'failed',
      startedAt,
      completedAt: startedAt,
      video: '02-tenant-isolation.webm',
      error: 'The tenant-isolation journey did not complete.',
    };

    try {
      await openAgent(page);
      await setSecurityEvidenceHud(page, 'Tenant isolation', [
        'session: authenticated Tenant A',
        'UI check: account context and organization view',
        'API check: known Tenant B resources and controls',
      ]);
      await settleEvidenceFrame(page);

      const initialContext = await accountContextSnapshot(page);
      expect(initialContext.organizationValue, 'Tenant A organization is selected').toBe(tenantA.organizationId);
      expect(initialContext.projectValue, 'Tenant A project is selected').toBe(tenantA.projectId);
      expect(initialContext.organizationOptions.map((option) => option.value)).toContain(tenantA.organizationId);
      expect(initialContext.projectOptions.map((option) => option.value)).toContain(tenantA.projectId);
      expect(initialContext.organizationOptions.map((option) => option.value)).not.toContain(tenantB.organizationId);
      expect(initialContext.projectOptions.map((option) => option.value)).not.toContain(tenantB.projectId);
      expect(containsText(initialContext.panelText, tenantB.canary), 'account context omits Tenant B canary').toBe(false);

      // Treat browser storage as hostile input. A stale/forged Tenant B choice
      // must be resolved back to Tenant A's server-authorized context on reload.
      await page.evaluate(({ organizationId, projectId }) => {
        const key = 'ai-fleet.context';
        return import('/js/workspace-context.js').then(({ getWorkspaceContext }) => {
          let store;
          try { store = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { store = null; }
          if (!store || store.version !== 1 || !store.users || typeof store.users !== 'object') {
            throw new Error('Authenticated workspace context was not persisted.');
          }
          const userId = getWorkspaceContext().user && getWorkspaceContext().user.id;
          const preference = userId && store.users[userId];
          if (!userId || !preference || typeof preference !== 'object') {
            throw new Error('Authenticated user context entry was not found.');
          }
          store.users[userId] = {
            organizationId,
            projectIdsByOrganization: {
              ...(preference.projectIdsByOrganization || {}),
              [organizationId]: projectId,
            },
          };
          localStorage.setItem(key, JSON.stringify(store));
        });
      }, { organizationId: tenantB.organizationId, projectId: tenantB.projectId });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('.auth-user')).toBeVisible({ timeout: 25_000 });
      await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false', { timeout: 25_000 });
      const correctedContext = await accountContextSnapshot(page);
      expect(correctedContext.organizationValue, 'forged organization is corrected').toBe(tenantA.organizationId);
      expect(correctedContext.projectValue, 'forged project is corrected').toBe(tenantA.projectId);
      expect(correctedContext.organizationOptions.map((option) => option.value)).not.toContain(tenantB.organizationId);
      expect(correctedContext.projectOptions.map((option) => option.value)).not.toContain(tenantB.projectId);
      expect(containsText(correctedContext.panelText, tenantB.canary), 'corrected menu omits Tenant B canary').toBe(false);

      await page.locator('.account-context').evaluate((element) => { element.open = false; });
      const navigation = await traverseMainNavigation(page, tenantB);
      await setSecurityEvidenceHud(page, 'Tenant isolation', [
        'account selector: Tenant B absent',
        'forged local selection: corrected to Tenant A',
        `main navigation: ${navigation.routes.length}/${MAIN_NAVIGATION_ROUTES.length} surfaces`,
        'workflow contexts: Dev → Beta → Prod',
        'API isolation checks: running',
      ]);
      await settleEvidenceFrame(page);

      const tenantASession = await freshAuthenticatedBrowserSession(page);
      const tenantAHeaders = {
        token: tenantASession.token,
        organizationId: tenantA.organizationId,
        projectId: tenantA.projectId,
      };
      const tenantAContext = await apiProbe(tenantASession.apiBaseUrl, '/api/org/me/context', {
        token: tenantASession.token,
      });
      expect(tenantAContext.status, 'Tenant A can load its own authoritative context').toBe(200);
      expectNoFixtureDisclosure(tenantAContext.data, tenantB, 'Tenant A context');
      const tenantAOwnProject = await apiProbe(
        tenantASession.apiBaseUrl,
        `/api/org/projects/${encodeURIComponent(tenantA.projectId)}`,
        tenantAHeaders,
      );
      expect(tenantAOwnProject.status, 'Tenant A own-project positive control').toBe(200);
      expect(
        payloadContainsAny(tenantAOwnProject.data, [tenantA.canary]),
        'Tenant A project positive control contains its synthetic canary',
      ).toBe(true);

      let tenantBSession;
      let tenantBOwnProject;
      let tenantBOwnSettings;
      let tenantBOwnConversation;
      let tenantBOwnRun;
      const tenantBContext = await browser.newContext({
        baseURL: activeConfig.baseUrl,
        storageState: activeConfig.authStateBPath,
      });
      try {
        const tenantBPage = await tenantBContext.newPage();
        await openAgent(tenantBPage);
        tenantBSession = await freshAuthenticatedBrowserSession(tenantBPage);
        const tenantBHeaders = {
          token: tenantBSession.token,
          organizationId: tenantB.organizationId,
          projectId: tenantB.projectId,
        };
        tenantBOwnProject = await apiProbe(
          tenantBSession.apiBaseUrl,
          `/api/org/projects/${encodeURIComponent(tenantB.projectId)}`,
          tenantBHeaders,
        );
        tenantBOwnSettings = await apiProbe(
          tenantBSession.apiBaseUrl,
          `/api/settings-policy/settings/project/${encodeURIComponent(tenantB.settingsProjectId)}`,
          tenantBHeaders,
        );
        tenantBOwnConversation = await apiProbe(
          tenantBSession.apiBaseUrl,
          `/api/agent/conversations/${encodeURIComponent(tenantB.conversationId)}`,
          tenantBHeaders,
        );
        tenantBOwnRun = await apiProbe(
          tenantBSession.apiBaseUrl,
          `/api/pipeline/runs/${encodeURIComponent(tenantB.terminalRunId)}`,
          tenantBHeaders,
        );
      } finally {
        await tenantBContext.close();
      }
      expect(tenantBOwnProject.status, 'Tenant B own-project positive control').toBe(200);
      expect(
        [200, 403],
        'Tenant B settings positive control is either readable or explicitly role-gated',
      ).toContain(tenantBOwnSettings.status);
      expect(tenantBOwnConversation.status, 'Tenant B own-conversation positive control').toBe(200);
      expect(tenantBOwnRun.status, 'Tenant B own-run positive control').toBe(200);
      expect(
        payloadContainsAny(
          {
            project: tenantBOwnProject.data,
            settings: tenantBOwnSettings.data,
            conversation: tenantBOwnConversation.data,
            run: tenantBOwnRun.data,
          },
          [tenantB.canary],
        ),
        'Tenant B positive controls contain its synthetic canary',
      ).toBe(true);
      expect(
        isTerminalPipelineStatus(runStatus(tenantBOwnRun.data)),
        'the synthetic Tenant B run is terminal before cancel/resume denial probes',
      ).toBe(true);

      const crossProject = await apiProbe(
        tenantASession.apiBaseUrl,
        `/api/org/projects/${encodeURIComponent(tenantB.projectId)}`,
        tenantAHeaders,
      );
      const crossSettings = await apiProbe(
        tenantASession.apiBaseUrl,
        `/api/settings-policy/settings/project/${encodeURIComponent(tenantB.settingsProjectId)}`,
        tenantAHeaders,
      );
      const crossConversation = await apiProbe(
        tenantASession.apiBaseUrl,
        `/api/agent/conversations/${encodeURIComponent(tenantB.conversationId)}`,
        tenantAHeaders,
      );
      const crossRunRead = await apiProbe(
        tenantASession.apiBaseUrl,
        `/api/pipeline/runs/${encodeURIComponent(tenantB.terminalRunId)}`,
        tenantAHeaders,
      );
      // These mutation-shaped probes are permitted only after the Tenant B
      // positive control proved that the synthetic fixture run is terminal.
      const crossRunCancel = await apiProbe(
        tenantASession.apiBaseUrl,
        `/api/pipeline/runs/${encodeURIComponent(tenantB.terminalRunId)}/cancel`,
        {
          method: 'POST',
          ...tenantAHeaders,
          body: { reason: 'Synthetic QA cross-tenant denial probe.' },
        },
      );
      const crossRunResume = await apiProbe(
        tenantASession.apiBaseUrl,
        `/api/pipeline/runs/${encodeURIComponent(tenantB.terminalRunId)}/resume`,
        { method: 'POST', ...tenantAHeaders, body: { retryFailed: false } },
      );
      const crossTenantGateway = await apiProbe(
        tenantBSession.apiBaseUrl,
        `/api/org/projects/${encodeURIComponent(tenantB.projectId)}`,
        tenantAHeaders,
      );
      const spoofedTenantBContext = await apiProbe(
        tenantASession.apiBaseUrl,
        `/api/org/projects/${encodeURIComponent(tenantB.projectId)}`,
        {
          token: tenantASession.token,
          organizationId: tenantB.organizationId,
          projectId: tenantB.projectId,
        },
      );

      const hiddenResources = [
        ['project', crossProject],
        ['settings', crossSettings],
        ['conversation', crossConversation],
        ['pipeline run read', crossRunRead],
        ['pipeline run cancel', crossRunCancel],
        ['pipeline run resume', crossRunResume],
        ['Tenant B gateway', crossTenantGateway],
      ];
      for (const [label, response] of hiddenResources) {
        expect(response.status, `${label} is existence-hiding for Tenant A`).toBe(404);
        expectNoFixtureDisclosure(response.data, tenantB, label);
      }
      expect(
        [403, 404],
        'forged Tenant B context is rejected before resource access',
      ).toContain(spoofedTenantBContext.status);
      expectNoFixtureDisclosure(spoofedTenantBContext.data, tenantB, 'forged context');

      await setSecurityEvidenceHud(page, 'Tenant isolation — PASS', [
        'own-resource controls: HTTP 200',
        'cross-tenant project/settings: HTTP 404',
        'cross-tenant conversation/run: HTTP 404',
        'cross-tenant cancel/resume: HTTP 404',
        `forged context: HTTP ${spoofedTenantBContext.status}`,
      ]);
      await settleEvidenceFrame(page);
      result = {
        result: 'passed',
        startedAt,
        completedAt: new Date().toISOString(),
        video: '02-tenant-isolation.webm',
        checks: {
          ui: {
            accountSelectorExcludesTenantB: true,
            forgedLocalSelectionCorrected: true,
            mainNavigationExcludesTenantB: true,
            routesVisited: navigation.routes,
            workflowEnvironments: navigation.workflowEnvironments,
          },
          positiveControls: {
            tenantAContext: tenantAContext.status,
            tenantAProject: tenantAOwnProject.status,
            tenantBProject: tenantBOwnProject.status,
            tenantBSettings: tenantBOwnSettings.status,
            tenantBConversation: tenantBOwnConversation.status,
            tenantBTerminalRun: tenantBOwnRun.status,
          },
          crossTenantDenials: Object.fromEntries(hiddenResources.map(([label, response]) => (
            [label, { status: response.status }]
          ))),
          forgedContext: { status: spoofedTenantBContext.status },
        },
      };
    } catch (error) {
      recordedError = error;
      result = {
        result: 'failed',
        startedAt,
        completedAt: new Date().toISOString(),
        video: '02-tenant-isolation.webm',
        error: 'A tenant-isolation assertion failed; see the Playwright report.',
      };
      try {
        await setSecurityEvidenceHud(page, 'Tenant isolation — FAIL', [
          'sanitized result: assertion failed',
          'details: Playwright report only',
        ]);
        await settleEvidenceFrame(page);
      } catch (_) {
        // A browser-level failure can close the page before the final frame.
      }
    }

    await persistRecordedResult({
      page,
      testInfo,
      evidenceDir: activeConfig.evidenceDir,
      videoName: '02-tenant-isolation.webm',
      key: 'tenantIsolation',
      result,
      error: recordedError,
    });
  });
});
