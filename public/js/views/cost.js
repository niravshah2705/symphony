import { api } from '../api.js';
import { el, clear, loading, toast } from '../dom.js';
import { formatNumber, formatDate, getLocale } from '../i18n.js';

// Cost monitoring + billing. Per-organization / project / user / task usage with
// task drill-down, backed by first-party LLM metering (services/gateway billing
// API). All org scoping is resolved server-side; the client never sends an org id.
// Every value is rendered via el()/textContent — never innerHTML — so org/project
// names and task titles can't inject markup (xss-frontend checklist).

const GROUPS = [
  { key: 'project', label: 'Project' },
  { key: 'user', label: 'User' },
  { key: 'task', label: 'Task' },
  { key: 'day', label: 'Day' },
];
const PERIODS = [
  { key: 'day', label: 'Last 24h' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
];

let groupBy = 'project';
let period = 'week';

function inr(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount);
}

function metric(label, value, note) {
  return el('article', { class: 'metric-card' }, [
    el('span', { class: 'metric-label' }, label),
    el('strong', { class: 'metric-value' }, value),
    note ? el('span', { class: 'metric-note' }, note) : null,
  ]);
}

export async function renderCost(view) {
  clear(view).append(loading('Loading cost & billing…'));
  let summary;
  try {
    summary = await api.billing.getSummary();
  } catch (err) {
    clear(view).append(
      el('div', { class: 'page-head' }, [el('div', {}, [el('h1', {}, 'Cost'), el('p', { class: 'muted' }, 'Usage and billing.')])]),
      el('div', { class: 'empty operational-empty' }, [
        el('h2', {}, 'Cost data is not available yet'),
        el('p', { class: 'muted' }, (err && err.message) || 'The billing service could not be reached.'),
      ]),
    );
    return;
  }

  const refresh = el('button', { type: 'button' }, 'Refresh');
  refresh.addEventListener('click', () => renderCost(view));

  const content = [
    el('div', { class: 'page-head operational-head' }, [
      el('div', {}, [
        el('h1', {}, 'Cost'),
        el('p', { class: 'muted' }, 'Per-organization, project, user and task usage — metered from LLM runs. INR figures are estimates.'),
      ]),
      refresh,
    ]),
  ];

  if (!summary.sweepEnabled) {
    content.push(el('div', { class: 'notice operational-notice' }, [
      el('strong', {}, 'Billing is in preview'),
      el('span', {}, ' Usage is recorded, but the periodic sweep and negative-balance pause are off until BILLING_SWEEP_ENABLED is set.'),
    ]));
  }
  if (Number(summary.balancePaise) < 0) {
    content.push(el('div', { class: 'notice operational-notice operational-notice-warn' }, [
      el('strong', {}, 'Balance exhausted — runners paused'),
      el('span', {}, ` Balance is ${inr(summary.balanceInr)}. Add credits${summary.isAdmin ? ' below' : ''} to resume runner activity.`),
    ]));
  }

  content.push(
    el('section', { class: 'metric-grid', 'aria-label': 'Billing summary' }, [
      metric('Balance', inr(summary.balanceInr), `${summary.currency} · seeded ${inr(summary.initialCreditInr)}`),
      metric('Spend (7 days)', inr(summary.spend.week.costInr), `${formatNumber(summary.spend.week.runs)} runs · ${formatNumber(summary.spend.week.tokens)} tokens`),
      metric('Spend (30 days)', inr(summary.spend.month.costInr), `${formatNumber(summary.spend.month.runs)} runs`),
      metric('Auto-recharge', summary.autoRecharge.enabled ? 'On' : 'Off',
        summary.autoRecharge.enabled ? `+${inr(summary.autoRecharge.amountInr)} below ${inr(summary.autoRecharge.thresholdInr)}` : `FX ₹${summary.fxUsdToInr}/USD`),
    ]),
  );

  // Usage table panel (group-by + period controls; its body is loaded async).
  const tableHost = el('div', { class: 'table-host' }, loading('Loading usage…'));
  const groupControls = el('div', { class: 'row seg-toggle' }, GROUPS.map((g) => {
    const btn = el('button', { type: 'button', class: g.key === groupBy ? 'btn active' : 'btn' }, g.label);
    btn.addEventListener('click', () => { groupBy = g.key; loadUsage(tableHost, groupControls); syncSeg(groupControls, groupBy); });
    return btn;
  }));
  const periodSelect = el('select', {}, PERIODS.map((p) => el('option', { value: p.key, ...(p.key === period ? { selected: 'selected' } : {}) }, p.label)));
  periodSelect.addEventListener('change', () => { period = periodSelect.value; loadUsage(tableHost, groupControls); });

  content.push(
    el('section', { class: 'operational-panel' }, [
      el('div', { class: 'panel-heading' }, [
        el('div', {}, [el('h2', {}, 'Usage'), el('p', { class: 'muted' }, 'Grouped LLM cost. Group by Task, then expand a row to see each run.')]),
        el('div', { class: 'row' }, [groupControls, periodSelect]),
      ]),
      tableHost,
    ]),
    ledgerPanel(),
  );

  if (summary.isAdmin) content.push(adminPanel(view, summary));

  clear(view).append(...content);
  loadUsage(tableHost, groupControls);
  loadLedger(view);
}

function syncSeg(groupControls, active) {
  [...groupControls.children].forEach((btn, i) => {
    btn.className = GROUPS[i].key === active ? 'btn active' : 'btn';
  });
}

async function loadUsage(host, _groupControls) {
  clear(host).append(loading('Loading usage…'));
  let data;
  try {
    data = await api.billing.getUsage(groupBy, period);
  } catch (err) {
    clear(host).append(el('div', { class: 'empty compact-empty' }, [el('p', { class: 'muted' }, (err && err.message) || 'Usage could not be loaded.')]));
    return;
  }
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (!rows.length) {
    clear(host).append(el('div', { class: 'empty compact-empty' }, [
      el('h3', {}, 'No usage in this window'),
      el('p', { class: 'muted' }, 'Run a planner or coder task, then refresh.'),
    ]));
    return;
  }
  clear(host).append(usageTable(rows, data.totals));
}

function usageTable(rows, totals) {
  const body = el('tbody', {}, rows.map((row) => usageRow(row)));
  const foot = totals
    ? el('tfoot', {}, [el('tr', {}, [
        el('td', {}, el('strong', {}, 'Total')),
        el('td', {}, formatNumber(totals.runs)),
        el('td', {}, formatNumber(totals.tokens)),
        el('td', { class: 'cost-cell' }, el('strong', {}, inr(totals.costInr))),
      ])])
    : null;
  return el('div', { class: 'table-scroll' }, [
    el('table', { class: 'operational-table' }, [
      el('thead', {}, [el('tr', {}, [groupBy === 'task' ? 'Task' : groupBy === 'user' ? 'User' : groupBy === 'day' ? 'Day' : 'Project', 'Runs', 'Tokens', 'Cost'].map((h) => el('th', {}, h)))]),
      body,
      foot,
    ].filter(Boolean)),
  ]);
}

function usageRow(row) {
  const expandable = groupBy === 'task' && row.key && row.key !== 'unknown';
  const labelCell = expandable
    ? el('td', {}, [el('button', { type: 'button', class: 'link-button' }, `${row.label} ▸`)])
    : el('td', {}, el('strong', {}, row.label));
  const tr = el('tr', {}, [
    labelCell,
    el('td', {}, formatNumber(row.runs)),
    el('td', {}, formatNumber(row.tokens)),
    el('td', { class: 'cost-cell' }, inr(row.costInr)),
  ]);
  if (!expandable) return tr;

  let expanded = false;
  let detailRow = null;
  const trigger = labelCell.querySelector('button');
  trigger.addEventListener('click', async () => {
    if (expanded) {
      if (detailRow) detailRow.remove();
      detailRow = null;
      expanded = false;
      trigger.textContent = `${row.label} ▸`;
      return;
    }
    expanded = true;
    trigger.textContent = `${row.label} ▾`;
    detailRow = el('tr', { class: 'detail-row' }, [el('td', { colspan: '4' }, loading('Loading runs…'))]);
    tr.after(detailRow);
    try {
      const data = await api.billing.getTaskUsage(row.key);
      const records = Array.isArray(data.records) ? data.records : [];
      clear(detailRow.firstChild).append(taskDetail(records));
    } catch (err) {
      clear(detailRow.firstChild).append(el('span', { class: 'muted' }, (err && err.message) || 'Could not load runs.'));
    }
  });
  return tr;
}

function taskDetail(records) {
  if (!records.length) return el('span', { class: 'muted' }, 'No individual runs recorded.');
  return el('div', { class: 'table-scroll' }, [
    el('table', { class: 'operational-table subtable' }, [
      el('thead', {}, [el('tr', {}, ['When', 'Project', 'Runtime / model', 'Tokens', 'Cost'].map((h) => el('th', {}, h)))]),
      el('tbody', {}, records.map((r) => el('tr', {}, [
        el('td', {}, r.createdAt ? formatDate(r.createdAt, { dateStyle: 'medium', timeStyle: 'short' }) : '—'),
        el('td', {}, r.projectName || '—'),
        el('td', {}, [el('span', {}, r.source || 'agent'), el('small', { class: 'table-sub' }, `${r.provider || '—'} / ${r.model || '—'}`)]),
        el('td', {}, formatNumber(r.tokens)),
        el('td', { class: 'cost-cell' }, inr(r.costInr)),
      ]))),
    ]),
  ]);
}

function ledgerPanel() {
  return el('section', { class: 'operational-panel', id: 'billing-ledger' }, [
    el('div', { class: 'panel-heading' }, [el('div', {}, [el('h2', {}, 'Ledger'), el('p', { class: 'muted' }, 'Credits, recharges and usage debits (newest first).')])]),
    el('div', { class: 'table-host' }, loading('Loading ledger…')),
  ]);
}

async function loadLedger(view) {
  const host = view.querySelector('#billing-ledger .table-host');
  if (!host) return;
  let data;
  try {
    data = await api.billing.getLedger(50);
  } catch (_) {
    clear(host).append(el('p', { class: 'muted' }, 'Ledger could not be loaded.'));
    return;
  }
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (!entries.length) {
    clear(host).append(el('div', { class: 'empty compact-empty' }, [el('p', { class: 'muted' }, 'No ledger entries yet.')]));
    return;
  }
  clear(host).append(el('div', { class: 'table-scroll' }, [
    el('table', { class: 'operational-table' }, [
      el('thead', {}, [el('tr', {}, ['When', 'Type', 'Description', 'Amount'].map((h) => el('th', {}, h)))]),
      el('tbody', {}, entries.map((e) => el('tr', {}, [
        el('td', {}, e.createdAt ? formatDate(e.createdAt, { dateStyle: 'medium', timeStyle: 'short' }) : '—'),
        el('td', {}, [el('span', { class: `status-pill ${e.type === 'usage' ? 'neutral' : 'ok'}` }, e.type)]),
        el('td', {}, e.description || '—'),
        el('td', { class: 'cost-cell' }, `${e.amountInr >= 0 ? '+' : ''}${inr(e.amountInr)}`),
      ]))),
    ]),
  ]));
}

function adminPanel(view, summary) {
  const amount = el('input', { type: 'number', min: '1', step: '1', placeholder: 'Amount (INR)' });
  const addBtn = el('button', { type: 'button', class: 'btn primary' }, 'Add credits');
  addBtn.addEventListener('click', async () => {
    const value = Number(amount.value);
    if (!Number.isFinite(value) || value <= 0) return toast('Enter a positive amount', 'warn');
    addBtn.disabled = true;
    try {
      await api.billing.recharge(value);
      toast('Credits added', 'ok');
      renderCost(view);
    } catch (err) {
      toast((err && err.message) || 'Recharge failed', 'error');
      addBtn.disabled = false;
    }
  });

  const thresholds = el('input', { type: 'text', value: (summary.alertThresholdsInr || []).join(', '), placeholder: 'e.g. 100, 0' });
  const arEnabled = el('input', { type: 'checkbox', ...(summary.autoRecharge.enabled ? { checked: 'checked' } : {}) });
  const arThreshold = el('input', { type: 'number', step: '1', value: String(summary.autoRecharge.thresholdInr ?? 0) });
  const arAmount = el('input', { type: 'number', step: '1', value: String(summary.autoRecharge.amountInr ?? 0) });
  const chBrowser = el('input', { type: 'checkbox', ...(summary.notifyChannels.browser !== false ? { checked: 'checked' } : {}) });
  const chEmail = el('input', { type: 'checkbox', ...(summary.notifyChannels.email ? { checked: 'checked' } : {}) });
  const chSlack = el('input', { type: 'checkbox', ...(summary.notifyChannels.slack ? { checked: 'checked' } : {}) });
  const gateEnabled = el('input', { type: 'checkbox', ...(summary.gateEnabled !== false ? { checked: 'checked' } : {}) });
  const saveBtn = el('button', { type: 'button', class: 'btn' }, 'Save settings');
  saveBtn.addEventListener('click', async () => {
    const payload = {
      alertThresholdsInr: thresholds.value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)),
      autoRecharge: { enabled: arEnabled.checked, thresholdInr: Number(arThreshold.value) || 0, amountInr: Number(arAmount.value) || 0 },
      notifyChannels: { browser: chBrowser.checked, email: chEmail.checked, slack: chSlack.checked },
      gateEnabled: gateEnabled.checked,
    };
    saveBtn.disabled = true;
    try {
      await api.billing.updateConfig(payload);
      toast('Settings saved', 'ok');
      renderCost(view);
    } catch (err) {
      toast((err && err.message) || 'Save failed', 'error');
      saveBtn.disabled = false;
    }
  });

  const field = (label, input) => el('label', { class: 'field' }, [el('span', {}, label), input]);
  return el('section', { class: 'operational-panel' }, [
    el('div', { class: 'panel-heading' }, [el('div', {}, [el('h2', {}, 'Billing settings'), el('p', { class: 'muted' }, 'Admin only. Alert thresholds are INR balances; auto-recharge tops up a simulated credit (wire a real gateway later).')])]),
    el('div', { class: 'form-grid' }, [
      el('div', { class: 'row' }, [amount, addBtn]),
      field('Alert thresholds (INR, comma-separated)', thresholds),
      el('div', { class: 'row' }, [field('Auto-recharge', arEnabled), field('When below (INR)', arThreshold), field('Top up (INR)', arAmount)]),
      el('div', { class: 'row' }, [field('Notify: browser', chBrowser), field('Email', chEmail), field('Slack', chSlack)]),
      field('Pause runners on negative balance', gateEnabled),
      saveBtn,
    ]),
  ]);
}
