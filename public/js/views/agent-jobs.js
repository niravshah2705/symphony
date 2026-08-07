import { api } from '../api.js';
import { el, clear, loading, toast } from '../dom.js';
import { formatDate, formatNumber } from '../i18n.js';
import { agentPauseCopy, agentPauseInfo, agentPauseNotice, hasAgentPauseContract } from '../agent-pause.js';

const CONFIRM_WINDOW_MS = 5_000;

let workspaceStream = null; // EventSource: global status/jobs/coder feed (replaces polling)
let renderGeneration = 0;
const expandedJobs = new Set();

function stopRefresh() {
  if (workspaceStream) {
    try { workspaceStream.close(); } catch (_) { /* already closed */ }
    workspaceStream = null;
  }
}

function routeActive() {
  return location.hash === '#/agent-jobs' || location.hash.startsWith('#/agent-jobs/');
}

function jobsFrom(response) {
  if (!response || !Array.isArray(response.jobs)) {
    throw new Error('Agent jobs returned an invalid response.');
  }
  return response.jobs.filter((job) => job && typeof job === 'object');
}

function isActiveJob(job) {
  return job.status === 'pending' || job.status === 'running';
}

// Keep this aligned with the collection DELETE endpoint, which retains only
// pending and running work.
function isClearableJob(job) {
  return !isActiveJob(job);
}

function jobKind(job) {
  if (job.kind === 'coding') return 'coding';
  if (!job.kind || job.kind === 'enrichment' || job.kind === 'planning') return 'planner';
  return 'other';
}

function compactText(value, maximum = 260) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum - 1).trimEnd()}…`;
}

function safeExternalUrl(value) {
  try {
    const text = String(value || '');
    if (!/^https?:\/\//i.test(text)) return '';
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch (_) {
    return '';
  }
}

function jobKey(job, index) {
  return String(job.id || `${jobKind(job)}-${index}`);
}

function safeJobId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id) ? id : '';
}

function jobsFingerprint(jobs) {
  return JSON.stringify(jobs.map((job) => [
    job.id,
    job.kind,
    job.status,
    job.updatedAt,
    job.finishedAt,
    Array.isArray(job.steps) ? job.steps.length : 0,
  ]));
}

function pauseList(...sources) {
  const seen = new Set();
  return sources
    .map((source) => agentPauseInfo(source))
    .filter((pause) => pause && !seen.has(pause.code) && seen.add(pause.code));
}

function snapshotFingerprint(jobs, pauses) {
  return JSON.stringify([
    jobsFingerprint(jobs),
    pauses.map((pause) => [pause.code, pause.pausedAt, pause.retryable]),
  ]);
}

function pauseSources(plannerStatus, coderStatus, jobs) {
  const plannerOwnsState = hasAgentPauseContract(plannerStatus);
  const coderOwnsState = hasAgentPauseContract(coderStatus);
  const legacy = jobs.filter((job) => {
    if (job.status !== 'paused') return false;
    return jobKind(job) === 'coding' ? !coderOwnsState : !plannerOwnsState;
  });
  return [plannerStatus, coderStatus, ...legacy];
}

async function loadJobSnapshot() {
  const [response, plannerStatus, coderStatus] = await Promise.all([
    api.getJobs(),
    api.getAgentStatus().catch(() => null),
    api.getCoderStatus().catch(() => null),
  ]);
  const jobs = jobsFrom(response);
  return {
    jobs,
    plannerStatus,
    coderStatus,
    pauses: pauseList(...pauseSources(plannerStatus, coderStatus, jobs)),
  };
}

function domToken(value) {
  return String(value || 'job').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'job';
}

function statusClass(status) {
  if (status === 'done') return 'ok';
  if (status === 'pending' || status === 'running' || status === 'paused') return 'warn';
  if (status === 'error') return 'bad';
  return 'neutral';
}

function statusLabel(status) {
  if (status === 'done') return 'Done';
  if (status === 'pending') return 'Pending';
  if (status === 'running') return 'Running';
  if (status === 'paused') return 'Paused';
  if (status === 'error') return 'Needs attention';
  return status ? String(status) : 'Unknown';
}

function plannerSummary(job) {
  const summary = job.summary || {};
  if (typeof summary === 'string') return compactText(summary);
  if (summary.aifail) return compactText(summary.reason || 'Not suitable for an automated software plan.');
  if (summary.resumed) return `${summary.issuesCreated || 0} tasks created while resuming the project.`;
  if (job.status === 'pending') return 'Waiting for the next planner run.';
  if (job.status === 'running') return 'The planning pass is in progress.';
  if (job.error) return compactText(job.error);
  if (Object.keys(summary).length) {
    return `${summary.milestonesCreated || 0} milestones · ${summary.issuesCreated || 0} tasks · ${summary.dependenciesCreated || 0} dependencies${summary.warnings?.length ? ` · ${summary.warnings.length} warnings` : ''}`;
  }
  return 'The planning pass is complete.';
}

function codingSummary(job) {
  const summary = job.summary || {};
  if (typeof summary === 'string') return compactText(summary);
  if (job.status === 'pending') return 'Waiting for coding capacity.';
  if (job.status === 'running') return 'The coding pass is in progress.';
  if (job.error) return compactText(job.error);
  if (summary.outcome === 'completed') {
    return summary.pr ? 'Completed and linked to a pull request.' : 'The coding pass completed.';
  }
  if (summary.outcome === 'insufficient') return compactText(summary.reason || 'The coding pass needs another review.');
  return compactText(summary.reason || summary.finalText || 'The coding pass is complete.');
}

function otherSummary(job) {
  if (job.error) return compactText(job.error);
  if (typeof job.summary === 'string') return compactText(job.summary);
  return 'This run uses a job type that this version does not recognize yet.';
}

function metric(label, value, note) {
  return el('article', { class: 'metric-card' }, [
    el('span', { class: 'metric-label' }, label),
    el('strong', { class: 'metric-value' }, formatNumber(value)),
    el('span', { class: 'metric-note' }, note),
  ]);
}

function timeNode(value) {
  if (!value) return el('span', {}, 'Time unavailable');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return el('span', {}, String(value));
  return el('time', { datetime: date.toISOString() }, formatDate(date, { dateStyle: 'medium', timeStyle: 'short' }));
}

function stepLevel(value) {
  return ['info', 'warn', 'error'].includes(value) ? value : 'info';
}

function renderSteps(host, steps) {
  const entries = Array.isArray(steps) ? steps : [];
  clear(host);
  if (!entries.length) {
    host.append(el('p', { class: 'muted job-history-no-steps' }, 'No activity was recorded for this job.'));
    return;
  }
  host.append(el('ol', { class: 'job-history-step-list' }, entries.map((step) =>
    el('li', { class: `job-step lvl-${stepLevel(step?.level)}` }, [
      timeNode(step?.ts),
      el('span', {}, String(step?.message || 'Activity recorded.')),
    ])
  )));
}

function setButtonLabel(button, label) {
  const value = typeof label === 'function' ? label() : label;
  const parts = Array.isArray(value) ? value : [value];
  button.replaceChildren(...parts.map((part) => part?.nodeType ? part : document.createTextNode(String(part))));
}

function translatedLabel(key, fallback) {
  return el('span', { dataset: { i18n: key } }, fallback);
}

function countedLabel(key, fallback, count, { confirmation = false } = {}) {
  return confirmation
    ? [translatedLabel(key, fallback), ` ${formatNumber(count)}`]
    : [translatedLabel(key, fallback), ` (${formatNumber(count)})`];
}

function armDestructiveButton(button, { confirmation, original, action }) {
  let timer = null;
  let armed = false;
  const reset = () => {
    armed = false;
    setButtonLabel(button, original);
    button.removeAttribute('data-confirming');
    if (timer) window.clearTimeout(timer);
    timer = null;
  };
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      setButtonLabel(button, confirmation);
      button.dataset.confirming = 'true';
      timer = window.setTimeout(reset, CONFIRM_WINDOW_MS);
      return;
    }
    if (timer) window.clearTimeout(timer);
    timer = null;
    button.disabled = true;
    try {
      await action();
      reset();
    } catch (error) {
      toast(error.message || 'The action could not be completed.', 'err');
      button.disabled = false;
      reset();
    }
  });
  setButtonLabel(button, original);
}

function focusedJobAction(root) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  const row = active.closest('.job-history-row');
  const action = active.dataset.jobAction;
  return row && action ? { jobId: row.dataset.jobId, action } : null;
}

function restoreJobAction(root, target) {
  if (!target) return;
  const row = root.querySelector(`.job-history-row[data-job-id="${CSS.escape(target.jobId)}"]`);
  const action = row?.querySelector(`[data-job-action="${CSS.escape(target.action)}"]`);
  action?.focus({ preventScroll: true });
}

function hasArmedConfirmation(root) {
  return Boolean(root.querySelector('button[data-confirming="true"]'));
}

function jobRow(job, index, { removeJob }) {
  const kind = jobKind(job);
  const key = jobKey(job, index);
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const activityId = `job-activity-${domToken(key)}-${index}`;
  const activity = el('div', { id: activityId, class: 'job-steps job-history-steps', hidden: true });
  const expanded = expandedJobs.has(key);
  if (expanded) {
    renderSteps(activity, steps);
    activity.hidden = false;
  }

  const title = kind === 'coding'
    ? [job.taskIdentifier, job.taskTitle].filter(Boolean).join(' · ') || 'Coding job'
    : job.projectName || job.taskTitle || (kind === 'planner' ? 'Planner job' : 'Agent job');
  const pause = agentPauseInfo(job);
  const pauseCopy = pause ? agentPauseCopy(pause) : null;
  const summary = pauseCopy?.job || (kind === 'coding' ? codingSummary(job) : kind === 'planner' ? plannerSummary(job) : otherSummary(job));
  const toggle = el('button', {
    type: 'button',
    class: 'job-history-activity',
    dataset: { jobAction: 'activity' },
    'aria-expanded': String(expanded),
    'aria-controls': activityId,
  }, `${expanded ? 'Hide' : 'Show'} activity · ${formatNumber(steps.length)}`);
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    if (open && !activity.childNodes.length) renderSteps(activity, steps);
    activity.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = `${open ? 'Hide' : 'Show'} activity · ${formatNumber(steps.length)}`;
    if (open) expandedJobs.add(key);
    else expandedJobs.delete(key);
  });

  const actions = [toggle];
  const traceUrl = safeExternalUrl(job.traceUrl);
  const taskUrl = safeExternalUrl(job.taskUrl);
  if (traceUrl) actions.push(el('a', { class: 'btn job-history-link', href: traceUrl, target: '_blank', rel: 'noopener noreferrer', dataset: { jobAction: 'trace' } }, 'Open trace'));
  if (taskUrl) actions.push(el('a', { class: 'btn job-history-link', href: taskUrl, target: '_blank', rel: 'noopener noreferrer', dataset: { jobAction: 'task' } }, 'Open task'));

  const deletableId = safeJobId(job.id);
  if (deletableId && ['done', 'error', 'paused'].includes(job.status)) {
    const remove = el('button', { type: 'button', class: 'danger job-history-delete', dataset: { jobAction: 'delete' } });
    armDestructiveButton(remove, {
      confirmation: () => translatedLabel('agentJobsConfirmDelete', 'Confirm delete'),
      original: () => translatedLabel('agentJobsDelete', 'Delete'),
      action: async () => {
        await api.deleteJob(deletableId);
        expandedJobs.delete(key);
        removeJob(deletableId);
        toast('Job deleted.');
      },
    });
    actions.push(remove);
  }

  const meta = [
    timeNode(job.startedAt || job.createdAt),
    job.projectName && kind === 'coding' ? el('span', { dataset: { userContent: 'true' } }, job.projectName) : null,
    job.assumedRole?.name ? el('span', {}, ['Acting as ', el('span', { dataset: { userContent: 'true' } }, job.assumedRole.name)]) : null,
  ].filter(Boolean);

  return el('article', { class: 'job job-history-row', role: 'listitem', dataset: { jobId: key, jobKind: kind } }, [
    el('div', { class: 'job-history-summary' }, [
      el('span', {
        class: `status-pill ${statusClass(job.status)}`,
        ...(job.status === 'paused' ? { dataset: { i18n: 'agentPaused', i18nFallback: 'Paused' } } : {}),
      }, statusLabel(job.status)),
      el('div', { class: 'job-history-copy' }, [
        el('strong', { dataset: { userContent: 'true' } }, title),
        el('p', pauseCopy ? { dataset: { i18n: pauseCopy.jobKey, i18nFallback: pauseCopy.job } } : {}, summary),
        el('div', { class: 'job-history-meta' }, meta),
      ]),
      el('div', { class: 'job-history-actions' }, actions),
    ]),
    activity,
  ]);
}

function renderSection(host, { id, title, description, jobs, kind, removeJob }) {
  clear(host).append(
    el('div', { class: 'panel-heading' }, [
      el('div', {}, [
        el('h2', { id }, title),
        el('p', { class: 'muted' }, description),
      ]),
      el('span', { class: 'status-pill neutral' }, `${formatNumber(jobs.length)} jobs`),
    ]),
    jobs.length
      ? el('div', { class: 'job-history-list', role: 'list' }, jobs.map((job, index) => jobRow(job, index, { removeJob })))
      : el('div', { class: 'empty compact-empty' }, [
          el('h3', {}, `No ${kind} jobs yet`),
          el('p', { class: 'muted' }, kind === 'coding'
            ? 'Coding jobs will appear here when the code-writer monitor starts work.'
            : kind === 'planner'
              ? 'Planner jobs will appear here after an automatic or manual planning run.'
              : 'Future or custom job types will appear here.'),
        ])
  );
}

function renderLoadFailure(view, error) {
  const retry = el('button', { class: 'primary', type: 'button' }, 'Try again');
  retry.addEventListener('click', () => {
    view.setAttribute('aria-busy', 'true');
    void renderAgentJobs(view);
  });
  clear(view).append(
    el('div', { class: 'page-head' }, [
      el('div', {}, [el('h1', { dataset: { i18n: 'agentJobs' } }, 'Agent jobs'), el('p', { class: 'muted' }, 'Complete planner and coding run history.')]),
      el('a', { class: 'btn', href: '#/agent' }, 'Open Agent workspace'),
    ]),
    el('div', { class: 'error-banner', role: 'alert' }, error.message || 'Agent jobs could not be loaded.'),
    el('div', { class: 'row' }, [retry, el('a', { class: 'btn', href: '#/troubleshooting' }, 'Troubleshoot')])
  );
}

export async function renderAgentJobs(view) {
  stopRefresh();
  const generation = ++renderGeneration;
  const loadingState = loading('Loading agent jobs…');
  loadingState.setAttribute('role', 'status');
  view.setAttribute('aria-busy', 'true');
  clear(view).append(loadingState);

  let jobs;
  let pauses;
  let plannerStatus;
  let coderStatus;
  let renderedPauseFingerprint = null;
  try {
    const snapshot = await loadJobSnapshot();
    jobs = snapshot.jobs;
    pauses = snapshot.pauses;
    plannerStatus = snapshot.plannerStatus;
    coderStatus = snapshot.coderStatus;
  } catch (error) {
    if (generation === renderGeneration && view.isConnected && routeActive()) {
      renderLoadFailure(view, error);
      view.setAttribute('aria-busy', 'false');
    }
    return;
  }
  if (generation !== renderGeneration || !view.isConnected || !routeActive()) return;

  const page = el('div', { class: 'job-history-page' });
  const summaryHost = el('section', { class: 'metric-grid job-history-metrics', 'aria-label': 'Agent job summary' });
  const plannerHost = el('section', { class: 'operational-panel job-history-section', dataset: { jobKind: 'planner' }, 'aria-labelledby': 'planner-jobs-title' });
  const codingHost = el('section', { class: 'operational-panel job-history-section', dataset: { jobKind: 'coding' }, 'aria-labelledby': 'coding-jobs-title' });
  const otherHost = el('section', { class: 'operational-panel job-history-section', dataset: { jobKind: 'other' }, 'aria-labelledby': 'other-jobs-title', hidden: true });
  const pauseHost = el('div', { class: 'agent-pause-host job-history-pause-host' });
  const refreshStatus = el('div', { class: 'job-history-refresh-status', role: 'status', 'aria-live': 'polite' });
  const refresh = el('button', { type: 'button' }, 'Refresh');
  const clearFinished = el('button', { type: 'button', class: 'danger' });
  let dataEpoch = 0;
  let renderedFingerprint = '';
  let reloadInFlight = null;

  const pageActive = () => generation === renderGeneration && view.isConnected && page.isConnected && routeActive();
  const refreshDerivedPauses = () => {
    pauses = pauseList(...pauseSources(plannerStatus, coderStatus, jobs));
  };

  const removeJob = (id) => {
    dataEpoch += 1;
    jobs = jobs.filter((job) => job.id !== id);
    refreshDerivedPauses();
    renderAll();
  };

  const renderAll = () => {
    const focusTarget = focusedJobAction(page);
    const planner = jobs.filter((job) => jobKind(job) === 'planner');
    const coding = jobs.filter((job) => jobKind(job) === 'coding');
    const other = jobs.filter((job) => jobKind(job) === 'other');
    const active = jobs.filter(isActiveJob).length;
    const attention = jobs.filter((job) => job.status === 'error').length;
    const nextPauseFingerprint = JSON.stringify(pauses.map((pause) => [pause.code, pause.pausedAt, pause.retryable]));
    if (nextPauseFingerprint !== renderedPauseFingerprint) {
      clear(pauseHost).append(...pauses.map((pause) => agentPauseNotice(pause)));
      pauseHost.hidden = pauses.length === 0;
      renderedPauseFingerprint = nextPauseFingerprint;
    }
    clear(summaryHost).append(
      metric('All jobs', jobs.length, `${formatNumber(attention)} need attention`),
      metric('Planner', planner.length, 'Planning and enrichment runs'),
      metric('Coding', coding.length, 'Code-writer runs'),
      metric('Active', active, 'Pending or running')
    );
    renderSection(plannerHost, {
      id: 'planner-jobs-title',
      title: 'Planner jobs',
      description: 'Planning and enrichment history, newest first.',
      jobs: planner,
      kind: 'planner',
      removeJob,
    });
    renderSection(codingHost, {
      id: 'coding-jobs-title',
      title: 'Coding jobs',
      description: 'Code-writer history, newest first.',
      jobs: coding,
      kind: 'coding',
      removeJob,
    });
    otherHost.hidden = !other.length;
    if (other.length) {
      renderSection(otherHost, {
        id: 'other-jobs-title',
        title: 'Other jobs',
        description: 'Runs created by newer or custom workflows.',
        jobs: other,
        kind: 'other',
        removeJob,
      });
    } else {
      clear(otherHost);
    }
    const clearable = jobs.filter(isClearableJob).length;
    clearFinished.disabled = clearable === 0;
    if (!clearFinished.hasAttribute('data-confirming')) {
      setButtonLabel(clearFinished, countedLabel('agentJobsClearFinished', 'Clear finished', clearable));
    }
    renderedFingerprint = snapshotFingerprint(jobs, pauses);
    restoreJobAction(page, focusTarget);
  };

  const reload = async ({ announce = false } = {}) => {
    if (!pageActive()) {
      stopRefresh();
      return;
    }
    if (reloadInFlight) return reloadInFlight;
    const requestEpoch = dataEpoch;
    refresh.disabled = true;
    if (announce) refreshStatus.textContent = 'Refreshing jobs…';
    const request = (async () => {
      try {
        const snapshot = await loadJobSnapshot();
        if (!pageActive() || requestEpoch !== dataEpoch) return;
        if (snapshotFingerprint(snapshot.jobs, snapshot.pauses) !== renderedFingerprint) {
          if (hasArmedConfirmation(page)) {
            refreshStatus.className = 'job-history-refresh-status pending';
            refreshStatus.textContent = 'New activity is waiting. Finish or cancel the pending confirmation to update this page.';
            return;
          }
          jobs = snapshot.jobs;
          pauses = snapshot.pauses;
          plannerStatus = snapshot.plannerStatus;
          coderStatus = snapshot.coderStatus;
          renderAll();
        }
        refreshStatus.className = 'job-history-refresh-status';
        refreshStatus.textContent = announce ? 'Jobs refreshed.' : '';
      } catch (error) {
        if (!pageActive() || requestEpoch !== dataEpoch) return;
        const message = `Activity may be out of date. ${error.message || 'Refresh failed.'}`;
        refreshStatus.className = 'job-history-refresh-status stale';
        if (refreshStatus.textContent !== message) refreshStatus.textContent = message;
      } finally {
        if (reloadInFlight === request) reloadInFlight = null;
        if (pageActive()) refresh.disabled = false;
        else stopRefresh();
      }
    })();
    reloadInFlight = request;
    return request;
  };

  refresh.addEventListener('click', () => reload({ announce: true }));
  armDestructiveButton(clearFinished, {
    confirmation: () => countedLabel('agentJobsConfirmClear', 'Confirm clear', jobs.filter(isClearableJob).length, { confirmation: true }),
    original: () => countedLabel('agentJobsClearFinished', 'Clear finished', jobs.filter(isClearableJob).length),
    action: async () => {
      const response = await api.clearFinishedJobs();
      dataEpoch += 1;
      jobs = jobsFrom(response);
      refreshDerivedPauses();
      for (const key of [...expandedJobs]) {
        if (!jobs.some((job, index) => jobKey(job, index) === key)) expandedJobs.delete(key);
      }
      renderAll();
      toast('Finished planner and coding jobs cleared.');
    },
  });

  page.append(
    el('div', { class: 'page-head operational-head' }, [
      el('div', {}, [
        el('h1', { dataset: { i18n: 'agentJobs' } }, 'Agent jobs'),
        el('p', { class: 'muted' }, 'Complete planner and coding run history. This page shows every retained job.'),
      ]),
      el('div', { class: 'row job-history-page-actions' }, [
        el('a', { class: 'btn', href: '#/agent' }, 'Open Agent workspace'),
        refresh,
        clearFinished,
      ]),
    ]),
    refreshStatus,
    pauseHost,
    summaryHost,
    plannerHost,
    codingHost,
    otherHost
  );
  clear(view).append(page);
  view.setAttribute('aria-busy', 'false');
  renderAll();

  // Live updates over SSE replace the old 5s poll. Each typed event updates the
  // in-memory snapshot; we re-render only when the fingerprint changed and no
  // destructive confirmation is currently armed (mirrors reload()'s guards).
  const applyServerEvent = (event) => {
    if (!pageActive()) return stopRefresh();
    if (!event || !event.type) return;
    if (event.type === 'jobs' && Array.isArray(event.jobs)) {
      jobs = event.jobs.filter((job) => job && typeof job === 'object');
    } else if (event.type === 'agent-status' && event.status) {
      // MERGE: a partial transition snapshot must not drop seeded status fields.
      plannerStatus = { ...(plannerStatus || {}), ...event.status };
    } else if (event.type === 'coder') {
      coderStatus = event.coder || null;
    } else {
      return; // gate + unknown types are not shown on this page
    }
    refreshDerivedPauses();
    if (snapshotFingerprint(jobs, pauses) === renderedFingerprint) return;
    if (hasArmedConfirmation(page)) {
      refreshStatus.className = 'job-history-refresh-status pending';
      refreshStatus.textContent = 'New activity is waiting. Finish or cancel the pending confirmation to update this page.';
      return;
    }
    renderAll();
    refreshStatus.className = 'job-history-refresh-status';
    refreshStatus.textContent = '';
  };

  api.openWorkspaceStream(applyServerEvent).then((source) => {
    if (!pageActive()) {
      try { source.close(); } catch (_) { /* ignore */ }
      return;
    }
    workspaceStream = source;
  }).catch(() => { /* best-effort; the manual Refresh button still works */ });
}
