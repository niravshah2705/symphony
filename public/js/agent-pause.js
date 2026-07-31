import { el } from './dom.js';

const PAUSE_COPY = Object.freeze({
  git_unavailable: {
    titleKey: 'agentPauseGitTitle',
    title: 'Automatic work is waiting for a code connection.',
    bodyKey: 'agentPauseGitBody',
    body: 'Nothing new will start until GitHub or GitLab is connected and ready. Queued work is safe.',
    actionKey: 'agentPauseGitAction',
    action: 'Check code connection',
    jobKey: 'agentPauseGitJob',
    job: 'This job stopped because the code connection was unavailable.',
  },
  model_unavailable: {
    titleKey: 'agentPauseModelTitle',
    title: 'Automatic work is waiting for an AI model.',
    bodyKey: 'agentPauseModelBody',
    body: 'Nothing new will start until the selected model is available. Queued work is safe.',
    actionKey: 'agentPauseModelAction',
    action: 'Check model setup',
    jobKey: 'agentPauseModelJob',
    job: 'This job stopped because the selected model was unavailable.',
  },
  unavailable: {
    titleKey: 'agentPauseTitle',
    title: 'Automatic work is paused for now.',
    bodyKey: 'agentPauseBody',
    body: 'Nothing new will start until the workspace is ready. Queued work is safe.',
    actionKey: 'agentPauseAction',
    action: 'Review workspace setup',
    jobKey: 'agentPauseJob',
    job: 'This job stopped because the workspace was unavailable.',
  },
});

function pauseCode(value, reason = '') {
  const code = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const hint = `${code} ${String(reason || '').toLowerCase()}`;
  if (/(?:git|github|gitlab|repository|\brepo\b)/.test(hint)) return 'git_unavailable';
  if (/(?:model|\bllm\b|ollama|lm\s*studio|omlx|codex|claude|hugging\s*face)/.test(hint)) return 'model_unavailable';
  return 'unavailable';
}

function pauseCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const explicitlyPaused = value.paused === true
    || value.status === 'paused'
    || value.state === 'paused'
    || value.summary?.paused === true;
  if (!explicitlyPaused) return null;
  const reasonObject = value.pauseReason && typeof value.pauseReason === 'object'
    ? value.pauseReason
    : value.summary?.pauseReason && typeof value.summary.pauseReason === 'object'
      ? value.summary.pauseReason
      : null;
  const reason = reasonObject && typeof reasonObject.message === 'string'
    ? reasonObject.message
    : typeof value.pauseReason === 'string'
      ? value.pauseReason
      : typeof value.reason === 'string'
        ? value.reason
        : '';
  return {
    paused: true,
    code: pauseCode(reasonObject?.code || reasonObject?.resource || value.pauseCode || value.code, reason),
    reason,
    pausedAt: reasonObject?.since || value.pausedAt || value.updatedAt || null,
    retryable: reasonObject?.retryable !== false && value.retryable !== false,
  };
}

/**
 * Normalize the scheduler/job pause contract while remaining compatible with
 * nested status envelopes returned by older gateway builds.
 */
export function agentPauseInfo(source, jobs = []) {
  const directCandidates = [source, source?.pause, source?.availability, source?.agentPause];
  for (const candidate of directCandidates) {
    const pause = pauseCandidate(candidate);
    if (pause) return pause;
  }
  const pausedJobs = (Array.isArray(jobs) ? jobs : [])
    .map((job) => pauseCandidate(job))
    .filter(Boolean)
    .sort((left, right) => String(right.pausedAt || '').localeCompare(String(left.pausedAt || '')));
  return pausedJobs[0] || null;
}

/** True when a live scheduler endpoint explicitly owns current pause state. */
export function hasAgentPauseContract(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  return Object.prototype.hasOwnProperty.call(source, 'paused')
    || Object.prototype.hasOwnProperty.call(source, 'pauseReason');
}

export function agentPauseCopy(pause) {
  return PAUSE_COPY[pause?.code] || PAUSE_COPY.unavailable;
}

function localized(tag, key, fallback, attrs = {}) {
  return el(tag, {
    ...attrs,
    dataset: { ...(attrs.dataset || {}), i18n: key, i18nFallback: fallback },
  }, fallback);
}

/** Visible, plain-language recovery notice shared by the Agent surfaces. */
export function agentPauseNotice(pause, { className = '' } = {}) {
  if (!pause) return null;
  const copy = agentPauseCopy(pause);
  return el('section', {
    class: `agent-pause-notice ${className}`.trim(),
    role: 'status',
    'aria-live': 'polite',
    dataset: { pauseCode: pause.code },
  }, [
    el('span', { class: 'agent-pause-icon', 'aria-hidden': 'true' }, '‖'),
    el('div', { class: 'agent-pause-copy' }, [
      localized('strong', copy.titleKey, copy.title),
      localized('p', copy.bodyKey, copy.body),
    ]),
    localized('a', copy.actionKey, copy.action, { class: 'agent-pause-action', href: '#/settings' }),
  ]);
}
