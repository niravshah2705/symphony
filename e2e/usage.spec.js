'use strict';

const { test, expect } = require('@playwright/test');

// The Usage page is a pure client of the billing service's read-only FlexPrice
// routes (services/billing/src/flexprice-reads.js). These specs stub exactly that
// surface, so what is under test is the page's contract with it: which numbers it
// draws, what it does with a `null`, and that it never talks to FlexPrice itself.

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const money = (credits) => ({ tokenCredits: Math.round(credits * 100), credits: credits.toFixed(2), inr: credits.toFixed(2) });

const SUMMARY = {
  currency: 'INR',
  balanceInr: 3760,
  fundsAvailable: true,
  fundState: 'available',
  gatePolicy: 'enforce',
  sweepEnabled: true,
  isAdmin: true,
  paymentInfo: { billingName: 'Max Operator', billingEmail: 'max@example.com', billingPhone: '9999999999', provider: 'cashfree' },
  spend: { week: { runs: 12, tokens: 4000, costInr: 90 } },
};

const OVERVIEW = {
  degraded: false,
  currency: 'INR',
  balance: money(3760),
  fundState: 'available',
  gatePolicy: 'enforce',
  walletResolved: true,
  isAdmin: true,
  asOf: '2026-11-20T12:00:00.000Z',
  planCredits: { total: money(7000), used: money(1240), remaining: money(5760), pctUsed: 17.7, rowCount: 2, unreadableRows: 0, resetsOn: '2026-12-14T00:00:00.000Z' },
  addOnCredits: { total: money(3200.5), used: money(1409.5), remaining: money(1791), pctUsed: 44, rowCount: 3, unreadableRows: 0, packCount: 2 },
  creditPacks: [{ id: 'p1', reason: 'PURCHASED_CREDIT_DIRECT', ...money(791), total: money(2200), expiresAt: null, orderId: 'order_org_1' }],
  packages: [{ id: 'g1', name: 'Annual commitment', reason: 'CREDIT_NOTE', remaining: money(8000), total: money(9000), expiresAt: '2026-11-21T00:00:00.000Z' }],
  otherCredits: { total: money(10), used: money(0), remaining: money(10), pctUsed: 0, rowCount: 1, unreadableRows: 0 },
};

const dayCells = (count) => Array.from({ length: count }, (_, index) => {
  const date = new Date(Date.UTC(2026, 7, 22) + index * 86400000).toISOString().slice(0, 10);
  const credits = index % 7 === 0 ? 7 : 1;
  return { date, unreadable: false, ...money(credits) };
});

const HEATMAP = {
  degraded: false,
  meter: 'fleet.llm_cost',
  weeks: 13,
  total: money(640.88),
  partial: false,
  unreadableBuckets: 0,
  days: dayCells(91),
};

const TREND = {
  degraded: false,
  meter: 'fleet.llm_cost',
  range: '7d',
  window: { startUtc: '2026-11-14T00:00:00.000Z', endUtc: '2026-11-21T00:00:00.000Z', days: 7 },
  filters: {},
  filterableDimensions: ['project', 'user', 'agent', 'tier'],
  total: money(28),
  bucketed: true,
  unreadableBuckets: 0,
  peak: { date: '2026-11-20', ...money(7) },
  points: dayCells(7).map((cell, index) => ({ ...cell, date: `2026-11-${14 + index}` })),
};

const BREAKDOWN = {
  degraded: false,
  dimension: 'project',
  property: 'project_id',
  range: '7d',
  values: [
    { value: 'proj_alpha', bucketed: true, total: money(18), unreadable: false },
    { value: 'proj_beta', bucketed: true, total: money(10), unreadable: false },
  ],
  source: 'fleet_usage_records',
};

const LOG_USED = {
  degraded: false,
  tab: 'used',
  limit: 12,
  offset: 0,
  walletResolved: true,
  total: 3482,
  nextOffset: 12,
  note: 'Wallet debits are posted when an invoice is finalized, not per agent run.',
  rows: [
    { id: 'd1', at: '2026-11-10T08:00:00.000Z', reason: 'INVOICE_PAYMENT', reasonLabel: 'Invoice payment', kind: 'movement', amount: money(150), remaining: money(0), balanceAfter: money(3610), expiresAt: null, orderId: 'order_org_9', provider: 'cashfree', description: null },
    { id: 'd2', at: '2026-11-11T08:00:00.000Z', reason: 'CREDIT_EXPIRED', reasonLabel: 'Expired credits', kind: 'adjustment', amount: money(40), remaining: money(0), balanceAfter: money(3570), expiresAt: null, orderId: null, provider: null, description: null },
  ],
};

const LOG_EARNED = { ...LOG_USED, tab: 'earned', total: 4, nextOffset: null, note: null, rows: [
  { id: 'c1', at: '2026-11-01T09:00:00.000Z', reason: 'PURCHASED_CREDIT_DIRECT', reasonLabel: 'Purchased credits', kind: 'movement', amount: money(500), remaining: money(410), balanceAfter: money(410), expiresAt: null, orderId: 'order_9', provider: 'cashfree', description: null },
] };

// One handler answers the whole read surface, dispatched on the path segment the
// page requested. The log tab is a query parameter, so it is answered from either
// body: a single stub for both would hide a page that never passes `tab` at all.
async function stubBilling(page, overrides = {}) {
  const requests = [];
  const bodies = {
    summary: SUMMARY,
    overview: OVERVIEW,
    heatmap: HEATMAP,
    trend: TREND,
    breakdown: BREAKDOWN,
    earned: LOG_EARNED,
    used: LOG_USED,
  };
  const merged = Object.fromEntries(Object.entries(bodies)
    .map(([key, value]) => [key, overrides[key] === undefined ? value : overrides[key]]));

  await page.route('**/api/**', (route) => json(route, {}));
  await page.route('**/api/billing/**', (route) => {
    const url = new URL(route.request().url());
    const section = url.pathname.split('/').pop();
    const body = section === 'log'
      ? merged[url.searchParams.get('tab') === 'used' ? 'used' : 'earned']
      : merged[section];
    requests.push(`${url.pathname}${url.search}`);
    return json(route, body === undefined ? {} : body);
  });
  return requests;
}

test('the usage page draws the FlexPrice reads, and never FlexPrice itself', async ({ page }) => {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  const outbound = [];
  page.on('request', (request) => outbound.push(request.url()));

  await stubBilling(page);
  const response = await page.goto('/#/usage', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok()).toBeTruthy();
  await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#view > .error-banner')).toHaveCount(0);

  // The grid is the mock's 13x7: 91 dated cells and nothing invented around them.
  await expect(page.locator('.usage-cell[data-date]')).toHaveCount(91);
  await expect(page.locator('.usage-heatmap')).toBeVisible();
  await expect(page.locator('.usage-trend-line')).toBeVisible();
  await expect(page.locator('.usage-trend-svg')).toHaveCount(1);

  // Balance, plan and add-on come from the routes, formatted as credits.
  await expect(page.locator('.metric-card').first()).toContainText('3,760');
  await expect(page.locator('.usage-credit-card').first()).toContainText('1,240 / 7,000');
  await expect(page.locator('.usage-credit-card').nth(1)).toContainText('1,791');

  // The org is never sent from the browser: no org id, no key, no FlexPrice host.
  const billingCalls = outbound.filter((url) => url.includes('/api/billing/flexprice/'));
  expect(billingCalls.length).toBeGreaterThan(0);
  expect(billingCalls.some((url) => /orgId|org_id|x-api-key/i.test(url))).toBe(false);
  expect(outbound.some((url) => /flexprice\.local|:18080|\/v1\//.test(url))).toBe(false);
  expect(browserErrors).toEqual([]);
});

test('the credits log switches tabs by refetching, and keeps the debit explanation', async ({ page }) => {
  const seen = await stubBilling(page);
  await page.goto('/#/usage', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#usage-log-section table tbody tr')).toHaveCount(1);

  await page.getByRole('button', { name: 'Used' }).click();
  await expect(page.locator('#usage-log-section table tbody tr')).toHaveCount(2);
  // An expiring credit is an adjustment, not consumption — the row says which.
  await expect(page.locator('#usage-log-section .status-pill.warn')).toHaveCount(1);
  await expect(page.locator('#usage-log-section')).toContainText('Wallet debits are posted when an invoice is finalized');
  await expect(page.locator('#usage-log-section')).toContainText('Showing 1 to 2 of 3,482');
  expect(seen.filter((url) => url.includes('tab=used')).length).toBe(1);
});

test('a degraded read shows why, and never a zero balance', async ({ page }) => {
  const degraded = { degraded: true, reason: 'read_failed', reasonDetail: 'FlexPrice refused the read', asOf: '2026-11-20T12:00:00.000Z' };
  await stubBilling(page, {
    overview: { ...degraded, currency: 'INR', balance: { tokenCredits: null, credits: null, inr: null }, planCredits: null, addOnCredits: null, creditPacks: [], packages: [], walletResolved: false },
    heatmap: { ...degraded, weeks: 13, total: { tokenCredits: null, credits: null, inr: null }, days: [] },
    trend: { ...degraded, points: [], total: { tokenCredits: null, credits: null, inr: null }, bucketed: false, filters: {} },
    breakdown: { ...degraded, dimension: 'project', values: [] },
    earned: { ...degraded, tab: 'earned', rows: [], total: null, nextOffset: null },
  });

  await page.goto('/#/usage', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.notice')).toHaveCount(4, 'credits, heatmap, trend and log each explain themselves once');
  await expect(page.locator('.metric-card').first()).toContainText('Unavailable');
  // The number this page must never print for a failed read is a confident zero.
  await expect(page.locator('#view')).not.toContainText('0.00');
  await expect(page.locator('.usage-cell[data-date]')).toHaveCount(0, 'no grid is drawn from a read that failed');
});

test('the trend refetch keeps the filter on the range it was asked for', async ({ page }) => {
  const seen = await stubBilling(page);
  await page.goto('/#/usage', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'MTD' }).click();
  await expect.poll(() => seen.filter((url) => url.includes('range=mtd')).length).toBe(2, 'trend and breakdown both move to the new window');
  // The chart is replaced, not appended: a second svg would mean a stale draw.
  await expect(page.locator('.usage-trend-svg')).toHaveCount(1);
});

test('usage is a lazy Insights route with its own stylesheet', async ({ page }) => {
  const assets = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/js/views/') || path.startsWith('/styles/')) assets.push(path);
  });
  await stubBilling(page);
  await page.goto('/#/settings', { waitUntil: 'domcontentloaded' });
  expect(assets).not.toContain('/js/views/usage.js');

  const link = page.locator('#tabs a[data-route="usage"]');
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator('body')).toHaveAttribute('data-route', 'usage');
  expect(assets).toContain('/js/views/usage.js');
  await expect(page.locator('link[rel="stylesheet"][href$="/styles/usage.css"]')).toHaveCount(1);
});
