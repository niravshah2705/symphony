import { api } from '../api.js';
import { el, clear, loading, toast } from '../dom.js';
import { formatNumber, formatDate, getLocale } from '../i18n.js';
import { payRecharge, isSettled } from '../recharge.js';

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
  { key: 'billingSource', label: 'Who paid' },
];
const PERIODS = [
  { key: 'day', label: 'Last 24h' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
];

let groupBy = 'project';
let period = 'week';

// The gate's four states, spelled out. A negative wallet (only a platform debit
// can make one) and an unreadable one are both different facts from "out of
// credit", and each needs its own words on the page a customer reads before paying.
const FUND_STATE_LABEL = {
  available: 'Available',
  exhausted: 'Out of credit',
  negative: 'Negative',
  unknown: 'Unknown',
};

function inr(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount);
}

/** The wallet's money, which the server is allowed to report as `null`. inr()
 * would render a null balance as ₹0.00 — "you are out of credit" — so the balance
 * and the spend figures, which mean different things when missing, stay separate. */
function money(value) {
  return value === null || value === undefined ? '—' : inr(value);
}

function metric(label, value, note) {
  return el('article', { class: 'metric-card' }, [
    el('span', { class: 'metric-label' }, label),
    el('strong', { class: 'metric-value' }, value),
    note ? el('span', { class: 'metric-note' }, note) : null,
  ]);
}

/** One "who paid" series, with zeros rather than gaps when the billing service
 * predates the split (a missing series must never read as an unmeasured one). */
function sourceSeries(summary, source) {
  const week = summary.spend && summary.spend.week;
  const bySource = summary.bySource && summary.bySource.week && summary.bySource.week.sources;
  const series = bySource && bySource[source];
  if (series) {
    return {
      runs: Number(series.runs) || 0,
      tokens: Number(series.tokens) || 0,
      costInr: Number(series.costInr) || 0,
      notionalInr: Number(series.notionalInr) || 0,
    };
  }
  return source === 'customer'
    ? { runs: 0, tokens: 0, costInr: 0, notionalInr: 0 }
    : {
        runs: (week && Number(week.runs)) || 0,
        tokens: (week && Number(week.tokens)) || 0,
        costInr: (week && Number(week.costInr)) || 0,
        notionalInr: 0,
      };
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
      el('strong', {}, 'Usage aggregation is off'),
      el('span', {}, ' Runs are metered and delivered to the wallet, but the periodic usage sweep and retention prune stay off until BILLING_SWEEP_ENABLED is set.'),
    ]));
  }
  // The gate's verdict decides what this says, and `unknown` is its own case: a
  // balance that could not read is not an empty wallet, so telling the customer to
  // add credits would be wrong twice over.
  if (summary.fundState === 'unknown') {
    content.push(el('div', { class: 'notice operational-notice' }, [
      el('strong', {}, 'Wallet balance unknown'),
      el('span', {}, summary.gatePolicy === 'off'
        ? ' The billing gate is off (BILLING_GATE_POLICY=off, or no FlexPrice wallet is configured), so nothing is enforced and no balance is read.'
        : ' The FlexPrice wallet could not be read, so runs are still allowed. This resolves itself on the next read.'),
    ]));
  } else if (!summary.fundsAvailable) {
    const why = summary.fundState === 'negative'
      ? 'a platform debit exceeded it'
      : 'the credit is spent';
    content.push(el('div', { class: 'notice operational-notice operational-notice-warn' }, [
      el('strong', {}, 'Funds Unavailable — Runners & Scheduled Calls Disabled'),
      el('span', {}, ` Organization balance is ${money(summary.balanceInr)} because ${why}. Add credits or configure auto-reload${summary.isAdmin ? ' below' : ''} to re-enable runner jobs and scheduled ticks.`),
    ]));
  }

  content.push(
    el('section', { class: 'metric-grid', 'aria-label': 'Billing summary' }, [
      metric('Wallet balance', money(summary.balanceInr),
        `${summary.currency} · opening credit ${inr(summary.initialCreditInr)}${summary.balanceStale ? ' · cached read' : ''}`),
      metric('Fund status', FUND_STATE_LABEL[summary.fundState] || 'Unknown',
        summary.fundsAvailable
          ? (summary.gatePolicy === 'off' ? 'Gate off — nothing enforced' : 'Active & ready')
          : (summary.fundState === 'negative' ? 'Platform debit exceeded the wallet' : 'Runners & scheduler paused')),
      // Two series, deliberately: the second one is the number the platform never
      // spent, and its zero is what an organization on its own key is buying.
      metric('Managed spend (7 days)', inr(sourceSeries(summary, 'managed').costInr),
        `${formatNumber(sourceSeries(summary, 'managed').runs)} runs · ${formatNumber(sourceSeries(summary, 'managed').tokens)} tokens`),
      metric('Your key (not charged)', inr(sourceSeries(summary, 'customer').notionalInr),
        `${formatNumber(sourceSeries(summary, 'customer').runs)} runs at list price — debited ₹0`),
      metric('Auto-recharge', summary.autoRecharge.enabled ? 'On' : 'Off',
        // The FX rate is not a display garnish here: `usdToPaise` in the billing
        // service applied it to produce the paise that was delivered to the wallet,
        // so every rupee on this page inherits it. Say "estimate rate", not "FX".
        summary.autoRecharge.enabled ? `+${inr(summary.autoRecharge.amountInr)} below ${inr(summary.autoRecharge.thresholdInr)}` : `Estimate rate ₹${summary.fxUsdToInr}/USD`),
    ]),
  );

  // The notional figure has no ledger copy — a run on your own key posts no debit
  // — so the retained window is its real history, and the page must say so instead
  // of implying the two series above add up to all time.
  const history = summary.bySource && summary.bySource.month;
  if (history && history.retentionDays) {
    content.push(el('p', { class: 'muted cost-history-note' }, history.historyTruncated
      ? `Per-run figures cover the most recent ${history.retentionDays} days and the record store is at its cap, so older runs are no longer listed.`
      : `Per-run figures cover the most recent ${history.retentionDays} days.`));
  }

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
  );

  if (summary.isAdmin) content.push(adminPanel(view, summary));

  clear(view).append(...content);
  loadUsage(tableHost, groupControls);
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
      el('thead', {}, [el('tr', {}, [groupBy === 'task' ? 'Task' : groupBy === 'user' ? 'User' : groupBy === 'day' ? 'Day' : groupBy === 'billingSource' ? 'Who paid' : 'Project', 'Runs', 'Tokens', 'Cost'].map((h) => el('th', {}, h)))]),
      body,
      foot,
    ].filter(Boolean)),
  ]);
}

/** The charge, plus — when the organization paid the provider itself — the value it
 * did NOT pay us. Both in one cell, because a bare ₹0 next to real token volume
 * reads as missing data rather than as the whole point of bring-your-own-key. */
function costCell(value, notionalInr) {
  const notional = Number(notionalInr) || 0;
  if (!notional) return el('td', { class: 'cost-cell' }, inr(value));
  return el('td', { class: 'cost-cell' }, [
    el('strong', {}, inr(value)),
    el('small', { class: 'table-sub' }, `${inr(notional)} at list price · not charged`),
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
    costCell(row.costInr, row.notionalInr),
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
        costCell(r.costInr, r.notionalInr),
      ]))),
    ]),
  ]);
}

function loadCashfreeSdk() {
  if (window.Cashfree) return Promise.resolve(window.Cashfree);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
    script.onload = () => resolve(window.Cashfree);
    script.onerror = () => reject(new Error('Failed to load Cashfree Checkout SDK'));
    document.head.appendChild(script);
  });
}

function adminPanel(view, summary) {
  const ar = summary.autoRecharge || {};
  const currentMode = ar.mode || 'amount';

  const amount = el('input', { type: 'number', min: '1', step: '1', placeholder: 'Amount (INR)' });
  const preferredProvider = (summary.paymentInfo && summary.paymentInfo.provider) === 'razorpay' ? 'razorpay' : 'cashfree';
  const payCashfree = el('input', { type: 'radio', name: 'rechargeProvider', value: 'cashfree', ...(preferredProvider === 'cashfree' ? { checked: 'checked' } : {}) });
  const payRazorpay = el('input', { type: 'radio', name: 'rechargeProvider', value: 'razorpay', ...(preferredProvider === 'razorpay' ? { checked: 'checked' } : {}) });
  const quoteBox = el('div', { class: 'recharge-quote muted' }, 'Enter an amount to see the GST breakdown.');

  // The quote comes from the server because it IS the server's: ₹500 + ₹45 + ₹45
  // = ₹590 for 500 credits, and 1 credit = ₹1 on the subtotal, never on the ₹590.
  // Computing any of it here would put a second copy of the tax rule in the
  // browser, which is the thing that made the old "Add credits" button lie.
  let quoteToken = 0;
  const showQuote = async () => {
    const value = Number(amount.value);
    const token = quoteToken + 1;
    quoteToken = token;
    if (!Number.isFinite(value) || value <= 0) {
      clear(quoteBox);
      quoteBox.append(el('span', {}, 'Enter an amount to see the GST breakdown.'));
      return;
    }
    try {
      const data = await api.billing.rechargeQuote(value);
      if (token !== quoteToken) return;
      const q = data.quote;
      clear(quoteBox);
      quoteBox.append(
        el('div', {}, `Recharge ${inr(q.subtotalInr)}`),
        ...q.components.map((c) => el('div', { class: 'muted' }, `${c.name} ${c.rateBps / 100}% · ${inr(c.inr)}`)),
        el('strong', {}, `Total payable ${inr(q.totalInr)}`),
        el('div', {}, `${q.credits} credits added · 1 credit = ₹1, so the ${inr(q.gstInr)} GST is collected and never spendable`),
        q.bonusPaise ? el('div', { class: 'muted' }, `Coupon bonus ${inr(q.bonusInr)} (${q.bonusPaise / 100} credits), credited separately`) : null,
        q.placeOfSupply && q.placeOfSupply.assumed
          ? el('small', { class: 'muted' }, `Place of supply assumed as state ${q.placeOfSupply.stateCode}. Add your GSTIN in Organization → Billing for the exact split.`)
          : null,
        ...(data.warnings || []).map((w) => el('small', { class: 'muted' }, w === 'saved_tax_id_invalid'
          ? 'Your saved GSTIN is not valid, so it was ignored for this quote.'
          : w)),
      );
    } catch (err) {
      if (token !== quoteToken) return;
      clear(quoteBox).append(el('span', { class: 'muted' }, (err && err.message) || 'That amount cannot be quoted.'));
    }
  };
  amount.addEventListener('input', showQuote);

  const payBtn = el('button', { type: 'button', class: 'btn primary' }, 'Pay and add credits');
  payBtn.addEventListener('click', async () => {
    const value = Number(amount.value);
    if (!Number.isFinite(value) || value <= 0) return toast('Enter a positive amount', 'warn');
    payBtn.disabled = true;
    const pi = summary.paymentInfo || {};
    try {
      const settlement = await payRecharge({
        amountInr: value,
        provider: payRazorpay.checked ? 'razorpay' : 'cashfree',
        customer: {
          customerName: pi.billingName || 'Admin',
          customerEmail: pi.billingEmail || 'billing@example.com',
          customerPhone: pi.billingPhone || '9999999999',
        },
        returnUrl: window.location.href,
        onStatus: (msg) => toast(msg, 'ok'),
      });
      if (isSettled(settlement)) {
        const bonus = settlement.bonusCredits ? ` + ${settlement.bonusCredits} bonus` : '';
        toast(`₹${settlement.totalInr} paid · ${settlement.creditsAdded} credits added${bonus}`, 'ok');
      } else {
        toast(`The gateway answered, but nothing was credited (${settlement && settlement.status || 'no settlement'}).`, 'warn');
      }
      renderCost(view);
    } catch (err) {
      toast((err && err.message) || 'Recharge failed', 'error');
      payBtn.disabled = false;
    }
  });

  const thresholds = el('input', { type: 'text', value: (summary.alertThresholdsInr || []).join(', '), placeholder: 'e.g. 100, 0' });
  const arEnabled = el('input', { type: 'checkbox', ...(ar.enabled ? { checked: 'checked' } : {}) });

  // Mode selection: Specific Amount vs Percentage
  const modeAmountRadio = el('input', { type: 'radio', name: 'arMode', value: 'amount', ...(currentMode === 'amount' ? { checked: 'checked' } : {}) });
  const modePercentRadio = el('input', { type: 'radio', name: 'arMode', value: 'percentage', ...(currentMode === 'percentage' ? { checked: 'checked' } : {}) });

  const arThresholdInr = el('input', { type: 'number', step: '1', value: String(ar.thresholdInr ?? 0), placeholder: 'Threshold (INR)' });
  const arThresholdPercent = el('input', { type: 'number', min: '1', max: '100', step: '1', value: String(ar.thresholdPercent ?? 20), placeholder: 'Threshold (%)' });
  const arAmount = el('input', { type: 'number', step: '1', value: String(ar.amountInr ?? 0), placeholder: 'Reload Amount (INR)' });

  const amountGroup = el('label', { class: 'field', id: 'ar-amount-field' }, [el('span', {}, 'When balance falls below (INR)'), arThresholdInr]);
  const percentGroup = el('label', { class: 'field', id: 'ar-percent-field' }, [el('span', {}, 'When balance falls below (% of credit)'), arThresholdPercent]);

  const updateModeVisibility = () => {
    if (modeAmountRadio.checked) {
      amountGroup.style.display = 'flex';
      percentGroup.style.display = 'none';
    } else {
      amountGroup.style.display = 'none';
      percentGroup.style.display = 'flex';
    }
  };

  modeAmountRadio.addEventListener('change', updateModeVisibility);
  modePercentRadio.addEventListener('change', updateModeVisibility);

  const chBrowser = el('input', { type: 'checkbox', ...(summary.notifyChannels.browser !== false ? { checked: 'checked' } : {}) });
  const chEmail = el('input', { type: 'checkbox', ...(summary.notifyChannels.email ? { checked: 'checked' } : {}) });
  const chSlack = el('input', { type: 'checkbox', ...(summary.notifyChannels.slack ? { checked: 'checked' } : {}) });
  const gateEnabled = el('input', { type: 'checkbox', ...(summary.gateEnabled !== false ? { checked: 'checked' } : {}) });

  const saveBtn = el('button', { type: 'button', class: 'btn' }, 'Save settings');
  saveBtn.addEventListener('click', async () => {
    const selectedMode = modePercentRadio.checked ? 'percentage' : 'amount';
    const payload = {
      alertThresholdsInr: thresholds.value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)),
      autoRecharge: {
        enabled: arEnabled.checked,
        mode: selectedMode,
        thresholdInr: Number(arThresholdInr.value) || 0,
        thresholdPercent: Number(arThresholdPercent.value) || 20,
        amountInr: Number(arAmount.value) || 0,
      },
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

  // Cashfree Mandate Section
  const hasSub = Boolean(ar.cashfreeSubscriptionId);
  const subStatusBadge = el('span', { class: `status-pill ${hasSub ? 'ok' : 'neutral'}` }, hasSub ? `Active Mandate: ${ar.cashfreeSubscriptionId}` : 'No Mandate');
  const authMandateBtn = el('button', { type: 'button', class: 'btn primary' }, 'Authorize Payment Method (UPI / Card / eNACH)');

  authMandateBtn.addEventListener('click', async () => {
    authMandateBtn.disabled = true;
    try {
      const res = await api.billing.createCashfreeMandate({
        returnUrl: window.location.href,
      });

      if (!res.subscriptionSessionId) {
        throw new Error('Did not receive subscription session ID from Cashfree.');
      }

      toast('Opening Cashfree Payment Authorization…', 'ok');
      const CashfreeSdk = await loadCashfreeSdk();
      const cashfree = CashfreeSdk({ mode: 'sandbox' });

      cashfree.subscriptionsCheckout({
        subsSessionId: res.subscriptionSessionId,
        redirectTarget: '_blank',
      }).then(async (result) => {
        if (result && result.error) {
          toast(`Authorization error: ${result.error.message}`, 'error');
          authMandateBtn.disabled = false;
        } else {
          toast('Verifying mandate authorization…', 'ok');
          await api.billing.verifyCashfreeMandate(res.subscriptionId);
          renderCost(view);
        }
      }).catch((err) => {
        toast((err && err.message) || 'Checkout window closed or failed', 'warn');
        authMandateBtn.disabled = false;
      });
    } catch (err) {
      toast((err && err.message) || 'Failed to initialize Cashfree mandate', 'error');
      authMandateBtn.disabled = false;
    }
  });

  const field = (label, input) => el('label', { class: 'field' }, [el('span', {}, label), input]);

  const panel = el('section', { class: 'operational-panel' }, [
    el('div', { class: 'panel-heading' }, [
      el('div', {}, [
        el('h2', {}, 'Billing settings'),
        el('p', { class: 'muted' }, 'Admin only. Auto-reload with Cashfree Payments threshold (% or amount) and mandate authorization.'),
      ]),
    ]),
    el('div', { class: 'form-grid' }, [
      el('div', { class: 'row' }, [amount, payBtn]),
      el('div', { class: 'field-group' }, [
        el('strong', {}, 'Payment gateway'),
        el('div', { class: 'row' }, [
          el('label', { class: 'radio-label' }, [payCashfree, el('span', {}, 'Cashfree')]),
          el('label', { class: 'radio-label' }, [payRazorpay, el('span', {}, 'Razorpay')]),
        ]),
      ]),
      quoteBox,
      field('Alert thresholds (INR, comma-separated)', thresholds),
      el('div', { class: 'field-group' }, [
        el('strong', {}, 'Auto-Reload Threshold Method (OpenAI style)'),
        el('div', { class: 'row' }, [
          el('label', { class: 'radio-label' }, [modeAmountRadio, el('span', {}, 'Specific Amount (INR)')]),
          el('label', { class: 'radio-label' }, [modePercentRadio, el('span', {}, 'Percentage (%) of Credit')]),
        ]),
      ]),
      el('div', { class: 'row' }, [
        field('Enable Auto-Reload', arEnabled),
        amountGroup,
        percentGroup,
        field('Reload Amount (INR)', arAmount),
      ]),
      el('div', { class: 'field-group' }, [
        el('strong', {}, 'Cashfree Payments Mandate (UPI AutoPay, Cards SI, eNACH)'),
        el('div', { class: 'row' }, [
          subStatusBadge,
          authMandateBtn,
        ]),
      ]),
      el('div', { class: 'row' }, [field('Notify: browser', chBrowser), field('Email', chEmail), field('Slack', chSlack)]),
      field('Pause runners on negative balance', gateEnabled),
      saveBtn,
    ]),
  ]);

  setTimeout(updateModeVisibility, 0);
  return panel;
}
