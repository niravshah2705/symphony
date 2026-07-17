import { api } from '../api.js';
import { el, clear, toast } from '../dom.js';

let refreshTimer = null;
let railPinned = false;
const conversation = [];

function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function agentRouteActive() {
  return location.hash === '#/agent' || location.hash.startsWith('#/agent/');
}

export async function renderAgent(view) {
  stopRefresh();
  railPinned = false;
  const [status, jobsResponse] = await Promise.all([
    api.getAgentStatus().catch((error) => ({ unavailable: true, error: error.message, counts: {} })),
    api.getJobs().catch(() => ({ jobs: [] })),
  ]);

  const stream = el('div', { class: 'conversation-stream', 'aria-live': 'polite' });
  const railBody = el('div', { id: 'agent-details-panel', class: 'rail-content', role: 'tabpanel', 'aria-labelledby': 'agent-details-tab' });
  const composer = buildComposer(stream, railBody);
  const jobs = jobsResponse.jobs || [];

  clear(view).append(
    el('section', { class: 'agent-workspace' }, [
      el('main', { class: 'scenario-reader agent-reader' }, [
        agentToolbar(status, view, railBody),
        el('div', { class: 'conversation-wrap' }, [stream, composer]),
      ]),
      el('aside', { class: 'evidence-rail scenario-rail', 'aria-label': 'Agent details' }, [
        el('div', { class: 'rail-tabs', role: 'tablist' }, [
          el('button', { id: 'agent-details-tab', class: 'active', type: 'button', role: 'tab', 'aria-selected': 'true', 'aria-controls': 'agent-details-panel' }, 'Details'),
          el('span', { class: 'rail-model-chip' }, status.localActiveModel || status.ollamaModel || 'Local AI'),
        ]),
        railBody,
      ]),
    ])
  );

  renderWelcome(stream, status);
  for (const entry of conversation) stream.append(renderConversationEntry(entry, railBody));
  renderRecentWork(stream, jobs, railBody);
  renderAgentRail(railBody, status, null);

  refreshTimer = setInterval(async () => {
    if (!agentRouteActive()) return stopRefresh();
    try {
      const [nextStatus, nextJobs] = await Promise.all([api.getAgentStatus(), api.getJobs()]);
      if (!railPinned) renderAgentRail(railBody, nextStatus, null);
      updateLiveJobs(stream, nextJobs.jobs || [], railBody);
    } catch (_) {
      // A short service restart should not interrupt the conversation.
    }
  }, 5000);
}

function agentToolbar(status, view, railBody) {
  const active = Boolean(status.scheduleEnabled);
  const toggle = el('button', {
    class: `agent-state-toggle ${active ? 'is-active' : ''}`,
    type: 'button',
    title: active ? 'Pause automatic planning' : 'Resume automatic planning',
  }, [el('span', { class: 'status-dot' }), active ? 'Planning is on' : 'Planning is paused']);
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      await api.saveAgentConfig({ scheduleEnabled: !active });
      toast(active ? 'Automatic planning paused.' : 'Automatic planning resumed.', 'ok');
      if (view.isConnected && agentRouteActive()) await renderAgent(clear(view));
    } catch (error) {
      toast(error.message, 'err');
      toggle.disabled = false;
    }
  });

  const runNow = el('button', {
    class: 'agent-run-now',
    type: 'button',
    disabled: !status.assumedRole,
    title: status.assumedRole ? 'Plan matching projects now' : 'Choose a role in Settings first',
  }, 'Plan projects now');
  runNow.addEventListener('click', async () => {
    runNow.disabled = true;
    runNow.textContent = 'Starting…';
    try {
      const response = await api.runAgentNow();
      const result = response.result || {};
      toast(result.error || `Found ${result.discovered || 0}; started ${result.processed || 0}.`, result.error ? 'err' : 'ok');
      if (view.isConnected && agentRouteActive()) await renderAgent(clear(view));
    } catch (error) {
      toast(error.message, 'err');
      runNow.disabled = false;
      runNow.textContent = 'Plan projects now';
    }
  });

  return el('div', { class: 'reader-toolbar agent-toolbar' }, [
    el('div', { class: 'breadcrumbs' }, [
      el('span', {}, 'Workspace'),
      el('span', {}, '›'),
      el('strong', {}, 'Planning conversation'),
    ]),
    el('div', { class: 'reader-actions' }, [
      toggle,
      runNow,
      el('a', { class: 'tiny-link agent-jobs-link', href: '#/agent-jobs' }, 'View all jobs'),
      el('button', {
        class: 'tiny-link toolbar-details',
        type: 'button',
        onclick: () => {
          railPinned = false;
          renderAgentRail(railBody, status, null);
        },
      }, 'View setup'),
    ]),
  ]);
}

function renderWelcome(stream, status) {
  stream.append(
    assistantMessage(
      'What are we working on?',
      'Tell me about an idea, a customer problem, or an outcome you want. I’ll organize the useful context, notice what is missing, and suggest a clear next move.',
      [
        { label: 'Uses local AI', action: () => {} },
        { label: 'Change model', href: '#/settings' },
      ]
    )
  );

  if (!status.assumedRole) {
    stream.append(
      assistantMessage(
        'One small setup item',
        'You can explore ideas here now. To let me create project work automatically, choose who I should act as in Settings.',
        [{ label: 'Choose a role', href: '#/settings' }],
        'notice'
      )
    );
  }
}

function buildComposer(stream, railBody) {
  const input = el('textarea', {
    rows: '3',
    maxlength: '8000',
    placeholder: 'Describe what you want to build or improve…',
    'aria-label': 'Message the planning agent',
  });
  const count = el('span', { class: 'composer-count' }, '0 / 8,000');
  const send = el('button', { class: 'primary scenario-submit', type: 'button' }, 'Send');

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    const user = { role: 'user', text };
    conversation.push(user);
    stream.append(renderConversationEntry(user, railBody));

    const pending = assistantMessage('I’m shaping that into something useful…', 'Looking for the goal, the people it helps, useful constraints, and unanswered questions.');
    pending.classList.add('is-pending');
    stream.append(pending);
    pending.scrollIntoView({ behavior: 'smooth', block: 'end' });
    send.disabled = true;
    send.textContent = 'Thinking…';

    try {
      const response = await api.enrichInput({ scenario: 'planning', input: text });
      const entry = { role: 'assistant', analysis: normalizeEnrichment(response) };
      conversation.push(entry);
      pending.replaceWith(renderConversationEntry(entry, railBody));
      railPinned = true;
      renderAgentRail(railBody, null, entry.analysis);
    } catch (error) {
      pending.replaceWith(
        assistantMessage(
          'I couldn’t reach the local model.',
          error.message || 'Make sure Ollama or LM Studio is running, then try again.',
          [{ label: 'Open local model settings', href: '#/settings' }],
          'error'
        )
      );
    } finally {
      send.disabled = false;
      send.textContent = 'Send';
    }
  };

  input.addEventListener('input', () => {
    count.textContent = `${input.value.length.toLocaleString()} / 8,000`;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });
  send.addEventListener('click', submit);

  const suggestions = [
    'Turn my rough idea into a plan',
    'Find the gaps in what I know',
    'Suggest the first milestone',
  ];
  return el('div', { class: 'chat-composer' }, [
    el('div', { class: 'suggestion-row' }, suggestions.map((label) =>
      el('button', {
        type: 'button',
        onclick: () => {
          input.value = `${label}: `;
          input.dispatchEvent(new Event('input'));
          input.focus();
        },
      }, label)
    )),
    el('div', { class: 'composer-surface' }, [
      input,
      el('div', { class: 'composer-actions' }, [
        el('span', { class: 'privacy-chip' }, 'Local-model route'),
        count,
        el('span', { class: 'spacer' }),
        el('span', { class: 'composer-hint' }, 'Enter to send · Shift+Enter for a new line'),
        send,
      ]),
    ]),
  ]);
}

function normalizeEnrichment(response) {
  const source = response && (response.enrichment || response.enriched || response.result || response.analysis || response);
  if (typeof source === 'string') {
    return { summary: source, goal: '', audience: '', constraints: [], assumptions: [], questions: [], nextSteps: [], warnings: [], provider: response.provider, model: response.model };
  }
  return {
    summary: source.summary || source.message || source.enrichedContext || 'I organized the information you shared.',
    goal: source.goal || source.outcome || (Array.isArray(source.goals) ? source.goals.join(' · ') : ''),
    audience: source.audience || source.customer || source.targetUsers || '',
    constraints: textArray(source.constraints),
    assumptions: textArray(source.assumptions),
    questions: textArray(source.questions || source.openQuestions || source.missingInformation),
    nextSteps: textArray(source.nextSteps || source.recommendations || source.suggestedActions || source.suggestedNextSteps),
    details: source.details || source.enrichedContext || source.clarifiedBrief || '',
    warnings: textArray(source.warnings),
    usedFallback: Boolean(source.provenance && source.provenance.usedFallback),
    provider: response.provider || source.provider || source.provenance && source.provenance.provider || 'local',
    model: response.model || source.model || source.provenance && source.provenance.model || 'configured model',
  };
}

function textArray(value) {
  if (!Array.isArray(value)) return value ? [String(value)] : [];
  return value.map((item) => typeof item === 'string' ? item : item && (item.text || item.question || item.label) || JSON.stringify(item)).filter(Boolean);
}

function renderConversationEntry(entry, railBody) {
  if (entry.role === 'user') return userMessage(entry.text);
  const analysis = entry.analysis;
  const message = assistantMessage(
    analysis.goal ? 'Here’s what I heard.' : 'I’ve organized that.',
    analysis.summary,
    [{ label: 'View details', action: () => {
      railPinned = true;
      renderAgentRail(railBody, null, analysis);
    } }]
  );
  const body = message.querySelector('.message-copy');
  if (analysis.goal) body.append(el('p', { class: 'friendly-highlight' }, [el('strong', {}, 'The outcome: '), analysis.goal]));
  if (analysis.audience) body.append(el('p', {}, [el('strong', {}, 'For: '), analysis.audience]));
  if (analysis.nextSteps.length) {
    body.append(el('div', { class: 'friendly-next-steps' }, [
      el('strong', {}, 'A good next move'),
      el('ol', {}, analysis.nextSteps.slice(0, 4).map((step) => el('li', {}, step))),
    ]));
  }
  if (analysis.questions.length) {
    body.append(el('div', { class: 'friendly-questions' }, [
      el('strong', {}, 'A few things worth deciding'),
      el('ul', {}, analysis.questions.slice(0, 4).map((question) => el('li', {}, question))),
    ]));
  }
  return message;
}

function renderRecentWork(stream, jobs, railBody) {
  const host = el('div', { class: 'live-jobs' });
  host.dataset.liveJobs = 'true';
  stream.append(host);
  updateLiveJobs(stream, jobs, railBody);
}

function updateLiveJobs(stream, jobs, railBody) {
  const host = stream.querySelector('[data-live-jobs="true"]');
  if (!host) return;
  clear(host);
  const visible = (jobs || []).slice(0, 5);
  if (!visible.length) return;
  host.append(el('div', { class: 'conversation-divider' }, [el('span', {}, 'Recent work')]), ...visible.map((job) => jobMessage(job, railBody)));
}

function jobMessage(job, railBody) {
  const coding = job.kind === 'coding';
  const subject = coding ? job.taskTitle || job.taskIdentifier || 'a coding task' : job.projectName || 'your project';
  const copy = friendlyJobCopy(job, subject);
  const links = [{ label: 'See activity', action: () => renderJobRail(railBody, job) }];
  if (job.traceUrl) links.push({ label: 'Open trace', href: job.traceUrl, external: true });
  if (job.taskUrl) links.push({ label: 'Open task', href: job.taskUrl, external: true });
  return assistantMessage(copy.title, copy.text, links, `job-message status-${job.status}`);
}

function friendlyJobCopy(job, subject) {
  const coding = job.kind === 'coding';
  if (job.status === 'pending') return { title: `I’ve queued ${subject}.`, text: 'It will start as soon as capacity is available.' };
  if (job.status === 'running') return { title: `I’m working on ${subject}.`, text: 'I’ll keep the detailed activity in the side panel while the work continues.' };
  if (job.status === 'error') return { title: `I hit a snag with ${subject}.`, text: job.error || 'The work stopped before it could finish. Open activity to see where.' };
  const summary = job.summary || {};
  if (summary.aifail) return { title: `${subject} needs another look.`, text: summary.reason || 'It was not ready to turn into an automated plan yet.' };
  if (coding) return { title: `${subject} is finished.`, text: summary.pr ? 'The change is complete and its pull request is ready.' : 'The coding pass has completed.' };
  return { title: `The plan for ${subject} is ready.`, text: summary.milestonesCreated
    ? `I organized it into ${summary.milestonesCreated} milestone${summary.milestonesCreated === 1 ? '' : 's'} and ${summary.issuesCreated || 0} pieces of work.`
    : 'The planning pass has completed.' };
}

function renderAgentRail(host, status, analysis) {
  clear(host);
  if (analysis) {
    host.append(
      railIntro('Local enrichment details', 'The context behind the friendly answer.'),
      el('div', { class: 'rail-section-label' }, 'Model provenance'),
      detailCard([
        ['Provider', analysis.provider || 'local'],
        ['Model', analysis.model || 'configured model'],
        ['Data route', 'Configured local-model host'],
        ['Result', analysis.usedFallback ? 'Safe basic fallback' : 'Model-generated'],
      ]),
      analysis.constraints.length ? railList('Constraints', analysis.constraints) : null,
      analysis.assumptions.length ? railList('Assumptions noticed', analysis.assumptions) : null,
      analysis.questions.length ? railList('Open questions', analysis.questions) : null,
      analysis.warnings.length ? railList('Warnings', analysis.warnings) : null,
      analysis.details ? el('div', {}, [el('div', { class: 'rail-section-label' }, 'Enriched context'), el('p', { class: 'rail-copy' }, String(analysis.details))]) : null
    );
    return;
  }

  const safe = status || {};
  const counts = safe.counts || {};
  host.append(
    railIntro('Workspace setup', 'Automatic planning and the model that supports this conversation.'),
    el('div', { class: 'rail-summary' }, [
      el('div', {}, [el('strong', {}, String(counts.running || 0)), el('span', {}, 'active')]),
      el('div', {}, [el('strong', {}, String(counts.done || 0)), el('span', {}, 'done')]),
      el('div', {}, [el('strong', {}, String(counts.error || 0)), el('span', {}, 'needs help')]),
    ]),
    el('div', { class: 'rail-section-label' }, 'Current setup'),
    detailCard([
      ['Planning', safe.scheduleEnabled ? `Every ${safe.intervalMinutes || 5} minutes` : 'Paused'],
      ['Model', safe.localActiveModel || safe.ollamaModel || 'Not configured'],
      ['Acting as', safe.assumedRole ? safe.assumedRole.name : 'No role selected'],
      ['Labels', (safe.enrichLabels || []).join(', ') || 'Any'],
    ]),
    el('a', { class: 'rail-action-link', href: '#/settings' }, 'Change workspace settings')
  );
}

function renderJobRail(host, job) {
  railPinned = true;
  const steps = job.steps || [];
  clear(host).append(
    railIntro(job.projectName || job.taskIdentifier || 'Run activity', 'A detailed record of what the agent did.'),
    el('div', { class: 'rail-section-label' }, 'Run details'),
    detailCard([
      ['Status', job.status || 'unknown'],
      ['Started', formatTime(job.startedAt || job.createdAt)],
      ['Finished', job.finishedAt ? formatTime(job.finishedAt) : 'Still working'],
      ['Steps', String(steps.length)],
    ]),
    el('div', { class: 'rail-section-label' }, 'Activity'),
    steps.length
      ? el('ol', { class: 'activity-list' }, steps.map((step) => el('li', { class: `lvl-${step.level || 'info'}` }, [
          el('time', {}, formatTime(step.ts)),
          el('span', {}, step.message),
        ])))
      : el('p', { class: 'rail-copy' }, 'No detailed activity has been recorded yet.')
  );
}

function assistantMessage(title, copy, links = [], kind = '') {
  return el('article', { class: `conversation-message assistant ${kind}`.trim() }, [
    el('div', { class: 'message-avatar' }, 'S'),
    el('div', { class: 'message-copy' }, [
      el('strong', { class: 'message-title' }, title),
      el('p', {}, copy),
      links.length ? el('div', { class: 'message-links' }, links.map((link) => {
        if (link.href) return el('a', { href: link.href, ...(link.external ? { target: '_blank', rel: 'noreferrer' } : {}) }, link.label);
        return el('button', { type: 'button', onclick: link.action }, link.label);
      })) : null,
    ]),
  ]);
}

function userMessage(copy) {
  return el('article', { class: 'conversation-message user' }, [
    el('div', { class: 'message-avatar' }, 'You'),
    el('div', { class: 'message-copy' }, [el('p', { dataset: { userContent: 'true' } }, copy)]),
  ]);
}

function railIntro(title, copy) {
  return el('div', { class: 'rail-intro' }, [
    el('span', { class: 'rail-intro-icon' }, '◇'),
    el('div', {}, [el('strong', {}, title), el('p', {}, copy)]),
  ]);
}

function detailCard(rows) {
  return el('div', { class: 'detail-card' }, rows.flatMap(([label, value]) => [el('span', {}, label), el('strong', {}, value)]));
}

function railList(title, items) {
  return el('div', {}, [
    el('div', { class: 'rail-section-label' }, title),
    el('ul', { class: 'rail-list' }, items.map((item) => el('li', {}, item))),
  ]);
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
