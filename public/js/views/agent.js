import { api } from '../api.js';
import { el, clear, toast } from '../dom.js';
import { t } from '../i18n.js';
import { agentPauseCopy, agentPauseInfo, agentPauseNotice, hasAgentPauseContract } from '../agent-pause.js';
import {
  buildBusinessWorkspace,
  buildImplementationTask,
  classifyOmniboxIntent,
  searchWorkspaceMemory,
  summarizeTroubleshooting,
} from '../omnibox-router.mjs';

let refreshTimer = null;
let railState = { mode: 'setup', result: null };
let latestAgentStatus = null;
let latestJobs = [];
const conversation = [];
const pauseSignatures = new WeakMap();

function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function agentRouteActive() {
  return location.hash === '#/agent' || location.hash.startsWith('#/agent/');
}

export async function renderAgent(view) {
  stopRefresh();
  railState = { mode: 'setup', result: null };
  const [status, jobsResponse, coderStatus] = await Promise.all([
    api.getAgentStatus().catch((error) => ({ unavailable: true, error: error.message, counts: {} })),
    api.getJobs().catch(() => ({ jobs: [] })),
    api.getCoderStatus().catch(() => null),
  ]);

  const pauseHost = el('div', { class: 'agent-pause-host' });
  const stream = el('div', { class: 'conversation-stream', 'aria-live': 'polite' });
  const railBody = el('div', { id: 'agent-details-panel', class: 'rail-content', role: 'tabpanel', 'aria-labelledby': 'agent-setup-tab' });
  const composer = buildComposer(stream, railBody);
  const jobs = jobsResponse.jobs || [];
  latestAgentStatus = status;
  latestJobs = jobs;
  let toolbar = agentToolbar(status, view, railBody);
  let toolbarSignature = agentToolbarSignature(status);

  clear(view).append(
    el('section', { class: 'agent-workspace' }, [
      el('main', { class: 'scenario-reader agent-reader' }, [
        toolbar,
        el('div', { class: 'conversation-wrap agent-omnibox-wrap' }, [
          pauseHost,
          el('header', { class: 'omnibox-hero' }, [
            el('span', { class: 'omnibox-eyebrow' }, [
              el('span', { class: 'omnibox-spark', 'aria-hidden': 'true' }, '✳'),
              'One workspace for every request',
            ]),
            el('h1', {}, 'What should we move forward?'),
            el('p', {}, 'Ask a question, search workspace memory, pressure-test a business, troubleshoot a run, or turn an implementation change into a task.'),
          ]),
          composer,
          stream,
        ]),
      ]),
      el('aside', { class: 'evidence-rail scenario-rail', 'aria-label': 'Agent details' }, [
        buildRailTabs(railBody),
        railBody,
      ]),
    ])
  );

  renderPauseNotices(pauseHost, ...pauseSources(status, coderStatus, jobs));
  renderWelcome(stream, status);
  for (const entry of conversation) stream.append(renderConversationEntry(entry, railBody));
  renderRecentWork(stream, jobs, railBody);
  renderCurrentRail(railBody);

  refreshTimer = setInterval(async () => {
    if (!agentRouteActive()) return stopRefresh();
    try {
      const [nextStatus, nextJobs, nextCoderStatus] = await Promise.all([
        api.getAgentStatus(),
        api.getJobs(),
        api.getCoderStatus().catch(() => null),
      ]);
      const refreshedJobs = nextJobs.jobs || [];
      latestAgentStatus = nextStatus;
      latestJobs = refreshedJobs;
      renderPauseNotices(pauseHost, ...pauseSources(nextStatus, nextCoderStatus, refreshedJobs));
      const nextToolbarSignature = agentToolbarSignature(nextStatus);
      if (nextToolbarSignature !== toolbarSignature) {
        const replacement = agentToolbar(nextStatus, view, railBody);
        toolbar.replaceWith(replacement);
        toolbar = replacement;
        toolbarSignature = nextToolbarSignature;
      }
      if (railState.mode !== 'result') renderCurrentRail(railBody);
      updateLiveJobs(stream, refreshedJobs, railBody);
    } catch (_) {
      // A short service restart should not interrupt the conversation.
    }
  }, 5000);
}

function buildRailTabs(railBody) {
  const tabs = [
    ['result', 'Result'],
    ['activity', 'Activity'],
    ['setup', 'Setup'],
  ];
  return el('div', { class: 'rail-tabs agent-rail-tabs', role: 'tablist', 'aria-label': 'Agent side panel' }, tabs.map(([mode, label]) => {
    const active = railState.mode === mode;
    const button = el('button', {
      id: `agent-${mode}-tab`,
      class: active ? 'active' : '',
      type: 'button',
      role: 'tab',
      'aria-selected': String(active),
      'aria-controls': 'agent-details-panel',
      tabindex: active ? '0' : '-1',
      dataset: { railTab: mode },
    }, label);
    button.addEventListener('click', () => selectRailMode(railBody, mode));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...button.parentElement.querySelectorAll('[role="tab"]')];
      const current = buttons.indexOf(button);
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click();
      buttons[next].focus();
    });
    return button;
  }));
}

function syncRailTabs(host) {
  const tabs = host.closest('.scenario-rail')?.querySelectorAll('[data-rail-tab]') || [];
  for (const tab of tabs) {
    const active = tab.dataset.railTab === railState.mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.setAttribute('tabindex', active ? '0' : '-1');
  }
  host.setAttribute('aria-labelledby', `agent-${railState.mode}-tab`);
}

function selectRailMode(host, mode) {
  railState.mode = mode;
  syncRailTabs(host);
  renderCurrentRail(host);
}

function showRailResult(host, result) {
  railState = { mode: 'result', result };
  syncRailTabs(host);
  renderCurrentRail(host);
}

function renderCurrentRail(host) {
  syncRailTabs(host);
  if (railState.mode === 'result') {
    if (railState.result) renderIntentRail(host, railState.result);
    else clear(host).append(emptyRail('No routed result yet', 'Use the omnibox and the result will open here.'));
    return;
  }
  if (railState.mode === 'activity') {
    renderActivityRail(host, latestJobs);
    return;
  }
  renderAgentRail(host, latestAgentStatus, null);
}

function pauseSources(plannerStatus, coderStatus, jobs) {
  const plannerOwnsState = hasAgentPauseContract(plannerStatus);
  const coderOwnsState = hasAgentPauseContract(coderStatus);
  const legacy = jobs.filter((job) => {
    if (job.status !== 'paused') return false;
    const coding = job.kind === 'coding' || job.summary?.coding === true;
    return coding ? !coderOwnsState : !plannerOwnsState;
  });
  return [plannerStatus, coderStatus, ...legacy];
}

function renderPauseNotices(host, ...statuses) {
  const seen = new Set();
  const pauses = statuses
    .map((status) => agentPauseInfo(status))
    .filter((pause) => pause && !seen.has(pause.code) && seen.add(pause.code));
  const signature = JSON.stringify(pauses.map((pause) => [
    pause.code,
    pause.pausedAt,
    pause.retryable,
  ]));
  // Avoid rebuilding an unchanged aria-live region on every poll. Replacing
  // identical notices would make screen readers announce the same pause every
  // five seconds even though nothing changed.
  if (pauseSignatures.get(host) === signature) return;
  pauseSignatures.set(host, signature);
  clear(host).append(...pauses.map((pause) => agentPauseNotice(pause, { className: 'agent-conversation-pause' })));
  host.hidden = pauses.length === 0;
}

function agentToolbarSignature(status) {
  const pause = agentPauseInfo(status);
  return JSON.stringify([
    Boolean(status && status.scheduleEnabled),
    Boolean(status && status.assumedRole),
    pause && pause.code,
    pause && pause.pausedAt,
  ]);
}

function agentToolbar(status, view, railBody) {
  const configured = Boolean(status.scheduleEnabled);
  const pause = agentPauseInfo(status);
  const pauseCopy = agentPauseCopy(pause);
  const active = configured && !pause;
  const stateLabel = pause
    ? el('span', { dataset: { i18n: 'agentPlanningPaused' } }, 'Planning is paused')
    : active ? 'Planning is on' : 'Planning is paused';
  const toggle = el('button', {
    class: `agent-state-toggle ${active ? 'is-active' : ''}`,
    type: 'button',
    title: pause ? t(pauseCopy.titleKey, pauseCopy.title) : active ? 'Pause automatic planning' : 'Resume automatic planning',
  }, [el('span', { class: 'status-dot' }), stateLabel]);
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      await api.saveAgentConfig({ scheduleEnabled: !configured });
      toast(configured ? 'Automatic planning paused.' : 'Automatic planning resumed.', 'ok');
      if (view.isConnected && agentRouteActive()) await renderAgent(clear(view));
    } catch (error) {
      toast(error.message, 'err');
      toggle.disabled = false;
    }
  });

  const runNow = el('button', {
    class: 'agent-run-now',
    type: 'button',
    disabled: !status.assumedRole || Boolean(pause),
    title: pause
      ? t(pauseCopy.bodyKey, pauseCopy.body)
      : status.assumedRole ? 'Plan matching projects now' : 'Choose a role in Settings first',
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
      el('strong', {}, 'Activity omnibox'),
    ]),
    el('div', { class: 'reader-actions' }, [
      toggle,
      runNow,
      el('a', { class: 'tiny-link agent-jobs-link', href: '#/agent-jobs' }, 'View all jobs'),
      el('button', {
        class: 'tiny-link toolbar-details',
        type: 'button',
        onclick: () => {
          latestAgentStatus = status;
          selectRailMode(railBody, 'setup');
        },
      }, 'View setup'),
    ]),
  ]);
}

function renderWelcome(stream, status) {
  stream.append(
    assistantMessage(
      'The activity router is ready.',
      'Use the omnibox for any workspace activity. I’ll identify what you need, choose the right path, and keep the working details in the side panel.'
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
    placeholder: 'Ask anything or describe what you want done…',
    'aria-label': 'Ask or act from the Agent omnibox',
  });
  const count = el('span', { class: 'composer-count' }, '0 / 8,000');
  const send = el('button', { class: 'primary scenario-submit', type: 'button' }, 'Route request');

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    const user = { role: 'user', text };
    conversation.push(user);
    stream.append(renderConversationEntry(user, railBody));

    const pending = assistantMessage('Routing your request…', 'Identifying the safest, most useful workspace path and gathering only the details it needs.');
    pending.classList.add('is-pending');
    pending.dataset.agentIntent = 'routing';
    stream.append(pending);
    pending.scrollIntoView({ behavior: 'smooth', block: 'end' });
    send.disabled = true;
    send.textContent = 'Thinking…';

    try {
      const result = await resolveOmniboxRequest(text);
      const entry = { role: 'assistant', routeResult: result };
      conversation.push(entry);
      pending.replaceWith(renderConversationEntry(entry, railBody));
      showRailResult(railBody, result);
    } catch (error) {
      pending.replaceWith(
        assistantMessage(
          'I couldn’t route that request.',
          error.message || 'The workspace service did not respond. Your request was not applied or scheduled.',
          [{ label: 'Check workspace health', href: '#/troubleshooting' }],
          'error'
        )
      );
    } finally {
      send.disabled = false;
      send.textContent = 'Route request';
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
    { label: 'Search docs & memory', prompt: 'Search docs & memory for ' },
    { label: 'Assess a business idea', prompt: 'Assess this business idea: ' },
    { label: 'Troubleshoot a failed run', prompt: 'Troubleshoot this failed run: ' },
    { label: 'Create an implementation task', prompt: 'Modify this implementation: ' },
  ];
  return el('div', { class: 'chat-composer omnibox-composer' }, [
    el('div', { class: 'suggestion-row' }, suggestions.map((suggestion) =>
      el('button', {
        type: 'button',
        onclick: () => {
          input.value = suggestion.prompt;
          input.dispatchEvent(new Event('input'));
          input.focus();
        },
      }, suggestion.label)
    )),
    el('div', { class: 'composer-surface' }, [
      input,
      el('div', { class: 'composer-actions' }, [
        el('span', { class: 'privacy-chip' }, 'Intent-aware route'),
        count,
        el('span', { class: 'spacer' }),
        el('span', { class: 'composer-hint' }, 'Enter to send · Shift+Enter for a new line'),
        send,
      ]),
    ]),
  ]);
}

async function resolveOmniboxRequest(text) {
  let routed;
  try {
    routed = await api.routeAgentMessage({ input: text });
  } catch (error) {
    // Keep the workspace useful during a planner restart. The same deterministic
    // classifier runs in the browser as a no-mutation fallback; server routing
    // remains the authoritative pre-model safety gate during normal operation.
    routed = {
      route: classifyOmniboxIntent(text),
      enrichment: null,
      offline: true,
      warning: error.message || 'The server router was unavailable, so a local no-action route was used.',
    };
  }
  const route = routed.route || classifyOmniboxIntent(text);
  const base = { route, warning: routed.warning || null };

  if (route.intent === 'knowledge') {
    const [documentsResponse, memoryResponse, businessesResponse, projectsResponse, jobsResponse] = await Promise.all([
      api.searchAgentKnowledge({ query: route.input }).catch((error) => ({ results: [], indexedFiles: 0, error: error.message })),
      api.searchMemory({ query: route.input }).catch((error) => ({ results: [], scope: 'all', error: error.message })),
      api.getBusinesses().catch((error) => ({ businesses: [], error: error.message })),
      api.getProjects().catch((error) => ({ projects: [], error: error.message })),
      api.getJobs().catch((error) => ({ jobs: [], error: error.message })),
    ]);
    const sources = {
      documents: documentsResponse.results || [],
      indexedFiles: documentsResponse.indexedFiles || 0,
      businesses: businessesResponse.businesses || [],
      projects: projectsResponse.projects || [],
      jobs: jobsResponse.jobs || [],
    };
    // Server-side typed memory (scope-tagged) leads, then the live workspace blend.
    const memoryResults = (memoryResponse.results || []).map((record) => ({
      type: record.type || `Memory · ${record.scope}`,
      scope: record.scope,
      title: record.title,
      summary: record.summary,
      status: record.status || 'Saved',
      href: '#/agent',
    }));
    return {
      ...base,
      memoryDraft: routed.memoryDraft || null,
      payload: {
        sources,
        scope: memoryResponse.scope || 'all',
        results: [...memoryResults, ...searchWorkspaceMemory(route.input, sources)],
        unavailable: [documentsResponse.error, memoryResponse.error, businessesResponse.error, projectsResponse.error, jobsResponse.error].filter(Boolean),
      },
    };
  }

  if (route.intent === 'troubleshooting') {
    const [diagnostics, jobsResponse] = await Promise.all([
      api.getTroubleshooting().catch((error) => ({ checks: [], error: error.message })),
      api.getJobs().catch((error) => ({ jobs: [], error: error.message })),
    ]);
    return {
      ...base,
      payload: {
        ...summarizeTroubleshooting(diagnostics, jobsResponse.jobs || []),
        error: diagnostics.error || jobsResponse.error || null,
      },
    };
  }

  if (route.intent === 'business') {
    // The real 6-step pipeline runs on demand (the Prepare button in the rail).
    // When the server router was unreachable we fall back to the deterministic
    // client scaffold so the workspace still shows something offline.
    return {
      ...base,
      canPrepare: !routed.offline,
      payload: routed.offline ? buildBusinessWorkspace(route.input, {}) : null,
    };
  }

  if (route.intent === 'implementation') {
    const projectsResponse = await api.getProjects().catch((error) => ({ projects: [], error: error.message }));
    return {
      ...base,
      payload: {
        task: buildImplementationTask(route.input),
        projects: projectsResponse.projects || [],
        error: projectsResponse.error || null,
      },
    };
  }

  if (route.intent === 'general') {
    const analysis = routed.enrichment
      ? normalizeEnrichment({ enrichment: routed.enrichment })
      : {
          summary: route.answer,
          goal: route.input,
          audience: '',
          constraints: [],
          assumptions: [],
          questions: [],
          nextSteps: ['Clarify the intended outcome', 'Choose the workspace action that should happen next'],
          warnings: routed.warning ? [routed.warning] : [],
          provider: 'deterministic fallback',
          model: 'No model call',
        };
    return { ...base, analysis, payload: { analysis } };
  }

  return { ...base, payload: {} };
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
  if (entry.routeResult) return renderRoutedConversation(entry.routeResult, railBody);
  const analysis = entry.analysis;
  const message = assistantMessage(
    analysis.goal ? 'Here’s what I heard.' : 'I’ve organized that.',
    analysis.summary,
    [{ label: 'View details', action: () => {
      showRailResult(railBody, { route: classifyOmniboxIntent(analysis.goal || analysis.summary), analysis, payload: { analysis } });
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

function renderRoutedConversation(result, railBody) {
  const { route, payload = {} } = result;
  let copy = route.answer;
  if (route.intent === 'knowledge') {
    copy = payload.results?.length
      ? `I found ${payload.results.length} relevant workspace ${payload.results.length === 1 ? 'record' : 'records'} across business memory, projects, and recent activity.`
      : 'I checked the connected workspace sources but did not find a matching record. I won’t invent a document or memory that is not connected.';
  } else if (route.intent === 'troubleshooting') {
    copy = payload.headline ? `${payload.headline}. I also checked ${payload.signals?.length || 0} recent warning or error log signals.` : route.answer;
  } else if (route.intent === 'business') {
    copy = !payload || !payload.stages
      ? 'This looks like business work. Open the result and press “Prepare business plan” to run the fraud gate, revenue metrics, memory, spec breakdown, UI mockup, and scheduling.'
      : payload.blocked || payload.fraud?.level === 'high'
        ? 'The fraud gate found high-risk signals, so I stopped before scheduling work. Review the flagged claims in the side panel.'
        : 'I ran the full business pipeline. Review the fraud gate, revenue metrics, memory, segments, and UI mockup in the side panel.';
  } else if (route.intent === 'implementation' && !payload.projects?.length) {
    copy = 'I drafted the implementation task. Connect or create a project before confirming the task in the side panel.';
  } else if (route.intent === 'general' && result.analysis?.summary) {
    copy = result.analysis.summary;
  }

  const links = [{ label: route.intent === 'implementation' ? 'Review task' : 'Open result', action: () => showRailResult(railBody, result) }];
  if (route.intent === 'troubleshooting') links.push({ label: 'Full diagnostics', href: '#/troubleshooting' });
  if (route.intent === 'knowledge') links.push({ label: 'Browse projects', href: '#/projects' });
  const message = assistantMessage(route.title, copy, links, `intent-message intent-${route.intent}`);
  message.dataset.agentIntent = route.intent;
  const body = message.querySelector('.message-copy');
  body.prepend(el('span', { class: `intent-route-chip tone-${route.intent === 'unsafe' ? 'red' : route.intent === 'business' ? 'green' : 'blue'}` }, route.label));
  if (result.warning) body.append(el('p', { class: 'intent-warning' }, result.warning));
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
  const links = [{ label: 'See activity', i18n: 'agentJobActivity', action: () => {
    railState.mode = 'activity';
    syncRailTabs(railBody);
    renderJobRail(railBody, job);
  } }];
  if (job.traceUrl) links.push({ label: 'Open trace', href: job.traceUrl, external: true });
  if (job.taskUrl) links.push({ label: 'Open task', href: job.taskUrl, external: true });
  const title = copy.titleKey
    ? { text: copy.title, attrs: { dataset: { i18n: copy.titleKey, i18nFallback: copy.title } } }
    : copy.title;
  const text = copy.textKey
    ? { text: copy.text, attrs: { dataset: { i18n: copy.textKey, i18nFallback: copy.text } } }
    : copy.text;
  return assistantMessage(title, text, links, `job-message status-${job.status}`);
}

function friendlyJobCopy(job, subject) {
  const coding = job.kind === 'coding';
  const pause = agentPauseInfo(job);
  if (pause) {
    const pauseCopy = agentPauseCopy(pause);
    return {
      title: pauseCopy.title,
      titleKey: pauseCopy.titleKey,
      text: pauseCopy.job,
      textKey: pauseCopy.jobKey,
    };
  }
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

function renderIntentRail(host, result) {
  const route = result.route || classifyOmniboxIntent('');
  host.dataset.agentIntent = route.intent;
  if (route.intent === 'business') return renderBusinessRail(host, result);
  if (route.intent === 'knowledge') return renderKnowledgeRail(host, result);
  if (route.intent === 'troubleshooting') return renderTroubleshootingRail(host, result);
  if (route.intent === 'implementation') return renderImplementationRail(host, result);
  if (route.intent === 'general' && result.analysis) return renderAgentRail(host, null, result.analysis);

  clear(host).append(
    railIntro(route.title, route.intent === 'unsafe' ? 'This request stopped at the policy gate. No model, search, tool, or task action ran.' : 'A direct response from the activity router.'),
    el('section', { class: `route-policy-card ${route.intent}`, dataset: { panelSection: route.intent === 'unsafe' ? 'policy' : 'response' } }, [
      el('span', { class: 'route-policy-icon', 'aria-hidden': 'true' }, route.intent === 'unsafe' ? '◇' : '✳'),
      el('strong', {}, route.intent === 'unsafe' ? 'Lawful, human-positive work only' : route.label),
      el('p', {}, route.answer),
    ]),
    route.intent === 'unsafe'
      ? el('section', { dataset: { panelSection: 'safe-alternatives' } }, [
          el('div', { class: 'rail-section-label' }, 'What I can help with'),
          el('ul', { class: 'rail-list' }, [
            el('li', {}, 'Fraud prevention, scam detection, and customer protection'),
            el('li', {}, 'Ethical marketing and transparent sales copy'),
            el('li', {}, 'A legitimate business model that creates real customer value'),
          ]),
        ])
      : el('p', { class: 'rail-copy route-ready-copy' }, 'Try a business question, a workspace-memory search, a troubleshooting request, or an implementation change next.')
  );
}

function renderKnowledgeRail(host, result) {
  const payload = result.payload || {};
  const results = payload.results || [];
  const sourceCounts = [
    ['Documents', payload.sources?.indexedFiles || 0],
    ['Business memory', payload.sources?.businesses?.length || 0],
    ['Projects', payload.sources?.projects?.length || 0],
    ['Activity', payload.sources?.jobs?.length || 0],
  ];
  clear(host).append(
    railIntro('Workspace memory', `Searched typed memory${payload.scope && payload.scope !== 'all' ? ` (${payload.scope} scope)` : ' across all scopes'} plus connected records. Results show their real source type.`),
    result.memoryDraft ? memoryDraftBlock(result.memoryDraft) : null,
    el('section', { class: 'knowledge-source-grid', dataset: { panelSection: 'sources' }, 'aria-label': 'Searched sources' }, sourceCounts.map(([label, count]) =>
      el('div', {}, [el('strong', {}, String(count)), el('span', {}, label)])
    )),
    payload.unavailable?.length
      ? el('div', { class: 'rail-inline-notice warning' }, `Some sources were unavailable: ${payload.unavailable.join(' · ')}`)
      : null,
    el('div', { class: 'rail-section-label' }, `Matches · ${results.length}`),
    results.length
      ? el('div', { class: 'knowledge-results', dataset: { panelSection: 'matches' } }, results.map((match, index) =>
          el('a', { class: 'knowledge-result-card', href: match.href || '#/agent', dataset: { sourceType: match.type, ...(match.scope ? { scope: match.scope } : {}) } }, [
            el('span', { class: 'knowledge-result-number' }, String(index + 1).padStart(2, '0')),
            el('div', {}, [
              match.scope ? el('span', { class: `memory-scope-chip scope-${match.scope}`, dataset: { scope: match.scope } }, match.scope) : null,
              el('small', {}, `${match.type} · ${match.status}`),
              el('strong', {}, match.title),
              el('p', {}, match.summary),
            ]),
          ])
        ))
      : emptyRail('No connected match', 'The search completed, but no stored memory, business, project, or activity record matched this request.'),
    el('p', { class: 'rail-copy knowledge-honesty' }, 'Document results come from a bounded lexical index of connected README/docs files; typed memory (user, business, project, task, workspace) is searched live. Semantic vector retrieval is not connected yet.')
  );
}

/**
 * A confirm-before-write block for "remember this" phrasing. The server only
 * proposes a draft from free text; nothing is persisted until the user clicks.
 */
function memoryDraftBlock(draft) {
  const scopes = ['user', 'business', 'project', 'task', 'workspace'];
  const scope = el('select', { 'aria-label': 'Memory scope' }, scopes.map((value) =>
    el('option', { value, selected: value === draft.scope ? 'selected' : null }, value)
  ));
  const title = el('input', { type: 'text', maxlength: '160', value: draft.title || '', 'aria-label': 'Memory title' });
  const text = el('textarea', { rows: '3', maxlength: '2000', 'aria-label': 'What to remember' }, draft.text || '');
  const save = el('button', { class: 'primary', type: 'button' }, 'Save to memory');
  const feedback = el('div', { class: 'task-create-feedback', role: 'status', 'aria-live': 'polite' });
  save.addEventListener('click', async () => {
    if (!text.value.trim()) { feedback.className = 'task-create-feedback error'; feedback.textContent = 'Add something to remember first.'; return; }
    save.disabled = true;
    save.textContent = 'Saving…';
    feedback.className = 'task-create-feedback';
    try {
      const response = await api.saveMemory({ scope: scope.value, title: title.value.trim(), text: text.value.trim() });
      save.textContent = 'Saved to memory';
      feedback.classList.add('success');
      feedback.textContent = `Saved to ${response.memory?.scope || scope.value} memory.`;
    } catch (error) {
      save.disabled = false;
      save.textContent = 'Try saving again';
      feedback.classList.add('error');
      feedback.textContent = error.message;
    }
  });
  return el('section', { class: 'memory-draft-card', dataset: { panelSection: 'memory-draft' } }, [
    el('div', { class: 'rail-section-label' }, 'Save to memory'),
    el('p', { class: 'rail-copy' }, 'You asked me to remember this. Review and confirm — nothing is saved until you click.'),
    formField('Scope', scope),
    formField('Title', title),
    formField('What to remember', text),
    save,
    feedback,
  ]);
}

function renderTroubleshootingRail(host, result) {
  const payload = result.payload || {};
  const counts = payload.counts || { ok: 0, warning: 0, error: 0 };
  const checks = payload.checks || [];
  const signals = payload.signals || [];
  clear(host).append(
    railIntro(payload.headline || 'Troubleshooting result', 'Live readiness checks plus recent warning and error steps from retained agent run logs.'),
    el('section', { class: 'troubleshooting-summary-grid', dataset: { panelSection: 'diagnostics' }, 'aria-label': 'Diagnostic summary' }, [
      summaryStat(counts.ok || 0, 'Ready', 'green'),
      summaryStat(counts.warning || 0, 'Attention', 'amber'),
      summaryStat(counts.error || 0, 'Blocked', 'red'),
    ]),
    payload.error ? el('div', { class: 'rail-inline-notice warning' }, payload.error) : null,
    el('div', { class: 'rail-section-label' }, 'Readiness checks'),
    checks.length
      ? el('div', { class: 'diagnostic-rail-list' }, checks.map((check) => {
          const tone = ['error', 'failed', 'unavailable'].includes(String(check.status).toLowerCase()) ? 'red'
            : ['warn', 'warning', 'attention', 'not-configured'].includes(String(check.status).toLowerCase()) ? 'amber' : 'green';
          return el('article', { class: 'diagnostic-rail-card', dataset: { tone } }, [
            el('span', { class: 'diagnostic-rail-dot', 'aria-hidden': 'true' }),
            el('div', {}, [el('strong', {}, check.label || check.name || 'Check'), el('p', {}, check.summary || check.message || 'No summary'), check.action ? el('small', {}, `Next: ${check.action}`) : null]),
          ]);
        }))
      : el('p', { class: 'rail-copy' }, 'No readiness checks were returned.'),
    el('div', { class: 'rail-section-label' }, `Recent log signals · ${signals.length}`),
    signals.length
      ? el('ol', { class: 'log-signal-list', dataset: { panelSection: 'logs' } }, signals.map((signal) =>
          el('li', { dataset: { level: signal.level } }, [
            el('div', {}, [el('strong', {}, signal.source), el('time', {}, formatTime(signal.ts))]),
            el('p', {}, signal.message),
          ])
        ))
      : el('div', { class: 'rail-inline-notice success', dataset: { panelSection: 'logs' } }, 'No warning or error signals were found in retained agent run logs.'),
    el('a', { class: 'rail-action-link', href: '#/troubleshooting' }, 'Open full troubleshooting')
  );
}

function renderBusinessRail(host, result) {
  const business = result.payload || null;

  // On demand: no pipeline output yet → show the Prepare call to action. The
  // heavy 6-step pipeline (real model calls) only runs when the user clicks.
  if (!business || !business.stages) {
    const status = el('p', { class: 'business-scheduler-status' }, 'Runs the fraud gate, revenue metrics, business memory, a spec breakdown, a UI mockup, and the scheduling stage. This makes real model calls and can take a few seconds.');
    const prepare = el('button', { class: 'primary business-prepare-button', type: 'button' }, 'Prepare business plan');
    prepare.addEventListener('click', async () => {
      prepare.disabled = true;
      prepare.textContent = 'Preparing…';
      status.classList.remove('error');
      status.textContent = 'Running the six-step business pipeline…';
      try {
        const response = await api.prepareBusiness({ input: result.route?.input || '', businessId: result.businessId });
        result.payload = response.business;
        renderBusinessRail(host, result);
      } catch (error) {
        prepare.disabled = false;
        prepare.textContent = 'Try preparing again';
        status.classList.add('error');
        status.textContent = error.message;
      }
    });
    clear(host).append(
      railIntro('Business decision workspace', result.route?.input || 'Pressure-test a business idea before scheduling any work.'),
      el('section', { class: 'business-prepare-card', dataset: { panelSection: 'prepare' } }, [
        el('span', { class: 'scheduler-pulse', 'aria-hidden': 'true' }),
        el('strong', {}, 'Ready to run the full pipeline'),
        status,
        prepare,
      ])
    );
    return;
  }

  const fraud = business.fraud || { level: 'review', score: 50, tone: 'amber', label: 'Review needed', summary: 'Validate the business before scheduling.' };
  const scheduler = business.scheduler || { status: business.blocked ? 'blocked' : 'ready', note: '' };
  const schedulerBlocked = business.blocked || fraud.level === 'high' || scheduler.status === 'blocked';
  const schedulerStage = schedulerBlocked ? 'blocked' : scheduler.status === 'done' ? 'done' : 'ready';

  clear(host).append(
    railIntro('Business decision workspace', business.goal || 'A staged path from risk review to scheduled implementation.'),
    business.warnings?.length ? el('div', { class: 'rail-inline-notice warning' }, business.warnings.join(' · ')) : null,
    el('ol', { class: 'business-stage-track', dataset: { panelSection: 'stages' }, 'aria-label': 'Business workflow stages' }, (business.stages || []).map((stage, index) =>
      el('li', { dataset: { stage: stage.label, status: stage.status } }, [
        el('span', {}, stage.status === 'done' ? '✓' : stage.status === 'blocked' ? '!' : String(index + 1)),
        el('strong', {}, stage.label),
        el('small', {}, stage.status),
      ])
    )),
    el('section', { class: `fraud-gate-card tone-${fraud.tone}`, dataset: { panelSection: 'fraud-gate', tone: fraud.tone } }, [
      el('div', { class: 'fraud-gate-head' }, [el('span', {}, '01'), el('strong', {}, 'Fraud & scam gate'), el('b', {}, `${fraud.score}/100`)]),
      el('h3', {}, fraud.label),
      el('p', {}, fraud.summary),
      el('small', {}, 'Signal check only—not legal, compliance, or financial advice.'),
    ]),
    el('div', { class: 'rail-section-label' }, '02 · Revenue metrics'),
    el('section', { class: 'business-metric-grid', dataset: { panelSection: 'revenue-metrics' } }, (business.metrics || []).map((metric) =>
      el('article', { class: 'business-metric-card', dataset: { tone: metric.tone } }, [
        el('span', { class: 'business-metric-indicator', 'aria-hidden': 'true' }),
        el('small', {}, metric.label),
        el('strong', {}, metric.value),
        el('p', {}, metric.meta),
      ])
    )),
    el('div', { class: 'rail-section-label' }, '03 · Business memory'),
    el('section', { class: 'business-memory-card', dataset: { panelSection: 'business-memory' } }, (business.memory || []).map(([label, value]) =>
      el('div', {}, [el('span', {}, label), el('p', {}, value)])
    )),
    business.savedMemory?.length ? el('p', { class: 'rail-copy' }, `Saved ${business.savedMemory.length} entr${business.savedMemory.length === 1 ? 'y' : 'ies'} to business memory.`) : null,
    el('div', { class: 'rail-section-label' }, '04 · Architecture'),
    architectureDiagram(business.architecture || []),
    el('div', { class: 'rail-section-label' }, '05 · Thinker + spec breakdown'),
    el('section', { class: 'thinker-card', dataset: { panelSection: 'spec-breakdown' } }, [
      el('div', { class: 'thinker-meta' }, [
        el('span', {}, `${latestAgentStatus?.activeModel || 'Thinking model'} · spec breakdown`),
        el('span', {}, 'Software-planning skill'),
      ]),
      el('ol', {}, (business.segments || []).map((segment, index) =>
        el('li', {}, [el('span', {}, String(index + 1).padStart(2, '0')), el('p', {}, segmentText(segment))])
      )),
    ]),
    el('div', { class: 'rail-section-label' }, '06 · UI design'),
    designHandoff(business.design || {}, business.designHtml),
    el('div', { class: 'rail-section-label' }, '07 · Task scheduler'),
    el('section', { class: 'business-scheduler-card', dataset: { panelSection: 'scheduler', stage: schedulerStage } }, [
      el('span', { class: 'scheduler-pulse', 'aria-hidden': 'true' }),
      el('strong', {}, schedulerBlocked ? 'Blocked at fraud gate' : scheduler.status === 'done' ? 'Queued for the planner' : 'Ready for confirmed scheduling'),
      el('p', { class: 'business-scheduler-status' }, scheduler.note || (schedulerBlocked ? 'Resolve the fraud-gate findings before any task is queued.' : 'Ready for a confirmed project run.')),
    ])
  );
}

function segmentText(segment) {
  if (typeof segment === 'string') return segment;
  if (!segment || typeof segment !== 'object') return String(segment ?? '');
  return segment.size ? `${segment.title} · ${segment.size}` : segment.title || '';
}

function architectureDiagram(nodes) {
  return el('figure', { class: 'business-architecture', dataset: { panelSection: 'architecture-diagram' }, 'aria-label': 'Business request architecture diagram' }, [
    el('div', { class: 'architecture-flow' }, nodes.map((node, index) => [
      el('div', { class: 'architecture-node', dataset: { node: node.id } }, [el('strong', {}, node.label), el('small', {}, node.meta)]),
      index < nodes.length - 1 ? el('span', { class: 'architecture-arrow', 'aria-hidden': 'true' }, '↓') : null,
    ]).flat()),
    el('figcaption', {}, 'Every action moves through risk, memory, specification, design, and scheduling in that order.'),
  ]);
}

function designHandoff(design, designHtml) {
  const children = [
    el('div', { class: 'design-handoff-head' }, [
      el('div', {}, [el('small', {}, 'Claude design mockup'), el('strong', {}, design.name || 'Outcome cockpit')]),
      el('span', {}, designHtml ? 'Mockup ready' : 'Brief ready'),
    ]),
    el('p', {}, design.summary || 'A focused interface brief prepared for the design stage.'),
  ];
  if (designHtml) {
    children.push(sandboxedDesignFrame(designHtml));
  } else {
    children.push(el('div', { class: 'design-mini-canvas', 'aria-label': 'UI design preview' }, [
      el('div', { class: 'design-mini-top' }, [el('i'), el('i'), el('i')]),
      el('div', { class: 'design-mini-body' }, [
        el('span', { class: 'design-mini-nav' }),
        el('div', { class: 'design-mini-content' }, [el('strong', {}, design.primary || 'Primary outcome'), el('p', {}, design.secondary || 'Supporting evidence'), el('button', { type: 'button', tabindex: '-1' }, 'Primary action')]),
      ]),
    ]));
  }
  return el('section', { class: 'design-handoff', dataset: { panelSection: 'ui-design' } }, children);
}

/**
 * Render the Claude-generated HTML mockup inside a sandboxed iframe with scripts
 * DISABLED (empty sandbox). Even though the server strips scripts/handlers, the
 * empty sandbox means any markup that slips through cannot execute JS, read
 * cookies, or navigate the parent — the XSS surface is neutralized.
 */
function sandboxedDesignFrame(html) {
  return el('iframe', {
    class: 'design-mockup-frame',
    sandbox: '',
    title: 'Generated UI mockup (sandboxed preview)',
    srcdoc: String(html || ''),
    loading: 'lazy',
    dataset: { panelSection: 'ui-mockup' },
  });
}

function renderImplementationRail(host, result) {
  const payload = result.payload || {};
  const draft = payload.task || buildImplementationTask(result.route?.input || 'Review implementation change');
  const projects = payload.projects || [];
  const project = el('select', { 'aria-label': 'Project for this task' }, [
    el('option', { value: '' }, projects.length ? 'Choose a project…' : 'No connected projects'),
    ...projects.map((item) => el('option', { value: item.id }, item.name || item.id)),
  ]);
  const title = el('input', { type: 'text', maxlength: '255', value: draft.title, 'aria-label': 'Task title' });
  const description = el('textarea', { rows: '9', maxlength: '20000', 'aria-label': 'Task description' }, draft.description);
  const confirm = el('input', { type: 'checkbox', id: `confirm-task-${Date.now()}` });
  const create = el('button', { class: 'primary', type: 'button', disabled: true }, 'Create project task');
  const feedback = el('div', { class: 'task-create-feedback', role: 'status', 'aria-live': 'polite' });
  const idempotencyKey = `agent:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  const updateCreateState = () => {
    create.disabled = !project.value || !confirm.checked || !title.value.trim();
  };
  project.addEventListener('change', updateCreateState);
  confirm.addEventListener('change', updateCreateState);
  title.addEventListener('input', updateCreateState);
  create.addEventListener('click', async () => {
    create.disabled = true;
    create.textContent = 'Creating…';
    feedback.className = 'task-create-feedback';
    feedback.textContent = 'Creating one idempotent project task…';
    try {
      const response = await api.createProjectTask({
        projectId: project.value,
        title: title.value.trim(),
        description: description.value.trim(),
        priority: draft.priority,
        idempotencyKey,
      });
      const issue = response.issue || {};
      create.textContent = response.replayed ? 'Task already created' : 'Task created';
      feedback.classList.add('success');
      clear(feedback).append(
        el('strong', {}, issue.identifier ? `${issue.identifier} created` : 'Project task created'),
        el('p', {}, issue.title || title.value.trim()),
        issue.url ? el('a', { href: issue.url, target: '_blank', rel: 'noreferrer' }, 'Open task') : null
      );
    } catch (error) {
      create.disabled = false;
      create.textContent = 'Try creating task again';
      feedback.classList.add('error');
      feedback.textContent = error.message;
    }
  });

  clear(host).append(
    railIntro('Confirm project task', 'The router prepared a bounded draft. Nothing is created until you choose a project and approve it here.'),
    payload.error ? el('div', { class: 'rail-inline-notice warning' }, payload.error) : null,
    el('form', { class: 'task-draft-form', dataset: { panelSection: 'task-draft' }, onsubmit: (event) => event.preventDefault() }, [
      formField('Project', project),
      formField('Task title', title),
      formField('Description & acceptance criteria', description),
      el('label', { class: 'task-confirm-row', for: confirm.id }, [confirm, el('span', {}, 'I reviewed this task and want to create it in the selected project.')]),
      create,
      feedback,
    ]),
    el('p', { class: 'rail-copy' }, 'Team ownership is derived server-side. The browser never receives a raw tracker mutation or integration credential.')
  );
}

function renderActivityRail(host, jobs) {
  const visible = (jobs || []).slice(0, 12);
  clear(host).append(
    railIntro('Workspace activity', 'Recent planning and implementation runs, newest first.'),
    visible.length
      ? el('div', { class: 'rail-job-list', dataset: { panelSection: 'activity' } }, visible.map((job) => {
          const button = el('button', { type: 'button', class: 'rail-job-card' }, [
            el('span', { class: `rail-job-status status-${job.status || 'unknown'}`, 'aria-hidden': 'true' }),
            el('div', {}, [
              el('small', {}, `${job.kind === 'coding' ? 'Implementation' : 'Planning'} · ${job.status || 'unknown'}`),
              el('strong', {}, job.projectName || job.taskTitle || job.taskIdentifier || 'Agent run'),
              el('p', {}, job.error || `${(job.steps || []).length} recorded activity steps`),
            ]),
          ]);
          button.addEventListener('click', () => renderJobRail(host, job));
          return button;
        }))
      : emptyRail('No activity yet', 'Scheduled planning and implementation runs will appear here.'),
    el('a', { class: 'rail-action-link', href: '#/agent-jobs' }, 'View complete job history')
  );
}

function formField(label, control) {
  return el('label', { class: 'task-form-field' }, [el('span', {}, label), control]);
}

function summaryStat(value, label, tone) {
  return el('div', { dataset: { tone } }, [el('strong', {}, String(value)), el('span', {}, label)]);
}

function emptyRail(title, copy) {
  return el('div', { class: 'empty-rail' }, [el('strong', {}, title), el('p', {}, copy)]);
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
  const pause = agentPauseInfo(safe);
  host.append(
    railIntro('Workspace setup', 'Automatic planning and the model that supports this conversation.'),
    el('div', { class: 'rail-summary' }, [
      el('div', {}, [el('strong', {}, String(counts.running || 0)), el('span', {}, 'active')]),
      el('div', {}, [el('strong', {}, String(counts.done || 0)), el('span', {}, 'done')]),
      el('div', {}, [el('strong', {}, String(counts.error || 0)), el('span', {}, 'needs help')]),
    ]),
    el('div', { class: 'rail-section-label' }, 'Current setup'),
    detailCard([
      ['Planning', pause ? t('agentPaused', 'Paused') : safe.scheduleEnabled ? `Every ${safe.intervalMinutes || 5} minutes` : 'Paused'],
      ['Model', safe.localActiveModel || safe.ollamaModel || 'Not configured'],
      ['Acting as', safe.assumedRole ? safe.assumedRole.name : 'No role selected'],
      ['Labels', (safe.enrichLabels || []).join(', ') || 'Any'],
    ]),
    el('a', { class: 'rail-action-link', href: '#/settings' }, 'Change workspace settings')
  );
}

function renderJobRail(host, job) {
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
  const titleAttrs = title && typeof title === 'object' ? title.attrs || {} : {};
  const copyAttrs = copy && typeof copy === 'object' ? copy.attrs || {} : {};
  const titleText = title && typeof title === 'object' ? title.text : title;
  const copyText = copy && typeof copy === 'object' ? copy.text : copy;
  return el('article', { class: `conversation-message assistant ${kind}`.trim() }, [
    el('div', { class: 'message-avatar' }, 'S'),
    el('div', { class: 'message-copy' }, [
      el('strong', { class: 'message-title', ...titleAttrs }, titleText),
      el('p', copyAttrs, copyText),
      links.length ? el('div', { class: 'message-links' }, links.map((link) => {
        const localized = link.i18n ? { dataset: { i18n: link.i18n, i18nFallback: link.label } } : {};
        if (link.href) return el('a', { href: link.href, ...localized, ...(link.external ? { target: '_blank', rel: 'noreferrer' } : {}) }, link.label);
        return el('button', { type: 'button', onclick: link.action, ...localized }, link.label);
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
