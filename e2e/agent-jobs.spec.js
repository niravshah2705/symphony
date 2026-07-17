'use strict';

const { test, expect } = require('@playwright/test');

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockShell(page, { locale = 'en' } = {}) {
  await page.addInitScript((savedLocale) => {
    localStorage.setItem('ai-fleet.locale', savedLocale);
    localStorage.setItem('lm.lastWorkspaceRoute', 'agent');
  }, locale);
  await page.route('**/api/auth/config', (route) => json(route, { mode: 'disabled', enabled: false }));
  await page.route('**/api/locale/suggestions**', (route) => json(route, {
    locale,
    suggestions: [
      { tag: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' },
      { tag: 'gu-IN', label: 'Gujarati', nativeLabel: 'ગુજરાતી', direction: 'ltr' },
    ],
  }));
  await page.route('**/api/locale/translate', async (route) => {
    const payload = route.request().postDataJSON();
    await json(route, { locale: payload.locale, translations: payload.texts || [] });
  });
  await page.route('**/api/settings', (route) => json(route, {
    hasKey: false,
    planningConfigured: false,
    planningProvider: 'linear',
  }));
  await page.route('**/api/roles/assumed', (route) => json(route, { assumedRole: null }));
}

function mixedJobs() {
  const base = '2026-07-16T10:00:00.000Z';
  const planner = [
    { id: 'plan-1', kind: 'enrichment', projectName: 'Planner Alpha', status: 'done', createdAt: base, summary: { milestonesCreated: 2, issuesCreated: 6, dependenciesCreated: 1 }, steps: [] },
    { id: 'plan-2', projectName: 'Legacy planner job', status: 'error', createdAt: base, error: 'Planning stopped safely.', steps: [] },
    { id: 'plan-3', kind: 'planning', projectName: 'Planner Gamma', status: 'pending', createdAt: base, steps: [] },
    { id: 'plan-4', kind: 'planning', projectName: 'Cancelled planner job', status: 'cancelled', createdAt: base, steps: [] },
  ];
  const coding = Array.from({ length: 6 }, (_, index) => ({
    id: `code-${index}`,
    kind: 'coding',
    projectName: 'Coding project',
    taskIdentifier: `JOB-${index + 1}`,
    taskTitle: `Coding task ${index + 1}`,
    status: index === 5 ? 'running' : 'done',
    createdAt: base,
    summary: { coding: true, outcome: 'completed' },
    steps: index === 0 ? [{ ts: base, level: 'info', message: 'Prepared a safe workspace.' }] : [],
    ...(index === 0 ? {
      traceUrl: 'https://example.com/traces/code-0',
      taskUrl: 'https://example.com/tasks/code-0',
    } : {}),
  }));
  return [...planner, ...coding, {
    id: 'future-1',
    kind: 'review',
    taskTitle: 'Future workflow job',
    status: 'done',
    createdAt: base,
    traceUrl: 'javascript:alert(1)',
    taskUrl: 'https://operator:secret@example.com/tasks/future-1',
    steps: [],
  }];
}

test('Agent jobs restores complete grouped planner and coding history', async ({ page }) => {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await mockShell(page);

  let jobs = mixedJobs();
  await page.route('**/api/agent/jobs**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'DELETE' && url.pathname !== '/api/agent/jobs') {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      jobs = jobs.filter((job) => job.id !== id);
      return json(route, { ok: true });
    }
    if (route.request().method() === 'DELETE') {
      jobs = jobs.filter((job) => ['pending', 'running'].includes(job.status));
      return json(route, { jobs });
    }
    return json(route, { jobs });
  });

  const response = await page.goto('/#/agent-jobs', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#route-title')).toHaveText('Agent jobs');
  await expect(page).toHaveTitle('AI Fleet — Agent jobs');
  await expect(page.locator('#tabs a[data-route="agent-jobs"]')).toHaveAttribute('aria-current', 'page');

  await expect(page.locator('.job-history-row')).toHaveCount(11);
  await expect(page.locator('.job-history-section[data-job-kind="planner"] .job-history-row')).toHaveCount(4);
  await expect(page.locator('.job-history-section[data-job-kind="coding"] .job-history-row')).toHaveCount(6);
  await expect(page.locator('.job-history-section[data-job-kind="other"] .job-history-row')).toHaveCount(1);
  await expect(page.getByText('Legacy planner job', { exact: true })).toBeVisible();
  await expect(page.getByText('Cancelled planner job', { exact: true })).toBeVisible();

  const codingJob = page.locator('.job-history-row[data-job-id="code-0"]');
  await expect(codingJob.getByRole('link', { name: 'Open trace' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(codingJob.getByRole('link', { name: 'Open task' })).toHaveAttribute('target', '_blank');
  const futureJob = page.locator('.job-history-row[data-job-id="future-1"]');
  await expect(futureJob.getByRole('link', { name: 'Open trace' })).toHaveCount(0);
  await expect(futureJob.getByRole('link', { name: 'Open task' })).toHaveCount(0);

  const activity = codingJob.locator('.job-history-activity');
  await activity.click();
  await expect(activity).toHaveAttribute('aria-expanded', 'true');
  await expect(codingJob.getByText('Prepared a safe workspace.')).toBeVisible();

  await codingJob.getByRole('button', { name: 'Delete' }).click();
  await codingJob.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.locator('.job-history-row[data-job-id="code-0"]')).toHaveCount(0);
  await expect(page.locator('.job-history-row')).toHaveCount(10);
  await expect(page.locator('.job-history-row[data-job-id="code-5"]').getByRole('button', { name: 'Delete' })).toHaveCount(0);

  const clearFinished = page.locator('.job-history-page-actions button.danger');
  await expect(clearFinished).toHaveText('Clear finished (8)');
  await clearFinished.click();
  await expect(clearFinished).toHaveText('Confirm clear 8');
  await clearFinished.click();
  await expect(page.locator('.job-history-row')).toHaveCount(2);
  await expect(page.locator('.job-history-row[data-job-id="plan-3"]')).toBeVisible();
  await expect(page.locator('.job-history-row[data-job-id="code-5"]')).toBeVisible();
  await expect(page.locator('.job-history-row[data-job-id="plan-4"]')).toHaveCount(0);
  await expect(clearFinished).toHaveText('Clear finished (0)');
  await expect(clearFinished).toBeDisabled();
  expect(browserErrors).toEqual([]);
});

test('Agent jobs exposes load failures and retries successfully', async ({ page }) => {
  await mockShell(page);
  let unavailable = true;
  await page.route('**/api/agent/jobs**', (route) => unavailable
    ? json(route, { error: 'Planner history is temporarily unavailable.' }, 503)
    : json(route, { jobs: mixedJobs().slice(0, 2) }));

  await page.goto('/#/agent-jobs', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('alert')).toContainText('Planner history is temporarily unavailable.');
  unavailable = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.job-history-row')).toHaveCount(2);
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
});

test('Agent jobs rejects a malformed successful response and retries', async ({ page }) => {
  await mockShell(page);
  let malformed = true;
  await page.route('**/api/agent/jobs**', (route) => malformed
    ? json(route, { ok: true })
    : json(route, { jobs: mixedJobs().slice(0, 2) }));

  await page.goto('/#/agent-jobs', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('alert')).toContainText(/invalid response/i);
  await expect(page.locator('.job-history-row')).toHaveCount(0);

  malformed = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.job-history-row')).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Agent jobs preserves row focus and defers refresh while delete is armed', async ({ page }) => {
  await mockShell(page);
  const base = '2026-07-16T10:00:00.000Z';
  let jobs = [{
    id: 'focus-job',
    kind: 'coding',
    taskIdentifier: 'FOCUS-1',
    taskTitle: 'Original task title',
    status: 'done',
    createdAt: base,
    updatedAt: base,
    steps: [],
  }];
  await page.route('**/api/agent/jobs**', (route) => json(route, { jobs }));

  await page.goto('/#/agent-jobs', { waitUntil: 'domcontentloaded' });
  const row = page.locator('.job-history-row[data-job-id="focus-job"]');
  const activity = row.getByRole('button', { name: /Show activity/ });
  await activity.focus();
  await expect(activity).toBeFocused();

  jobs = [{
    ...jobs[0],
    taskTitle: 'Refreshed task title',
    updatedAt: '2026-07-16T10:01:00.000Z',
  }];
  const focusRefresh = page.waitForResponse((response) =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/agent/jobs'
  );
  await page.locator('.job-history-page-actions button', { hasText: 'Refresh' }).evaluate((button) => button.click());
  await focusRefresh;
  await expect(row.getByText('FOCUS-1 · Refreshed task title')).toBeVisible();
  await expect(activity).toBeFocused();

  const remove = row.getByRole('button', { name: 'Delete' });
  await remove.click();
  await expect(remove).toHaveText('Confirm delete');
  jobs = [{
    ...jobs[0],
    taskTitle: 'Deferred task title',
    updatedAt: '2026-07-16T10:02:00.000Z',
  }];
  const deferredRefresh = page.waitForResponse((response) =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/agent/jobs'
  );
  await page.locator('.job-history-page-actions button', { hasText: 'Refresh' }).evaluate((button) => button.click());
  await deferredRefresh;

  await expect(remove).toHaveText('Confirm delete');
  await expect(row.getByText('FOCUS-1 · Refreshed task title')).toBeVisible();
  await expect(row.getByText('FOCUS-1 · Deferred task title')).toHaveCount(0);
});

test('Agent jobs route and menu use the selected Gujarati locale', async ({ page }) => {
  await mockShell(page, { locale: 'gu-IN' });
  await page.route('**/api/agent/jobs**', (route) => json(route, { jobs: [] }));

  await page.goto('/#/agent-jobs', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#route-title')).toHaveText('એજન્ટ જોબ્સ');
  await expect(page.locator('#view h1')).toHaveText('એજન્ટ જોબ્સ');
  const link = page.locator('#tabs a[data-route="agent-jobs"]');
  await expect(link.locator('strong')).toHaveText('એજન્ટ જોબ્સ');
  await expect(link.locator('small')).toHaveText('યોજના અને કોડિંગનો ઇતિહાસ');
  await expect(link).toHaveAttribute('aria-current', 'page');
});
