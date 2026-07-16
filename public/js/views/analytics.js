import { api } from '../api.js';
import { el, clear, loading } from '../dom.js';
import { formatDate, formatNumber, getLocale } from '../i18n.js';

function money(value) {
  if (value === null || value === undefined || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat(getLocale(), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: amount > 0 && amount < 0.01 ? 4 : 2,
    maximumFractionDigits: amount > 0 && amount < 0.01 ? 6 : 2,
  }).format(amount);
}

function duration(value) {
  if (value === null || value === undefined || value === '') return '—';
  const ms = Number(value);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function percent(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const normalized = number > 1 ? number : number * 100;
  return `${normalized.toFixed(normalized < 10 ? 1 : 0)}%`;
}

function metric(label, value, note) {
  return el('article', { class: 'metric-card' }, [
    el('span', { class: 'metric-label' }, label),
    el('strong', { class: 'metric-value' }, value),
    note ? el('span', { class: 'metric-note' }, note) : null,
  ]);
}

function normalize(data) {
  const summary = data.summary || data.totals || {};
  const changes = Array.isArray(data.changes) ? data.changes : Array.isArray(data.runs) ? data.runs : [];
  return { summary, changes };
}

export async function renderAnalytics(view) {
  clear(view).append(loading('Loading trace costs…'));
  let data;
  try {
    data = await api.getAnalytics();
  } catch (err) {
    clear(view).append(
      el('div', { class: 'page-head' }, [el('div', {}, [el('h1', {}, 'Analytics'), el('p', { class: 'muted' }, 'LangSmith trace cost and performance.')])]),
      el('div', { class: 'empty operational-empty' }, [
        el('h2', {}, 'Analytics are not available yet'),
        el('p', { class: 'muted' }, err.message || 'The trace service could not be reached.'),
        el('div', { class: 'row' }, [
          el('a', { class: 'btn primary', href: '#/settings' }, 'Check tracing settings'),
          el('a', { class: 'btn', href: '#/troubleshooting' }, 'Troubleshoot'),
        ]),
      ])
    );
    return;
  }

  const { summary, changes } = normalize(data);
  const refresh = el('button', { type: 'button' }, 'Refresh');
  refresh.addEventListener('click', () => renderAnalytics(view));

  const content = [
    el('div', { class: 'page-head operational-head' }, [
      el('div', {}, [
        el('h1', {}, 'Analytics'),
        el('p', { class: 'muted' }, 'Cost and performance for each change, calculated from LangSmith traces.'),
      ]),
      refresh,
    ]),
  ];

  if (data.configured === false) {
    content.push(el('div', { class: 'notice operational-notice' }, [
      el('strong', {}, 'Connect LangSmith to see cost'),
      el('span', {}, ' Add an API key and enable tracing in Settings. Existing local activity is not uploaded retroactively.'),
      el('a', { href: '#/settings' }, ' Open Settings'),
    ]));
  } else if (data.availability === 'unavailable') {
    content.push(el('div', { class: 'notice operational-notice operational-notice-warn' }, [
      el('strong', {}, 'LangSmith analytics could not be reached'),
      el('span', {}, ` ${data.message || 'Cost and trace telemetry is temporarily unavailable.'}`),
      el('a', { href: '#/troubleshooting' }, ' Troubleshoot'),
    ]));
  }

  const errorRate = summary.errorRate;
  const failedChanges = errorRate == null
    ? 'Not reported by recent traces'
    : `${formatNumber(Math.round((summary.traces || 0) * errorRate))} failed changes`;

  content.push(
    el('section', { class: 'metric-grid', 'aria-label': 'Trace summary' }, [
      metric('Total change cost', money(summary.totalCost ?? summary.cost), `${formatNumber(summary.traces || 0)} traces`),
      metric(
        'Tokens',
        summary.totalTokens == null ? '—' : formatNumber(summary.totalTokens),
        summary.inputTokens == null && summary.outputTokens == null
          ? 'Not reported by recent traces'
          : `${summary.inputTokens == null ? '—' : formatNumber(summary.inputTokens)} in · ${summary.outputTokens == null ? '—' : formatNumber(summary.outputTokens)} out`
      ),
      metric('Average latency', duration(summary.avgLatencyMs ?? summary.averageLatencyMs), 'Across recent root traces'),
      metric('Error rate', percent(errorRate), failedChanges),
    ]),
    el('section', { class: 'operational-panel' }, [
      el('div', { class: 'panel-heading' }, [
        el('div', {}, [el('h2', {}, 'Cost by change'), el('p', { class: 'muted' }, 'The latest bounded trace window; model pricing must exist in LangSmith for automatic cost.')]),
        data.window?.label ? el('span', { class: 'status-pill neutral' }, data.window.label) : null,
      ]),
      changes.length ? changesTable(changes) : el('div', { class: 'empty compact-empty' }, [
        el('h3', {}, data.configured === false
          ? 'Tracing is not configured'
          : data.availability === 'unavailable'
            ? 'Trace telemetry is unavailable'
            : 'No traced changes yet'),
        el('p', { class: 'muted' }, data.availability === 'unavailable'
          ? data.message || 'Check the LangSmith connection and try again.'
          : 'Run an agent workflow, then refresh this page after LangSmith receives the trace.'),
      ]),
    ])
  );

  clear(view).append(...content);
}

function changesTable(changes) {
  const rows = changes.map((change) => {
    const status = String(change.status || (change.error ? 'error' : 'completed')).toLowerCase();
    const traceLink = change.traceUrl
      ? el('a', { href: change.traceUrl, target: '_blank', rel: 'noopener noreferrer', class: 'detail-link' }, 'Trace ↗')
      : el('span', { class: 'muted' }, '—');
    const statusClass = status === 'error' || status === 'failed'
      ? 'bad'
      : status === 'running' || status === 'pending'
        ? 'warn'
        : ['completed', 'complete', 'success', 'succeeded', 'ok'].includes(status)
          ? 'ok'
          : 'neutral';
    return el('tr', {}, [
      el('td', {}, [
        el('strong', {}, change.name || change.title || change.id || 'Agent change'),
        el('small', { class: 'table-sub' }, change.startTime ? formatDate(change.startTime, { dateStyle: 'medium', timeStyle: 'short' }) : '—'),
      ]),
      el('td', {}, [el('span', { class: `status-pill ${statusClass}` }, status)]),
      el('td', {}, [el('span', {}, change.runtime || 'deepagent'), el('small', { class: 'table-sub' }, change.model || '—')]),
      el('td', {}, duration(change.latencyMs)),
      el('td', {}, change.totalTokens == null && change.tokens == null ? '—' : formatNumber(change.totalTokens ?? change.tokens)),
      el('td', { class: 'cost-cell' }, money(change.totalCost ?? change.cost)),
      el('td', {}, traceLink),
    ]);
  });
  return el('div', { class: 'table-scroll' }, [
    el('table', { class: 'operational-table' }, [
      el('thead', {}, [el('tr', {}, ['Change', 'Status', 'Runtime / model', 'Latency', 'Tokens', 'Cost', 'Details'].map((label) => el('th', {}, label)))]),
      el('tbody', {}, rows),
    ]),
  ]);
}
