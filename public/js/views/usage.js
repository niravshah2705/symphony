import { api } from '../api.js';
import { el, clear, loading, toast } from '../dom.js';
import { t, formatNumber, formatDate } from '../i18n.js';
import { payRecharge, isSettled } from '../recharge.js';
import { heatmapSpec, trendSpec, mount } from '../usage-charts.mjs';

// The Usage page: credit buckets, consumption and the credits log, every number
// read from this deployment's FlexPrice wallet through the billing service's
// read-only routes (services/billing/src/flexprice-reads.js).
//
// Two rules shape everything below.
//
// 1. Nothing on this page invents a number. A read that failed answers with
//    `null`, and `null` is rendered as "Unavailable" — never as 0, which on a
//    credits page means "you have nothing left". `creditsText()` is the only
//    place that decision lives.
// 2. The org is never sent from here. The gateway resolves it from the caller's
//    token and the billing service resolves the wallet, so this file has no org
//    id, no FlexPrice key and no FlexPrice URL in it.
//
// DOM is built with el() and the chart specs in usage-charts.mjs; no value ever
// reaches an `html`/innerHTML path, so a credit-pack description or a project id
// cannot open a tag.

const HEATMAP_WEEKS = 13;
const LOG_PAGE = 12;
const RANGES = [
  { key: '1d', label: '1d' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: 'mtd', label: 'MTD' },
  { key: 'last-month', label: 'Last month' },
];
const LOG_TABS = [
  { key: 'used', labelKey: 'usageLogUsed', fallback: 'Used' },
  { key: 'earned', labelKey: 'usageLogEarned', fallback: 'Earned / Recharged' },
];

// The page keeps its own view state (which window, which tab) across navigations
// inside the session, the same way Cost keeps its group-by.
let range = '7d';
let dimension = 'project';
let dimensionValue = '';
let logTab = 'earned';
let logOffset = 0;
let renderGeneration = 0;

/** Called by the router when this view is re-entered: stale fetches must not write. */
export function invalidate() {
  renderGeneration += 1;
}

/**
 * One settled read. A rejection becomes the same envelope the server sends when
 * it knows it has nothing, so the render path has one shape to handle rather
 * than a try/catch per section.
 */
async function read(promise, coldShape) {
  try {
    return await promise;
  } catch (err) {
    return { degraded: true, reason: 'read_failed', reasonDetail: (err && err.message) || 'unreachable', ...coldShape };
  }
}

const creditText = (field) => {
  if (!field || field.credits === null || field.credits === undefined) return t('usageUnknown', 'Unavailable');
  return formatNumber(Number(field.credits));
};

const inrText = (field) => {
  if (!field || field.inr === null || field.inr === undefined) return t('usageUnknown', 'Unavailable');
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(field.inr));
};

const dateText = (value) => (value ? formatDate(value, { dateStyle: 'medium' }) : '—');

/** Why this section is empty, in the section's own words. */
function noticeFor(body, { fallback = null } = {}) {
  if (!body || !body.degraded) return null;
  const detail = body.note || body.reasonDetail || fallback;
  return el('div', { class: 'notice operational-notice' }, [
    el('strong', {}, noticeTitle(body.reason)),
    detail ? el('span', {}, ` ${detail}`) : null,
  ]);
}

function noticeTitle(reason) {
  if (reason === 'not_provisioned') return t('usageNotProvisioned', 'FlexPrice is not provisioned for this organization.');
  if (reason === 'wallet_missing') return t('usageNotProvisioned', 'FlexPrice is not provisioned for this organization.');
  if (reason === 'flexprice_disabled') return 'FlexPrice is disabled on this deployment (FLEXPRICE_ENABLED is off).';
  if (reason === 'unknown_dimension') return 'That dimension cannot be broken down.';
  return t('usageReadFailed', 'FlexPrice could not answer this read, so the figures below are unavailable rather than zero.');
}

function asOf(body) {
  if (!body || !body.asOf) return null;
  return el('span', { class: 'usage-asof' }, `${t('asOf', 'As of')} ${formatDate(body.asOf, { dateStyle: 'short', timeStyle: 'short' })}`);
}

export async function renderUsage(view) {
  const generation = renderGeneration;
  clear(view).append(loading(t('usageLoading', 'Loading usage…')));

  const [summary, overview, heatmap, trend, breakdown, log] = await Promise.all([
    read(api.billing.getSummary(), {}),
    read(api.billing.getFlexpriceOverview(), { balance: null, planCredits: null, addOnCredits: null, creditPacks: [], packages: [] }),
    read(api.billing.getFlexpriceHeatmap({ weeks: HEATMAP_WEEKS }), { weeks: HEATMAP_WEEKS, days: [], total: null }),
    read(api.billing.getFlexpriceTrend({ range }), { points: [], total: null, bucketed: false, filters: {} }),
    read(api.billing.getFlexpriceBreakdown({ dimension, range, limit: 10 }), { values: [] }),
    read(api.billing.getFlexpriceLog({ tab: logTab, limit: LOG_PAGE, offset: logOffset }), { rows: [], total: null }),
  ]);
  if (generation !== renderGeneration) return;

  const trendHost = el('section', { class: 'operational-panel usage-section', id: 'usage-trend-section' });
  const logHost = el('section', { class: 'operational-panel usage-section', id: 'usage-log-section' });

  const content = [
    el('div', { class: 'page-head operational-head' }, [
      el('div', {}, [
        el('h1', {}, t('usage', 'Usage')),
        el('p', { class: 'muted' }, t('usageSourceNote', 'Credits, balance and consumption come from this deployment’s FlexPrice wallet — the same ledger that gates agent runs.')),
      ]),
      el('div', { class: 'usage-head-actions' }, [
        asOf(overview),
        el('button', { type: 'button', onclick: () => renderUsage(view) }, t('refresh', 'Refresh')),
      ]),
    ]),
    balanceStrip(summary, overview),
    noticeFor(overview),
    creditCards(overview),
    purchasePanel(view, summary, overview),
    packageList(overview),
    heatmapSection(heatmap),
    trendHost,
    logHost,
  ].filter(Boolean);
  clear(view).append(...content);

  drawTrend(trendHost, trend, breakdown);
  drawLog(logHost, log);
}

/** The two numbers that must agree: the gate's balance and the wallet's buckets. */
function balanceStrip(summary, overview) {
  const balance = overview.balance;
  const state = overview.fundState || summary.fundState || 'unknown';
  const stateNote = state === 'available'
    ? (overview.gatePolicy === 'off' ? t('usageGateOff', 'Gate off — nothing enforced') : t('usageGateActive', 'Active & ready'))
    : state === 'exhausted'
      ? t('usageGatePaused', 'Runners & scheduler paused')
      : state === 'negative'
        ? t('usageGateNegative', 'A platform debit exceeded the wallet')
        : t('usageGateUnknown', 'The wallet could not be read, so nothing is enforced');
  return el('section', { class: 'metric-grid', 'aria-label': t('usageCreditsAria', 'Credits') }, [
    metric(t('usageBalance', 'Available balance'), creditText(balance), `${overview.currency || 'INR'} · ${inrText(balance)}`),
    metric(t('fundStatus', 'Fund status'), stateLabel(state), stateNote),
    metric(t('usagePlanCredits', 'Plan Credits'), overview.planCredits ? `${creditText(overview.planCredits.remaining)} / ${creditText(overview.planCredits.total)}` : t('usageUnknown', 'Unavailable'),
      overview.planCredits?.resetsOn ? t('usageResetsOn', 'Resets {date}', { date: dateText(overview.planCredits.resetsOn) }) : null),
    metric(t('usageAddonCredits', 'Add-on Credits'), overview.addOnCredits ? creditText(overview.addOnCredits.remaining) : t('usageUnknown', 'Unavailable'),
      overview.addOnCredits ? t('usagePackCount', '{count} credit packs', { count: overview.addOnCredits.packCount }) : null),
  ]);
}

function stateLabel(state) {
  return { available: 'Available', exhausted: 'Out of credit', negative: 'Negative', unknown: 'Unknown' }[state] || 'Unknown';
}

function metric(label, value, note) {
  return el('article', { class: 'metric-card' }, [
    el('span', { class: 'metric-label' }, label),
    el('strong', { class: 'metric-value' }, value),
    note ? el('span', { class: 'metric-note' }, note) : null,
  ]);
}

/** Plan vs add-on, each as used-of-total. `null` totals are drawn as unknown. */
function creditCards(overview) {
  const card = (title, bucket, footNote) => {
    if (bucket === null || bucket === undefined) {
      return el('article', { class: 'usage-credit-card' }, [
        el('div', { class: 'usage-credit-top' }, [el('h3', {}, title), el('span', { class: 'usage-unknown' }, t('usageUnknown', 'Unavailable'))]),
        el('p', { class: 'muted' }, t('usageNoBucket', 'No credit rows of this kind were returned.')),
      ]);
    }
    const pct = Number.isFinite(bucket.pctUsed) ? Math.min(100, Math.max(0, bucket.pctUsed)) : null;
    return el('article', { class: 'usage-credit-card' }, [
      el('div', { class: 'usage-credit-top' }, [
        el('h3', {}, title),
        el('strong', { class: 'usage-credit-left' }, `${creditText(bucket.remaining)} ${t('usageLeft', 'left')}`),
      ]),
      el('p', { class: 'usage-credit-figure' }, [
        el('strong', {}, `${creditText(bucket.used)} / ${creditText(bucket.total)}`),
        pct === null ? null : el('span', { class: 'muted' }, ` (${pct}%)`),
      ]),
      el('div', { class: 'usage-meter', role: 'img', 'aria-label': pct === null ? t('usageUnknown', 'Unavailable') : `${pct}% used` }, [
        el('div', { class: `usage-meter-fill${pct === null ? '' : pct >= 90 ? ' bad' : pct >= 70 ? ' warn' : ''}`, style: `width:${pct === null ? 0 : pct}%` }),
      ]),
      el('div', { class: 'usage-credit-foot' }, [
        el('span', {}, footNote || (bucket.resetsOn
          ? t('usageResetsOn', 'Resets {date}', { date: dateText(bucket.resetsOn) })
          : t('usageRowCount', '{count} credit rows', { count: bucket.rowCount }))),
        bucket.unreadableRows ? el('span', { class: 'usage-cell-adjustment' }, t('usageUnreadableRows', '{count} rows could not be read', { count: bucket.unreadableRows })) : null,
      ]),
    ]);
  };
  return el('section', { class: 'usage-credit-grid usage-section' }, [
    card(t('usagePlanCredits', 'Plan Credits'), overview.planCredits, overview.planCredits?.resetsOn
      ? t('usageResetsOn', 'Resets {date}', { date: dateText(overview.planCredits.resetsOn) }) : null),
    card(t('usageAddonCredits', 'Add-on Credits & Token Packs'), overview.addOnCredits,
      t('usagePackCount', '{count} credit packs', { count: overview.addOnCredits?.packCount ?? 0 })),
  ]);
}

function packageList(overview) {
  const packs = Array.isArray(overview.packages) ? overview.packages : [];
  const rows = Array.isArray(overview.creditPacks) ? overview.creditPacks : [];
  if (!packs.length && !rows.length) return null;
  return el('section', { class: 'operational-panel usage-section' }, [
    el('div', { class: 'panel-heading' }, [
      el('div', {}, [
        el('h2', {}, t('usagePackages', 'Dedicated Resource Packages')),
        el('p', { class: 'muted' }, t('usagePackagesNote', 'A package here is a credit balance FlexPrice holds an expiry for; the marketing tiers are not a wallet concept.')),
      ]),
    ]),
    el('div', { class: 'usage-pack-list' }, packs.map((pack) => el('div', { class: 'usage-pack-row' }, [
      el('span', {}, pack.name || pack.reason || '—'),
      el('span', { class: 'usage-pack-amount' }, `${creditText(pack.remaining)} / ${creditText(pack.total)}`),
      el('span', { class: 'usage-pack-expiry' }, pack.expiresAt ? t('usageExpiresOn', 'Expires {date}', { date: dateText(pack.expiresAt) }) : '—'),
    ]))),
    rows.length ? el('p', { class: 'usage-log-note' }, t('usageLiveGrants', '{count} live credit balances in total.', { count: rows.length })) : null,
  ].filter(Boolean));
}

/** Section 6: the 13-week grid, drawn from the one windowed read. */
function heatmapSection(heatmap) {
  const days = Array.isArray(heatmap.days) ? heatmap.days : [];
  // Today in UTC, the same clock the cells are keyed on: a browser-local "today"
  // would dash the wrong column for anyone east or west of Greenwich.
  const todayIso = new Date().toISOString().slice(0, 10);
  const notice = noticeFor(heatmap, { fallback: t('usageWindowNotBucketed', 'FlexPrice returned this window without day buckets, so daily consumption cannot be shown.') });
  const grid = days.length ? mount(heatmapSpec(days, { weeks: heatmap.weeks || HEATMAP_WEEKS, todayIso })) : null;
  const body = [
    el('div', { class: 'panel-heading' }, [
      el('div', {}, [
        el('h2', {}, t('usageHeatmap', 'Daily consumption')),
        el('p', { class: 'muted' }, t('usageHeatmapNote', 'Credits used per UTC day over the last {weeks} weeks.', { weeks: heatmap.weeks || HEATMAP_WEEKS })),
      ]),
      el('strong', {}, `${creditText(heatmap.total)} ${t('usageCredits', 'credits')}`),
    ]),
    notice,
    grid,
    heatmap.partial ? el('p', { class: 'usage-log-note' }, t('usagePartialGrid', 'Some days could not be read, so the window total is not the sum of the grid.')) : null,
  ].filter(Boolean);
  return el('section', { class: 'operational-panel usage-section' }, body);
}

/** Sections 7 + the breakdown picker; re-drawn when the range or filter changes. */
function drawTrend(host, trend, breakdown) {
  const generation = renderGeneration;
  clear(host);
  const reload = async (next) => {
    if (next.range) range = next.range;
    if (next.dimension) { dimension = next.dimension; dimensionValue = ''; }
    if ('value' in next) dimensionValue = next.value;
    const [freshTrend, freshBreakdown] = await Promise.all([
      read(api.billing.getFlexpriceTrend({ range, ...(dimensionValue ? { [dimension]: dimensionValue } : {}) }), { points: [], total: null, bucketed: false, filters: {} }),
      read(api.billing.getFlexpriceBreakdown({ dimension, range, limit: 10 }), { values: [] }),
    ]);
    if (generation !== renderGeneration) return;
    drawTrend(host, freshTrend, freshBreakdown);
  };

  const pills = el('div', { class: 'usage-pills' }, RANGES.map((item) => el('button', {
    type: 'button',
    class: `usage-pill${item.key === range ? ' active' : ''}`,
    onclick: () => reload({ range: item.key }),
  }, item.label)));

  const dimensions = Array.isArray(trend.filterableDimensions) && trend.filterableDimensions.length
    ? trend.filterableDimensions
    : ['project', 'user', 'agent', 'tier'];
  const dimensionPills = el('div', { class: 'usage-pills' }, dimensions.map((key) => el('button', {
    type: 'button',
    class: `usage-pill${key === dimension ? ' active' : ''}`,
    onclick: () => reload({ dimension: key }),
  }, key)));

  const values = Array.isArray(breakdown.values) ? breakdown.values : [];
  const picker = el('select', { class: 'usage-filter', 'aria-label': t('usageFilter', 'Filter'), onchange: (event) => reload({ value: event.target.value }) }, [
    el('option', { value: '', selected: dimensionValue ? null : 'selected' }, t('usageAllValues', 'All {dimension}', { dimension })),
    ...values.map((entry) => el('option', {
      value: entry.value,
      selected: entry.value === dimensionValue ? 'selected' : null,
      disabled: entry.total && entry.total.paise === null ? 'disabled' : null,
    }, `${entry.value} — ${entry.unreadable ? t('usageUnknown', 'Unavailable') : `${creditText(entry.total)} ${t('usageCredits', 'credits')}`}`)),
  ]);

  const chart = trend.bucketed && Array.isArray(trend.points) && trend.points.length
    ? mount(trendSpec(trend.points, { width: 720, height: 220 }))
    : null;
  const notice = noticeFor(trend, { fallback: t('usageWindowNotBucketed', 'FlexPrice returned this window without day buckets, so daily consumption cannot be shown.') });

  // `append()` would stringify a null into the visible text "null", so the
  // optional pieces are filtered out rather than passed through.
  host.append(...[
    el('div', { class: 'panel-heading' }, [
      el('div', {}, [
        el('h2', {}, t('usageTrend', 'Usage trend')),
        el('p', { class: 'muted' }, t('usageTrendNote', 'Filtered to this organization only; the filter list is built from our own usage records.')),
      ]),
      el('strong', {}, `${creditText(trend.total)} ${t('usageCredits', 'credits')}`),
    ]),
    el('div', { class: 'usage-trend-controls' }, [pills, el('div', { class: 'usage-trend-filter' }, [dimensionPills, picker])]),
    notice,
    chart,
    !trend.bucketed && !trend.degraded
      ? el('p', { class: 'usage-log-note' }, t('usageWindowNotBucketed', 'FlexPrice returned this window without day buckets, so daily consumption cannot be shown.'))
      : null,
    trend.unreadableBuckets ? el('p', { class: 'usage-log-note' }, t('usageUnreadableDays', '{count} days in this window could not be read.', { count: trend.unreadableBuckets })) : null,
  ].filter(Boolean));
}

/** Section 8: the credits log. FlexPrice debits, which are sparse by design. */
function drawLog(host, log) {
  const generation = renderGeneration;
  clear(host);
  const reload = async (next) => {
    if (next.tab) { logTab = next.tab; logOffset = 0; }
    if ('offset' in next) logOffset = next.offset;
    const fresh = await read(api.billing.getFlexpriceLog({ tab: logTab, limit: LOG_PAGE, offset: logOffset }), { rows: [], total: null, tab: logTab });
    if (generation !== renderGeneration) return;
    drawLog(host, fresh);
  };

  const rows = Array.isArray(log.rows) ? log.rows : [];
  const tab = log.tab === 'used' ? 'used' : 'earned';
  const head = ['Timestamp', 'Operation', 'Kind', 'Credits', 'Remaining', 'Balance after', 'Reference'];
  const emptyRow = () => {
    const message = tab === 'used'
      ? t('usageNoUsageRecords', 'No wallet debits in this window. Debits post when an invoice is finalized, not per agent run.')
      : t('usageNoEarnedRecords', 'No credit rows yet — a recharge writes the first one.');
    return el('tr', {}, [el('td', { colspan: String(head.length), class: 'usage-cell-muted' }, message)]);
  };
  const bodyRows = rows.length
    ? rows.map((row) => el('tr', {}, [
      el('td', {}, row.at ? formatDate(row.at, { dateStyle: 'medium', timeStyle: 'short' }) : '—'),
      el('td', {}, row.reasonLabel || row.reason || '—'),
      el('td', {}, el('span', { class: `status-pill ${row.kind === 'adjustment' ? 'warn' : 'ok'}` }, row.kind || 'movement')),
      el('td', {}, signed(row, tab)),
      el('td', {}, creditText(row.remaining)),
      el('td', { class: 'usage-cell-muted' }, creditText(row.balanceAfter)),
      el('td', { class: 'usage-cell-muted' }, row.orderId || row.description || row.provider || '—'),
    ]))
    : [emptyRow()];
  const table = el('div', { class: 'table-scroll' }, [
    el('table', { class: 'operational-table' }, [
      el('thead', {}, [el('tr', {}, head.map((label) => el('th', {}, label)))]),
      el('tbody', {}, bodyRows),
    ]),
  ]);

  host.append(...[
    el('div', { class: 'panel-heading' }, [
      el('div', {}, [el('h2', {}, t('usageLog', 'Credits Log')), el('p', { class: 'muted' }, t('usageLogNote', 'Wallet transactions from FlexPrice, newest first.'))]),
      el('span', { class: 'usage-asof' }, asOfText(log)),
    ]),
    el('div', { class: 'usage-log-tabs' }, LOG_TABS.map((entry) => el('button', {
      type: 'button',
      class: `usage-pill${entry.key === tab ? ' active' : ''}`,
      onclick: () => reload({ tab: entry.key }),
    }, t(entry.labelKey, entry.fallback)))),
    noticeFor(log),
    table,
    log.note ? el('p', { class: 'usage-log-note' }, log.note) : null,
    el('div', { class: 'usage-foot' }, [
      el('span', {}, footerText(log, rows.length)),
      log.nextOffset !== null && log.nextOffset !== undefined
        ? el('button', { type: 'button', class: 'btn', onclick: () => reload({ offset: log.nextOffset }) }, t('loadMore', 'Load more'))
        : null,
    ]),
  ].filter(Boolean));
}

const asOfText = (body) => (body.asOf ? formatDate(body.asOf, { dateStyle: 'short', timeStyle: 'short' }) : '—');

/**
 * The sign comes from the tab the server answered for, not from the row: FlexPrice
 * reports every wallet transaction's magnitude unsigned in `amount` (a credit and a
 * debit row share the field; there is no `debit_amount`), so the direction is a
 * property of the query, and a row cannot contradict it.
 */
function signed(row, tab) {
  const text = creditText(row.amount);
  if (text === t('usageUnknown', 'Unavailable')) return text;
  return `${tab === 'used' ? '−' : '+'} ${text}`;
}

function footerText(log, count) {
  const from = logOffset + 1;
  if (log.total === null || log.total === undefined) {
    return t('usageShowing', 'Showing {count} rows', { count });
  }
  return t('usageShowingOf', 'Showing {from} to {to} of {total}', { from, to: logOffset + count, total: formatNumber(log.total) });
}

/**
 * The Cashfree purchase panel (the mock's "Upgrade / Purchase" callout).
 *
 * It quotes through the server and pays through `recharge.js`, exactly as Cost
 * does: the GST breakdown is not recomputed here, because a second copy of the
 * tax rule in the browser is what made the old "Add credits" button lie. Mandates
 * and Razorpay stay on the Cost page — this page's job is the wallet, not the
 * payment-method settings.
 */
function purchasePanel(view, summary, overview) {
  const isAdmin = Boolean(overview.isAdmin ?? summary.isAdmin);
  if (!isAdmin) {
    return el('section', { class: 'usage-purchase' }, [
      el('span', { class: 'muted' }, t('usagePurchaseHint', 'Organization admins can add credits from this page.')),
    ]);
  }
  const toggle = el('button', { type: 'button', class: 'btn primary' }, t('usagePurchaseCredits', 'Purchase Credits'));
  const form = el('div', { class: 'usage-purchase-form', hidden: 'hidden' });
  toggle.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('input')?.focus();
  });

  const amount = el('input', { type: 'number', min: '1', step: '1', placeholder: t('usageAmountPlaceholder', 'Amount (INR)') });
  const quoteBox = el('div', { class: 'usage-quote' }, el('span', {}, t('usageQuoteEmpty', 'Enter an amount to see the GST breakdown.')));
  const payBtn = el('button', { type: 'button', class: 'btn primary' }, t('usagePay', 'Pay and add credits'));

  // Guards the quote against a fast typist: only the newest response may write.
  let quoteToken = 0;
  amount.addEventListener('input', async () => {
    const value = Number(amount.value);
    const token = quoteToken + 1;
    quoteToken = token;
    if (!Number.isFinite(value) || value <= 0) {
      clear(quoteBox).append(el('span', {}, t('usageQuoteEmpty', 'Enter an amount to see the GST breakdown.')));
      return;
    }
    try {
      const data = await api.billing.rechargeQuote(value);
      if (token !== quoteToken) return;
      const q = data.quote;
      clear(quoteBox).append(
        el('div', {}, `Recharge ${inr(q.subtotalInr)}`),
        ...(q.components || []).map((c) => el('div', {}, `${c.name} ${(c.rateBps / 100)}% · ${inr(c.inr)}`)),
        el('strong', {}, `Total payable ${inr(q.totalInr)}`),
        el('div', {}, t('usageQuoteCredits', '{credits} credits added · 1 credit = ₹1, so the {gst} GST is collected and never spendable', { credits: formatNumber(q.credits), gst: inr(q.gstInr) })),
        q.bonusPaise ? el('div', {}, t('usageQuoteBonus', 'Coupon bonus {bonus}, credited separately', { bonus: inr(q.bonusInr) })) : null,
        ...(data.warnings || []).map((warning) => el('small', {}, warning === 'saved_tax_id_invalid'
          ? t('usageGstinInvalid', 'Your saved GSTIN is not valid, so it was ignored for this quote.')
          : warning)),
      );
    } catch (err) {
      if (token !== quoteToken) return;
      // The server owns the amount rules (whole rupees, cap); this is its 400.
      clear(quoteBox).append(el('span', {}, (err && err.message) || t('usageQuoteFailed', 'That amount cannot be quoted.')));
    }
  });

  payBtn.addEventListener('click', async () => {
    const value = Number(amount.value);
    if (!Number.isFinite(value) || value <= 0) return toast(t('usageAmountRequired', 'Enter a positive amount'), 'warn');
    payBtn.disabled = true;
    const pi = summary.paymentInfo || {};
    try {
      const settlement = await payRecharge({
        amountInr: value,
        provider: 'cashfree',
        customer: {
          customerName: pi.billingName || 'Admin',
          customerEmail: pi.billingEmail || 'billing@example.com',
          customerPhone: pi.billingPhone || '9999999999',
        },
        returnUrl: window.location.href,
        onStatus: (message) => toast(message, 'ok'),
      });
      if (isSettled(settlement)) {
        const bonus = settlement.bonusCredits ? ` + ${settlement.bonusCredits} ${t('bonusCredits', 'bonus credits')}` : '';
        toast(`${t('usagePaid', 'Paid')} ${inr(settlement.totalInr)} · ${settlement.creditsAdded} ${t('creditsAdded', 'credits added')}${bonus}`, 'ok');
      } else {
        toast(t('usageNotSettled', 'The gateway answered, but nothing was credited.'), 'warn');
      }
      // The server dropped its cached reads for this org when it settled, so this
      // refetch shows the paid balance rather than the pre-payment one.
      renderUsage(view);
    } catch (err) {
      toast((err && err.message) || t('usageRechargeFailed', 'Recharge failed'), 'error');
      payBtn.disabled = false;
    }
  });

  form.append(amount, payBtn, quoteBox);
  return el('section', { class: 'usage-purchase' }, [
    el('strong', {}, t('usagePurchaseTitle', 'Add credits')),
    el('span', { class: 'muted' }, t('usagePurchaseBody', 'Credits are 1:1 with rupees and GST is collected on top, never spendable.')),
    toggle,
    form,
  ]);
}

/** Rupees, from the server's paise-derived decimal strings. */
function inr(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount);
}
