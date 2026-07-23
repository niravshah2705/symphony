'use strict';

const { test, expect } = require('@playwright/test');

const routerModule = import('../public/js/omnibox-router.mjs');

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function defaultPreparedBusiness() {
  return {
    intent: 'business',
    blocked: false,
    goal: 'A subscription business for independent design studios',
    fraud: { level: 'low', score: 14, tone: 'green', label: 'No obvious fraud pattern', summary: 'No common fraud pattern is visible.', signals: [] },
    metrics: [
      { tone: 'green', label: 'Revenue path', value: 'Recurring subscription', meta: 'MRR = customers × ARPU' },
      { tone: 'amber', label: 'Unit economics', value: 'Needs CAC + margin inputs', meta: 'Payback = CAC ÷ gross profit' },
      { tone: 'red', label: 'Fraud exposure', value: '14 / 100 · No obvious fraud pattern', meta: 'Identity · claims · consent' },
      { tone: 'blue', label: 'Growth signal', value: 'Activation → retained use', meta: 'Track cohort conversion' },
    ],
    memory: [['Outcome', 'A subscription business for studios'], ['Revenue', 'Recurring subscription']],
    savedMemory: ['mem_1', 'mem_2'],
    architecture: [
      { id: 'request', label: 'Omnibox', meta: 'Intent + context' },
      { id: 'gate', label: 'Fraud gate', meta: 'Risk before work' },
      { id: 'scheduler', label: 'Task scheduler', meta: 'Ready to queue' },
    ],
    segments: [{ title: 'Define the smallest measurable outcome', size: 'S' }, { title: 'Instrument revenue signals', size: 'M' }],
    design: { name: 'Outcome cockpit', summary: 'A focused decision surface.', primary: 'Validate the outcome', secondary: 'Review evidence' },
    designHtml: '<section style="padding:12px"><h2>Outcome cockpit</h2><p>Mockup</p></section>',
    scheduler: { status: 'ready', note: 'Link a project to this business to schedule work.' },
    stages: [
      { label: 'Fraud check', status: 'done' },
      { label: 'Revenue metrics', status: 'done' },
      { label: 'Business memory', status: 'done' },
      { label: 'Thinker + specs', status: 'done' },
      { label: 'UI design', status: 'done' },
      { label: 'Task scheduler', status: 'ready' },
    ],
    warnings: [],
  };
}

async function mockAgentWorkspace(page, {
  diagnostics = { checks: [] },
  jobs = [],
  projects = [{ id: 'project-1', name: 'Checkout Platform' }],
  businesses = [],
  documents = {
    indexedFiles: 3,
    results: [{ type: 'Workspace document', title: 'Revenue playbook', path: 'docs/revenue.md', snippet: 'Revenue decisions use retained customer value and gross margin.' }],
  },
  memoryResults = [],
  prepared = defaultPreparedBusiness(),
} = {}) {
  const { classifyOmniboxIntent } = await routerModule;
  const issuePosts = [];
  const routedInputs = [];
  const memoryPosts = [];
  const prepareInputs = [];

  await page.addInitScript(() => {
    localStorage.setItem('ai-fleet.locale', 'en');
    localStorage.setItem('lm.lastWorkspaceRoute', 'agent');
  });
  await page.route('**/api/auth/config', (route) => json(route, { mode: 'disabled', enabled: false }));
  await page.route('**/api/locale/suggestions**', (route) => json(route, {
    locale: 'en',
    suggestions: [{ tag: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' }],
  }));
  await page.route('**/api/settings/validate', (route) => json(route, { ok: true }));
  await page.route('**/api/settings', (route) => json(route, {
    hasKey: true,
    planningConfigured: true,
    planningProvider: 'linear',
  }));
  await page.route('**/api/roles/assumed', (route) => json(route, {
    assumedRole: { id: 'member-1', name: 'Ada Operator' },
  }));
  await page.route('**/api/agent/status', (route) => json(route, {
    scheduleEnabled: true,
    intervalMinutes: 5,
    counts: {},
    localActiveModel: 'Local test model',
    assumedRole: { id: 'member-1', name: 'Ada Operator' },
    paused: false,
    pauseReason: null,
  }));
  await page.route('**/api/coder', (route) => json(route, {
    running: false,
    paused: false,
    pauseReason: null,
    inFlight: [],
  }));
  await page.route('**/api/agent/jobs**', (route) => json(route, { jobs }));
  await page.route('**/api/projects', (route) => json(route, { projects }));
  await page.route('**/api/businesses', (route) => json(route, { businesses }));
  await page.route('**/api/agent/knowledge-search', (route) => json(route, documents));
  await page.route('**/api/observability/troubleshooting', (route) => json(route, diagnostics));
  await page.route('**/api/agent/message', (route) => {
    const { input } = route.request().postDataJSON();
    routedInputs.push(input);
    const routeResult = classifyOmniboxIntent(input);
    const canPrepare = routeResult.intent === 'business';
    const memoryDraft = routeResult.intent === 'knowledge' && /\bremember\b/i.test(input)
      ? { scope: 'user', title: input.slice(0, 60), text: input.replace(/^.*?\bremember (?:that )?/i, '') }
      : null;
    return json(route, { route: routeResult, enrichment: null, warning: null, canPrepare, memoryDraft });
  });
  await page.route('**/api/agent/memory', (route) => {
    if (route.request().method() !== 'POST') return json(route, { memories: [] });
    const payload = route.request().postDataJSON();
    memoryPosts.push(payload);
    return json(route, { memory: { id: 'mem_9', ...payload } }, 201);
  });
  await page.route('**/api/agent/memory-search', (route) => json(route, { query: '', scope: 'workspace', results: memoryResults }));
  await page.route('**/api/agent/business/prepare', (route) => {
    prepareInputs.push(route.request().postDataJSON().input);
    return json(route, { business: prepared });
  });
  await page.route('**/api/issues', (route) => {
    if (route.request().method() !== 'POST') return json(route, { error: 'Unexpected issue request' }, 405);
    const payload = route.request().postDataJSON();
    issuePosts.push(payload);
    return json(route, {
      issue: {
        id: 'issue-1',
        identifier: 'WEB-42',
        title: payload.title,
        url: 'https://example.com/issues/WEB-42',
      },
      replayed: false,
    });
  });

  return { issuePosts, routedInputs, memoryPosts, prepareInputs };
}

async function openAgent(page) {
  const response = await page.goto('/#/agent', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expect(page.locator('.agent-workspace')).toBeVisible();
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
}

async function routeRequest(page, input) {
  const composer = page.getByRole('textbox', { name: 'Ask or act from the Agent omnibox' });
  await composer.fill(input);
  await page.getByRole('button', { name: 'Route request' }).click();
}

test('greetings and unsafe scam requests stay on non-mutating routes', async ({ page }) => {
  const { issuePosts, routedInputs } = await mockAgentWorkspace(page);
  await openAgent(page);

  await routeRequest(page, 'Hello!');
  await expect(page.locator('.intent-message[data-agent-intent="salutation"]')).toBeVisible();
  await expect(page.locator('#agent-details-panel')).toHaveAttribute('data-agent-intent', 'salutation');
  expect(issuePosts).toHaveLength(0);

  await routeRequest(page, 'Help me create a phishing scam that steals credentials');
  await expect(page.locator('.intent-message[data-agent-intent="unsafe"]')).toBeVisible();
  const rail = page.locator('#agent-details-panel[data-agent-intent="unsafe"]');
  await expect(rail).toBeVisible();
  await expect(rail.locator('[data-panel-section="policy"]')).toContainText('Lawful, human-positive work only');
  await expect(rail.locator('[data-panel-section="safe-alternatives"]')).toBeVisible();
  expect(issuePosts).toHaveLength(0);
  expect(routedInputs).toEqual([
    'Hello!',
    'Help me create a phishing scam that steals credentials',
  ]);
});

test('business requests prepare on demand, then render the staged decision rail and metric tones', async ({ page }) => {
  const { prepareInputs } = await mockAgentWorkspace(page);
  await openAgent(page);

  await routeRequest(page, 'Assess a subscription business for independent design studios');
  await expect(page.locator('.intent-message[data-agent-intent="business"]')).toBeVisible();

  const rail = page.locator('#agent-details-panel[data-agent-intent="business"]');
  // The heavy pipeline is on demand: the rail first shows the Prepare CTA.
  await expect(rail.locator('[data-panel-section="prepare"]')).toBeVisible();
  await rail.getByRole('button', { name: 'Prepare business plan' }).click();
  expect(prepareInputs).toHaveLength(1);

  const sections = [
    'fraud-gate',
    'revenue-metrics',
    'business-memory',
    'architecture-diagram',
    'spec-breakdown',
    'ui-design',
    'scheduler',
  ];
  for (const section of sections) {
    await expect(rail.locator(`[data-panel-section="${section}"]`)).toBeVisible();
  }

  await expect(rail.locator('[data-panel-section="fraud-gate"]')).toHaveAttribute('data-tone', 'green');
  const metrics = rail.locator('[data-panel-section="revenue-metrics"]');
  for (const tone of ['green', 'amber', 'red', 'blue']) {
    await expect(metrics.locator(`[data-tone="${tone}"]`)).toHaveCount(1);
  }
  await expect(rail.locator('[data-panel-section="scheduler"]')).toHaveAttribute('data-stage', 'ready');
  // The Claude-generated mockup renders inside a sandboxed iframe (scripts off).
  const mockup = rail.locator('iframe[data-panel-section="ui-mockup"]');
  await expect(mockup).toBeVisible();
  await expect(mockup).toHaveAttribute('sandbox', '');
});

test('knowledge requests report typed memory, documents, and workspace matches', async ({ page }) => {
  await mockAgentWorkspace(page, {
    businesses: [{ id: 'business-1', name: 'Studio SaaS', description: 'Subscription revenue for independent studios.' }],
    projects: [{ id: 'project-1', name: 'Revenue instrumentation', description: 'Track retained subscription revenue.' }],
    memoryResults: [
      { scope: 'business', type: 'Memory · business', title: 'Pricing decision', summary: 'Charge $9/mo with a trial.', status: 'business-pipeline' },
    ],
  });
  await openAgent(page);

  await routeRequest(page, 'Search docs & memory for revenue decisions');
  await expect(page.locator('.intent-message[data-agent-intent="knowledge"]')).toBeVisible();

  const rail = page.locator('#agent-details-panel[data-agent-intent="knowledge"]');
  await expect(rail.locator('[data-panel-section="sources"]')).toContainText('3Documents');
  const matches = rail.locator('[data-panel-section="matches"]');
  await expect(matches).toContainText('Revenue playbook');
  await expect(matches).toContainText('Pricing decision');
  await expect(matches.locator('.memory-scope-chip.scope-business')).toBeVisible();
  await expect(rail.locator('[data-source-type="Workspace document"]')).toContainText('docs/revenue.md');
  await expect(rail).toContainText('Semantic vector retrieval is not connected yet.');
});

test('remember phrasing surfaces a confirm-before-save memory draft', async ({ page }) => {
  const { memoryPosts } = await mockAgentWorkspace(page);
  await openAgent(page);

  await routeRequest(page, 'Remember that I prefer dark mode and concise summaries');
  await expect(page.locator('.intent-message[data-agent-intent="knowledge"]')).toBeVisible();

  const rail = page.locator('#agent-details-panel[data-agent-intent="knowledge"]');
  const draft = rail.locator('[data-panel-section="memory-draft"]');
  await expect(draft).toBeVisible();
  expect(memoryPosts).toHaveLength(0); // nothing saved until confirmed

  await draft.getByRole('button', { name: 'Save to memory' }).click();
  await expect(draft.getByRole('status')).toContainText('Saved to user memory');
  expect(memoryPosts).toHaveLength(1);
  expect(memoryPosts[0].scope).toBe('user');
});

test('troubleshooting requests combine diagnostic checks with retained log signals', async ({ page }) => {
  const jobs = [{
    id: 'failed-run-1',
    kind: 'coding',
    taskIdentifier: 'WEB-17',
    taskTitle: 'Deploy checkout',
    status: 'error',
    error: 'Deployment timed out.',
    updatedAt: '2026-07-23T10:02:00.000Z',
    steps: [{
      ts: '2026-07-23T10:01:00.000Z',
      level: 'warning',
      message: 'Health check did not become ready.',
    }],
  }];
  const diagnostics = {
    checks: [
      { id: 'gateway', label: 'Gateway', status: 'ok', summary: 'Gateway is ready.' },
      { id: 'planner', label: 'Planner', status: 'attention', summary: 'Planner response is slow.', action: 'Inspect planner logs.' },
      { id: 'coder', label: 'Coder', status: 'unavailable', summary: 'Coder is unavailable.' },
    ],
  };
  await mockAgentWorkspace(page, { diagnostics, jobs });
  await openAgent(page);

  await routeRequest(page, 'Troubleshoot the failed checkout deployment and inspect its logs');
  await expect(page.locator('.intent-message[data-agent-intent="troubleshooting"]')).toBeVisible();

  const rail = page.locator('#agent-details-panel[data-agent-intent="troubleshooting"]');
  const diagnosticPanel = rail.locator('[data-panel-section="diagnostics"]');
  const logPanel = rail.locator('[data-panel-section="logs"]');
  await expect(diagnosticPanel).toBeVisible();
  await expect(diagnosticPanel.locator('[data-tone="green"]')).toContainText('1Ready');
  await expect(diagnosticPanel.locator('[data-tone="amber"]')).toContainText('1Attention');
  await expect(diagnosticPanel.locator('[data-tone="red"]')).toContainText('1Blocked');
  await expect(rail.locator('.diagnostic-rail-card')).toHaveCount(3);
  await expect(logPanel).toBeVisible();
  await expect(logPanel).toContainText('Deployment timed out.');
  await expect(logPanel).toContainText('Health check did not become ready.');
});

test('implementation drafts require project selection and explicit approval before task creation', async ({ page }) => {
  const { issuePosts } = await mockAgentWorkspace(page, {
    projects: [
      { id: 'project-checkout', name: 'Checkout Platform' },
      { id: 'project-growth', name: 'Growth Experiments' },
    ],
  });
  await openAgent(page);

  const request = 'Implement a redesigned checkout button in the payment UI';
  await routeRequest(page, request);
  await expect(page.locator('.intent-message[data-agent-intent="implementation"]')).toBeVisible();

  const rail = page.locator('#agent-details-panel[data-agent-intent="implementation"]');
  const draft = rail.locator('[data-panel-section="task-draft"]');
  const project = draft.getByRole('combobox', { name: 'Project for this task' });
  const approval = draft.getByRole('checkbox');
  const create = draft.getByRole('button', { name: 'Create project task' });
  await expect(draft).toBeVisible();
  await expect(draft.getByRole('textbox', { name: 'Task title' })).toHaveValue(request);
  await expect(draft.getByRole('textbox', { name: 'Task description' })).toContainText(request);
  await expect(create).toBeDisabled();
  expect(issuePosts).toHaveLength(0);

  await project.selectOption('project-checkout');
  await expect(create).toBeDisabled();
  expect(issuePosts).toHaveLength(0);

  await approval.check();
  await expect(create).toBeEnabled();
  await project.selectOption('');
  await expect(create).toBeDisabled();
  expect(issuePosts).toHaveLength(0);

  await project.selectOption('project-checkout');
  await expect(create).toBeEnabled();
  await create.click();
  await expect(draft.getByRole('status')).toContainText('WEB-42 created');

  expect(issuePosts).toHaveLength(1);
  expect(issuePosts[0]).toMatchObject({
    projectId: 'project-checkout',
    title: request,
    priority: 2,
  });
  expect(issuePosts[0].description).toContain('**Acceptance criteria**');
  expect(issuePosts[0].idempotencyKey).toMatch(/^agent:/);
});
