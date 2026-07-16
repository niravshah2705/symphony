import { api } from '../api.js';
import { el, clear, loading } from '../dom.js';

const STATUS_COPY = {
  ok: 'Ready',
  healthy: 'Ready',
  warn: 'Attention',
  warning: 'Attention',
  error: 'Blocked',
  failed: 'Blocked',
  unknown: 'Unknown',
};

function normalizeStatus(value) {
  const status = String(value || 'unknown').toLowerCase();
  if (status === 'healthy') return 'ok';
  if (status === 'warning' || status === 'attention' || status === 'not-configured') return 'warn';
  if (status === 'failed' || status === 'unavailable') return 'error';
  return ['ok', 'warn', 'error'].includes(status) ? status : 'unknown';
}

export async function renderTroubleshooting(view) {
  clear(view).append(loading('Running safe diagnostics…'));
  let data;
  try {
    data = await api.getTroubleshooting();
  } catch (err) {
    clear(view).append(
      el('div', { class: 'page-head' }, [el('h1', {}, 'Troubleshooting')]),
      el('div', { class: 'error-banner' }, err.message || 'Diagnostics could not be loaded.')
    );
    return;
  }

  const checks = Array.isArray(data.checks) ? data.checks : [];
  const rerun = el('button', { class: 'primary', type: 'button' }, 'Run diagnostics again');
  rerun.addEventListener('click', () => renderTroubleshooting(view));
  const counts = checks.reduce((total, check) => {
    const status = normalizeStatus(check.status);
    total[status] = (total[status] || 0) + 1;
    return total;
  }, {});

  clear(view).append(
    el('div', { class: 'page-head operational-head' }, [
      el('div', {}, [
        el('h1', {}, 'Troubleshooting'),
        el('p', { class: 'muted' }, 'Safe checks for services, local models, agent SDKs, tools, and tracing. Secrets are never displayed.'),
      ]),
      rerun,
    ]),
    el('section', { class: 'diagnostic-summary', 'aria-label': 'Diagnostic summary' }, [
      el('strong', {}, data.status === 'ok' || (!counts.error && !counts.warn) ? 'Everything essential looks ready' : counts.error ? 'Some features are blocked' : 'A few items need attention'),
      el('span', { class: 'muted' }, `${counts.ok || 0} ready · ${counts.warn || 0} need attention · ${counts.error || 0} blocked`),
    ]),
    el('section', { class: 'diagnostic-list' }, checks.length
      ? checks.map(diagnosticCard)
      : [el('div', { class: 'empty compact-empty' }, [el('h3', {}, 'No diagnostic results'), el('p', { class: 'muted' }, 'The server returned no checks.')])]),
    el('section', { class: 'operational-panel troubleshooting-help' }, [
      el('h2', {}, 'Useful next steps'),
      el('div', { class: 'help-links' }, [
        el('a', { href: '#/settings' }, [el('strong', {}, 'Settings'), el('span', { class: 'muted' }, 'Models, SDK runtime, integrations, and LangSmith')]),
        el('a', { href: '#/traces' }, [el('strong', {}, 'Trace analysis'), el('span', { class: 'muted' }, 'Explain a failed run with the local model')]),
        el('a', { href: '#/analytics' }, [el('strong', {}, 'Analytics'), el('span', { class: 'muted' }, 'Inspect cost, latency, token use, and errors')]),
      ]),
    ])
  );
}

function diagnosticCard(check) {
  const status = normalizeStatus(check.status);
  const card = el('article', { class: `diagnostic-card ${status}` }, [
    el('span', { class: `diagnostic-indicator ${status}`, 'aria-hidden': 'true' }),
    el('div', { class: 'diagnostic-copy' }, [
      el('div', { class: 'diagnostic-title' }, [
        el('strong', {}, check.label || check.name || check.id || 'Diagnostic'),
        el('span', { class: `status-pill ${status === 'error' ? 'bad' : status === 'warn' ? 'warn' : status === 'ok' ? 'ok' : 'neutral'}` }, STATUS_COPY[status] || 'Unknown'),
      ]),
      el('p', {}, check.summary || check.message || 'No summary was provided.'),
      check.action ? el('p', { class: 'diagnostic-action' }, [el('strong', {}, 'Next: '), String(check.action)]) : null,
      check.details ? el('details', { class: 'diagnostic-details' }, [
        el('summary', {}, 'Technical details'),
        el('pre', { dataset: { i18nSkip: 'true' } }, typeof check.details === 'string' ? check.details : JSON.stringify(check.details, null, 2)),
      ]) : null,
    ]),
  ]);
  return card;
}
