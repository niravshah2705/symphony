import { api } from '../api.js';
import { el, clear, toast, loading } from '../dom.js';

// Job ids whose step trace is expanded (persists across the 4s auto-refresh).
const expandedJobs = new Set();

// Auto-refresh timer for jobs/status (cleared when leaving the Agent view).
let refreshTimer = null;
function stopRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export async function renderAgent(view) {
  stopRefresh();
  view.append(loading('Loading agent…'));

  const [status, jobsRes] = await Promise.all([api.getAgentStatus(), api.getJobs()]);
  const assumedRole = status.assumedRole;

  clear(view).append(
    el('div', { class: 'page-head' }, [
      el('h1', {}, 'Agent'),
      el('a', { class: 'btn', href: '#/settings' }, '⚙ Configure in Settings'),
    ])
  );

  const statusBar = el('div', {});
  const enrichHost = el('div', {});
  const jobsHost = el('div', {});

  view.append(statusBar, enrichHost, jobsHost);

  renderStatusBar(statusBar, status);
  await renderEnrichCard(enrichHost, { assumedRole, labels: status.enrichLabels });
  renderJobs(jobsHost, jobsRes.jobs);

  refreshTimer = setInterval(async () => {
    if (!location.hash.startsWith('#/agent')) return stopRefresh();
    try {
      const [s, j] = await Promise.all([api.getAgentStatus(), api.getJobs()]);
      renderStatusBar(statusBar, s);
      renderJobs(jobsHost, j.jobs);
    } catch (_) {
      /* transient */
    }
  }, 4000);
}

/* ------------------------------ Status bar ------------------------------ */

function renderStatusBar(host, status) {
  const c = status.counts || {};
  clear(host).append(
    el('div', { class: 'row', style: 'margin-bottom:16px;gap:8px' }, [
      pill(status.scheduleEnabled ? '⏱ Scheduler on' : '⏸ Scheduler off', status.scheduleEnabled ? 'ok' : ''),
      pill(`Every ${status.intervalMinutes}m`, ''),
      pill(`Labels: ${(status.enrichLabels || []).join(', ') || 'any'}`, ''),
      pill(status.llmConfigured ? `🧠 ${status.ollamaModel}` : '🧠 LLM not set', status.llmConfigured ? 'ok' : 'bad'),
      pill(status.tracingEnabled ? '🔎 Tracing on' : '🔎 Tracing off', status.tracingEnabled ? 'ok' : ''),
      el('span', { class: 'spacer' }),
      pill(`pending ${c.pending || 0}`, ''),
      pill(`running ${c.running || 0}`, c.running ? 'ok' : ''),
      pill(`done ${c.done || 0}`, ''),
      pill(`error ${c.error || 0}`, c.error ? 'bad' : ''),
    ]),
    status.lastError ? el('div', { class: 'muted', style: 'margin:-8px 0 12px;font-size:12px' }, `Scheduler: ${status.lastError}`) : null
  );
}

function pill(text, kind) {
  const cls = kind === 'ok' ? 'badge state-completed' : kind === 'bad' ? 'badge state-started' : 'badge';
  return el('span', { class: cls }, text);
}

/* --------------------------- Enrich card (auto) ------------------------- */

async function renderEnrichCard(host, { assumedRole, labels }) {
  clear(host);
  const labelText = (labels || []).join(', ') || 'any';
  const card = el('div', { class: 'card' });
  card.append(
    el('div', { class: 'row' }, [
      el('h3', { style: 'margin:0' }, 'Auto Enrichment'),
      el('span', { class: 'spacer' }),
      el('span', { class: 'badge' }, `labels: ${labelText}`),
    ])
  );

  if (!assumedRole) {
    card.classList.add('disabled-card');
    card.append(
      el('div', { class: 'muted', style: 'padding:18px 0' }, [
        '🔒 Assume a role in ',
        el('a', { href: '#/settings', style: 'color:var(--accent-2)' }, 'Settings'),
        ' to enable automatic enrichment.',
      ])
    );
    host.append(card);
    return;
  }

  card.append(
    el('p', { class: 'muted', style: 'font-size:13px' }, [
      'Projects labeled ',
      el('strong', {}, labelText),
      ' are picked up automatically on the schedule: unfit ones are marked ',
      el('strong', {}, 'aifail'),
      ', and completed ones (issues created) become ',
      el('strong', {}, 'aidone'),
      '. Interrupted projects resume on restart. Change labels & cadence in ',
      el('a', { href: '#/settings', style: 'color:var(--accent-2)' }, 'Settings'),
      '.',
    ])
  );

  const preview = el('div', { class: 'muted', style: 'font-size:13px;margin-bottom:12px' }, loading('Checking candidates…'));
  card.append(preview);

  const runNowBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      runNowBtn.disabled = true;
      runNowBtn.textContent = 'Running…';
      try {
        const res = await api.runAgentNow();
        const r = res.result || {};
        const skippedMsg = r.reason || (r.skipped ? `Tick skipped: ${r.skipped}` : '');
        const msg = r.error
          ? r.error
          : r.skipped
          ? skippedMsg
          : `Discovered ${r.discovered || 0}, processed ${r.processed || 0}.`;
        toast(msg, r.error || r.skipped ? 'err' : 'ok');
        renderAgent(clear(document.getElementById('view')));
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        runNowBtn.disabled = false;
        runNowBtn.textContent = 'Run now';
      }
    },
  }, 'Run now');

  card.append(el('div', { class: 'row' }, [runNowBtn]));
  host.append(card);

  // Read-only preview of what the next run will pick up.
  try {
    const { projects } = await api.getAgentCandidates();
    clear(preview);
    if (!projects.length) {
      preview.append(el('span', {}, 'No matching open projects right now.'));
    } else {
      preview.append(
        el('span', {}, `${projects.length} project(s) awaiting enrichment: `),
        el('strong', {}, projects.map((p) => p.name).join(', '))
      );
    }
  } catch (err) {
    clear(preview).append(el('span', {}, `Could not load candidates: ${err.message}`));
  }
}

/* ------------------------------ Jobs ------------------------------------ */

function renderJobs(host, jobs) {
  clear(host);
  const card = el('div', { class: 'card', style: 'margin-top:16px' });
  card.append(
    el('div', { class: 'row' }, [
      el('h3', { style: 'margin:0' }, 'Enrichment Jobs'),
      el('span', { class: 'spacer' }),
      jobs.length
        ? el('button', {
            onclick: async () => {
              await api.clearFinishedJobs();
              toast('Cleared finished jobs.');
              const j = await api.getJobs();
              renderJobs(host, j.jobs);
            },
          }, 'Clear finished')
        : null,
    ])
  );

  if (!jobs.length) {
    card.append(el('div', { class: 'muted', style: 'padding:12px 0' }, 'No jobs yet. Matching projects are enriched automatically on the schedule.'));
    host.append(card);
    return;
  }

  const rows = jobs.map((job) => jobRow(job, host));
  card.append(el('div', { style: 'margin-top:10px;display:grid;gap:8px' }, rows));
  host.append(card);
}

function jobRow(job, host) {
  const s = job.summary;
  const steps = job.steps || [];
  const summaryText = s && s.aifail
    ? `⚠ aifail — ${s.reason || 'not a fit for a software-driven solution'}`
    : s && s.resumed
    ? `↻ resumed · ${s.issuesCreated} tasks created → aidone`
    : s
    ? `${s.milestonesCreated} milestones · ${s.issuesCreated} issues · ${s.dependenciesCreated} deps${s.warnings && s.warnings.length ? ` · ${s.warnings.length} warning(s)` : ''} → aidone`
    : job.error || (job.status === 'pending' ? 'Waiting for next scheduler tick…' : job.status === 'running' ? 'Enriching…' : '');

  const stepsPanel = el(
    'div',
    { class: 'job-steps', hidden: !expandedJobs.has(job.id) },
    steps.length ? steps.map(stepLine) : [el('div', { class: 'muted', style: 'font-size:12px' }, 'No steps recorded yet.')]
  );

  const stepsToggle = el('button', {
    title: 'Show step trace',
    onclick: () => {
      if (expandedJobs.has(job.id)) {
        expandedJobs.delete(job.id);
        stepsPanel.hidden = true;
      } else {
        expandedJobs.add(job.id);
        stepsPanel.hidden = false;
      }
    },
  }, `🧾 ${steps.length}`);

  const topRow = el('div', { class: 'biz-row', style: 'margin:0' }, [
    statusBadge(job.status),
    el('div', {}, [
      el('div', { style: 'font-weight:600' }, job.projectName),
      el('div', { class: 'muted', style: 'font-size:12px' }, summaryText),
    ]),
    el('div', { class: 'actions' }, [
      job.assumedRole ? el('span', { class: 'muted', style: 'font-size:12px;align-self:center' }, `as ${job.assumedRole.name}`) : null,
      stepsToggle,
      job.traceUrl ? el('a', { class: 'btn', href: job.traceUrl, target: '_blank' }, '🔎 Trace') : null,
      el('button', {
        class: 'danger',
        onclick: async () => {
          try {
            await api.deleteJob(job.id);
            expandedJobs.delete(job.id);
            const j = await api.getJobs();
            renderJobs(host, j.jobs);
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      }, '✕'),
    ]),
  ]);

  return el('div', { class: 'job' }, [topRow, stepsPanel]);
}

function stepLine(step) {
  let time = step.ts;
  try {
    time = new Date(step.ts).toLocaleTimeString();
  } catch (_) {
    /* keep raw */
  }
  return el('div', { class: `job-step lvl-${step.level || 'info'}` }, [
    el('span', { class: 'ts' }, time),
    el('span', {}, step.message),
  ]);
}

function statusBadge(status) {
  const map = {
    pending: ['badge', '⏳ pending'],
    running: ['badge state-started', '▶ running'],
    done: ['badge state-completed', '✓ done'],
    error: ['badge state-started', '✕ error'],
  };
  const [cls, text] = map[status] || ['badge', status];
  return el('span', { class: cls, style: 'align-self:center' }, text);
}
