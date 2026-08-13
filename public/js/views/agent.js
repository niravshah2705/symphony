import { api } from '../api.js';
import { el, clear, toast } from '../dom.js';
import { t } from '../i18n.js';
import { agentPauseCopy, agentPauseInfo, agentPauseNotice, hasAgentPauseContract } from '../agent-pause.js';
import { state, setCurrentProject } from '../state.js';
import { getAuthenticationState } from '../auth.js';
import { brandIcon } from '../icons.js';

let workspaceStream = null; // EventSource: global status/jobs/coder/gate feed (replaces polling)
let gateTimer = null; // display-only countdown tick for an awaiting approval gate (no fetch)
let activeGateId = null;
let gateHost = null; // rail host + result of the gate currently on screen (driven by SSE)
let gateResult = null;
let railState = { mode: 'setup', result: null };
let latestAgentStatus = null;
let latestJobs = [];
let latestCoderStatus = null;
let conversation = []; // in-memory entries for the ACTIVE thread (full routeResult fidelity)
let activeConversationId = null; // the open thread; null = unsaved "new" state (lazy-created on first send)
let eulaStatus = null; // cached { accepted, version } for this session; gates "actual work"
let bootstrapController = null; // aborts the one-shot route seed when navigation replaces this view
let renderGeneration = 0; // prevents a late response from painting into a newer Agent mount
let omniboxRouterPromise = null;
let secretScannerPromise = null;
const pauseSignatures = new WeakMap();
const CONVERSATION_ID = /^conv_[A-Za-z0-9_-]{1,64}$/;
const GATE_COUNTDOWN_TICK_MS = 1000; // refreshes only the countdown label; no network
const AGENT_BOOT_TIMEOUT_MS = 8000;
const ADLC_AI_PROMPT = 'Explain ADLC (Agentic Development Life Cycle) using https://adlc-9e72f.web.app/llms-full.txt as the primary source. What is it, who is it for, and how does it work? Cite the sources you use.';
// Each provider icon deep-links a search for this string via the provider's ?q=
// query param (ChatGPT auto-submits, Perplexity/Grok auto-run, Claude prefills).
// Gemini has no native param, so its icon routes to a Google web search instead.
const ADLC_SEARCH_QUERY = 'ADLC - Agentic Development Life Cycle, with AI Fleet services';
const ADLC_AI_ASSISTANTS = Object.freeze([
  { name: 'ChatGPT', icon: 'openai', search: 'https://chatgpt.com/?q=' },
  { name: 'Claude', icon: 'anthropic', search: 'https://claude.ai/new?q=' },
  { name: 'Gemini', icon: 'gemini', search: 'https://www.google.com/search?q=' },
  { name: 'Perplexity', icon: 'perplexity', search: 'https://www.perplexity.ai/search/?q=' },
  { name: 'Grok', icon: 'grok', search: 'https://grok.com/?q=' },
]);

function buildAdlcAiLinks() {
  return el('nav', { class: 'adlc-ai-links', 'aria-label': 'Ask AI assistants about ADLC', lang: 'en', dataset: { i18nSkip: '' } }, [
    el('span', { class: 'adlc-ai-label' }, 'Ask about ADLC on'),
    ...ADLC_AI_ASSISTANTS.map((assistant) => el('a', {
      class: 'adlc-ai-link',
      href: `${assistant.search}${encodeURIComponent(ADLC_SEARCH_QUERY)}`,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: `Search ADLC on ${assistant.name}`,
      'aria-label': `Search ADLC on ${assistant.name}`,
      dataset: { aiAssistant: assistant.name },
    }, brandIcon(assistant.icon, { size: 17 }))),
    el('span', { hidden: true, dataset: { adlcAiPrompt: '' } }, ADLC_AI_PROMPT),
  ]);
}

function loadOmniboxRouter() {
  if (!omniboxRouterPromise) omniboxRouterPromise = import('../omnibox-router.mjs');
  return omniboxRouterPromise;
}

function loadSecretScanner() {
  if (!secretScannerPromise) secretScannerPromise = import('../secret-scan.mjs');
  return secretScannerPromise;
}

function stopRefresh() {
  if (bootstrapController) {
    bootstrapController.abort();
    bootstrapController = null;
  }
  if (workspaceStream) {
    try { workspaceStream.close(); } catch (_) { /* already closed */ }
    workspaceStream = null;
  }
  stopGatePoll();
}

function stopGatePoll() {
  if (gateTimer) clearInterval(gateTimer);
  gateTimer = null;
  activeGateId = null;
  gateHost = null;
  gateResult = null;
}

function agentRouteActive() {
  return location.hash === '#/agent' || location.hash.startsWith('#/agent/');
}

window.addEventListener('hashchange', () => {
  if (!agentRouteActive()) {
    renderGeneration += 1;
    stopRefresh();
  }
});

// Pin the view to the newest message (composer is sticky at the bottom).
function scrollConversationToEnd() {
  const lastMessage = document.querySelector('.agent-reader .conversation-stream')?.lastElementChild;
  lastMessage?.scrollIntoView({ block: 'end' });
}

export async function renderAgent(view) {
  stopRefresh();
  const generation = ++renderGeneration;
  eulaStatus = null; // re-check acceptance on each mount (handles a signed-in identity change)
  railState = { mode: 'setup', result: null };
  latestAgentStatus = null;
  latestJobs = [];
  latestCoderStatus = null;
  conversation = [];

  // The document contains this scaffold on the default route, so the hero can
  // paint before JavaScript, auth, or API data. Deep links use the same shape.
  const scaffold = ensureAgentScaffold(view, generation);
  const { pauseHost, stream, railBody } = scaffold;
  const session = getAuthenticationState();
  if (session.enabled && !session.authenticated) {
    activeConversationId = null;
    hydratePublicAgent(scaffold);
    return;
  }

  const controller = new AbortController();
  bootstrapController = controller;
  const timedRequest = () => {
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    const timeout = setTimeout(abortRequest, AGENT_BOOT_TIMEOUT_MS);
    if (controller.signal.aborted) abortRequest();
    else controller.signal.addEventListener('abort', abortRequest, { once: true });
    return {
      options: { signal: requestController.signal },
      dispose() {
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', abortRequest);
      },
    };
  };
  const seedRequest = timedRequest();
  const requestOptions = seedRequest.options;
  let toolbar = scaffold.toolbar;
  let toolbarSignature = '';
  const requestedWorkspaceId = parseWorkspaceId();
  activeConversationId = requestedWorkspaceId && CONVERSATION_ID.test(requestedWorkspaceId)
    ? requestedWorkspaceId
    : null;

  const isCurrentMount = () => generation === renderGeneration
    && view.isConnected
    && agentRouteActive();

  const replaceToolbar = () => {
    if (!latestAgentStatus || !isCurrentMount()) return;
    const nextSignature = agentToolbarSignature(latestAgentStatus);
    if (nextSignature === toolbarSignature) return;
    const replacement = agentToolbar(latestAgentStatus, view, railBody, isCurrentMount);
    replacement.dataset.agentToolbar = '';
    toolbar.replaceWith(replacement);
    toolbar = replacement;
    toolbarSignature = nextSignature;
  };

  const refreshSeedChrome = () => {
    if (!isCurrentMount()) return;
    renderPauseNotices(pauseHost, ...pauseSources(latestAgentStatus, latestCoderStatus, latestJobs));
    replaceToolbar();
    if (railState.mode !== 'result') renderCurrentRail(railBody);
  };

  // Re-render the pause notices, toolbar, and rail from the latest state after
  // an SSE update. Signatures keep stable controls out of the mutation path.
  const applyWorkspaceUpdate = () => {
    if (!isCurrentMount()) return;
    renderPauseNotices(pauseHost, ...pauseSources(latestAgentStatus, latestCoderStatus, latestJobs));
    replaceToolbar();
    if (railState.mode !== 'result') renderCurrentRail(railBody);
  };

  // Start independent requests together. Each result patches only its own
  // region so a slow conversations request never holds back status controls.
  const statusPromise = api.getAgentStatus(requestOptions)
    .catch((error) => ({ unavailable: true, error: error.message, counts: {} }))
    .then((status) => {
      if (isCurrentMount()) {
        latestAgentStatus = status;
        refreshSeedChrome();
      }
      return status;
    });
  const jobsPromise = api.getJobs(requestOptions)
    .catch(() => ({ jobs: [] }))
    .then((response) => {
      if (isCurrentMount()) {
        latestJobs = response.jobs || [];
        refreshSeedChrome();
      }
      return response;
    });
  const coderPromise = api.getCoderStatus(requestOptions)
    .catch(() => null)
    .then((status) => {
      if (isCurrentMount()) {
        latestCoderStatus = status;
        refreshSeedChrome();
      }
      return status;
    });
  const threadsPromise = api.listConversations(requestOptions)
    .catch(() => ({ conversations: [] }))
    .then((response) => {
      if (isCurrentMount()) replaceThreadRail(scaffold, response.conversations || []);
      return response;
    });
  const loadConversation = (id) => {
    const detailRequest = timedRequest();
    return api.getConversation(id, detailRequest.options)
      .then((response) => response.conversation)
      .catch(() => null)
      .finally(detailRequest.dispose);
  };
  const activeConversationPromise = requestedWorkspaceId && CONVERSATION_ID.test(requestedWorkspaceId)
    ? loadConversation(requestedWorkspaceId)
    : !requestedWorkspaceId
      ? threadsPromise.then((response) => {
        const recentId = response.conversations?.[0]?.id;
        return recentId ? loadConversation(recentId) : null;
      })
      : Promise.resolve(null);

  try {
    const [status, , , threadsResponse, active] = await Promise.all([
      statusPromise,
      jobsPromise,
      coderPromise,
      threadsPromise,
      activeConversationPromise,
    ]);
    if (!isCurrentMount()) return;

    const summaries = threadsResponse.conversations || [];
    if (!requestedWorkspaceId && active) {
      try { window.history.replaceState(null, '', `#/agent/${active.id}`); } catch (_) { /* ignore */ }
    }

    activeConversationId = active ? active.id : null;
    conversation = active ? hydrateMessages(active.messages) : [];
    replaceThreadRail(scaffold, summaries);

    // Build the transcript off-DOM, then publish it in one mutation. This keeps
    // large restored threads from repeatedly invalidating the reader layout.
    const transcript = document.createDocumentFragment();
    renderWelcome(transcript, status);
    for (const entry of conversation) transcript.append(renderConversationEntry(entry, railBody));
    stream.replaceChildren(transcript);
    scaffold.root.removeAttribute('data-i18n-skip');
    scaffold.root.dataset.agentScaffold = 'hydrated';
    setComposerReady(scaffold.root, true);
    requestAnimationFrame(scrollConversationToEnd);

    // Live updates over SSE replace the old 5s polling of /status + /jobs + /coder.
    // Initial state above is the one-shot seed; typed events keep it current.
    void openWorkspaceStream((event) => {
      if (!isCurrentMount()) return;
      applyWorkspaceEvent(event, applyWorkspaceUpdate);
    }, isCurrentMount);
  } finally {
    seedRequest.dispose();
    if (bootstrapController === controller) bootstrapController = null;
  }
}

// Anonymous visitors intentionally receive the public ADLC/documentation
// experience, but none of the tenant hydration used by an authenticated Agent
// mount. Keeping this as an early, complete render path prevents future seed or
// stream additions from silently becoming public network calls.
function hydratePublicAgent(scaffold) {
  const publicThreads = el('aside', {
    class: 'conversation-rail',
    'aria-label': 'Public Agent access',
    dataset: { agentThreads: '' },
  }, [
    el('div', { class: 'conversation-rail-head' }, [
      el('strong', {}, 'Public Agent'),
      el('span', {}, 'Read only'),
    ]),
    el('p', { class: 'rail-copy' }, 'Search the reviewed ADLC documentation. Sign in for private history and workspace activity.'),
    el('a', { class: 'btn', href: '#/settings' }, 'Sign in for workspace access'),
  ]);
  scaffold.threadRail.replaceWith(publicThreads);
  scaffold.threadRail = publicThreads;

  const publicToolbar = el('div', { class: 'reader-toolbar agent-toolbar', dataset: { agentToolbar: '' } }, [
    el('div', { class: 'breadcrumbs' }, [
      el('span', {}, 'Workspace'),
      el('span', {}, '›'),
      el('strong', {}, 'Public Agent'),
    ]),
    el('span', { class: 'privacy-chip' }, 'Reviewed docs only'),
  ]);
  scaffold.toolbar.replaceWith(publicToolbar);

  const publicTabs = el('div', {
    class: 'rail-tabs agent-rail-tabs',
    id: 'agent-public-tab',
    dataset: { agentRailTabs: '' },
  }, 'Public access');
  scaffold.root.querySelector('[data-agent-rail-tabs]')?.replaceWith(publicTabs);
  scaffold.railBody.setAttribute('aria-labelledby', 'agent-public-tab');
  clear(scaffold.railBody).append(
    railIntro('Read-only Agent', 'Public access is isolated from private organizations, projects, conversations, and run activity.'),
    el('section', { class: 'route-policy-card', dataset: { panelSection: 'public-access' } }, [
      el('span', { class: 'route-policy-icon', 'aria-hidden': 'true' }, '✳'),
      el('strong', {}, 'Reviewed ADLC documentation'),
      el('p', {}, 'Ask a documentation question here. Sign in before accessing tenant data or starting work.'),
    ]),
    el('a', { class: 'rail-action-link', href: '#/settings' }, 'Sign in to continue'),
  );

  scaffold.stream.replaceChildren(
    assistantMessage(
      'Public knowledge is ready.',
      'Ask about ADLC or search the reviewed documentation. Private memory, conversations, projects, jobs, and agent actions stay unavailable until you sign in.',
      [{ label: 'Sign in for private workspace access', href: '#/settings' }],
      'notice'
    )
  );
  scaffold.root.removeAttribute('data-i18n-skip');
  scaffold.root.dataset.agentScaffold = 'public';
  setComposerReady(scaffold.root, true);
}

/** Return the pre-rendered Agent shell, or create the same shell for a deep link. */
function ensureAgentScaffold(view, generation) {
  let root = view.querySelector('[data-agent-scaffold]');
  const requiredSlots = [
    '[data-agent-threads]',
    '.agent-reader',
    '[data-agent-toolbar]',
    '.agent-pause-host',
    '[data-agent-hero]',
    '.conversation-stream',
    '[data-agent-composer]',
    '.scenario-rail',
    '[data-agent-rail-tabs]',
    '#agent-details-panel',
  ];
  if (root && !requiredSlots.every((selector) => root.querySelector(selector))) root = null;
  if (!root) {
    root = el('section', { class: 'agent-workspace', dataset: { agentScaffold: 'initial' } }, [
      el('aside', { class: 'conversation-rail', 'aria-label': 'Conversations', dataset: { agentThreads: '' } }),
      el('div', { class: 'scenario-reader agent-reader' }, [
        el('div', { class: 'reader-toolbar agent-toolbar agent-toolbar-loading', dataset: { agentToolbar: '' }, 'aria-hidden': 'true' }),
        el('div', { class: 'conversation-wrap agent-omnibox-wrap' }, [
          el('div', { class: 'agent-pause-host', hidden: true }),
          el('header', { class: 'omnibox-hero', dataset: { agentHero: '' } }, [
            el('span', { class: 'omnibox-eyebrow' }, [
              el('span', { class: 'omnibox-spark', 'aria-hidden': 'true' }, '✳'),
              'ADLC · Agentic Development Life Cycle',
            ]),
            el('h1', {}, 'What should we move forward?'),
            el('p', {}, 'Ask a question, search workspace memory, pressure-test a business, troubleshoot a run, or turn an implementation change into a task.'),
            buildAdlcAiLinks(),
          ]),
          el('div', { class: 'conversation-stream', 'aria-live': 'polite' }, [
            el('p', { class: 'agent-loading-copy' }, 'Loading recent workspace activity…'),
          ]),
          el('div', { class: 'chat-composer omnibox-composer agent-composer-loading', dataset: { agentComposer: '' }, 'aria-hidden': 'true' }),
        ]),
      ]),
      el('aside', { class: 'evidence-rail scenario-rail', 'aria-label': 'Agent details' }, [
        el('div', { class: 'rail-tabs agent-rail-tabs', dataset: { agentRailTabs: '' }, 'aria-hidden': 'true' }),
        el('div', {
          id: 'agent-details-panel',
          class: 'rail-content',
          role: 'tabpanel',
          'aria-labelledby': 'agent-setup-tab',
        }),
      ]),
    ]);
    clear(view).append(root);
  }

  const pauseHost = root.querySelector('.agent-pause-host');
  const stream = root.querySelector('.conversation-stream');
  const railBody = root.querySelector('#agent-details-panel');
  let toolbar = root.querySelector('[data-agent-toolbar]');
  const composerSlot = root.querySelector('[data-agent-composer]');
  const tabsSlot = root.querySelector('[data-agent-rail-tabs]');

  const composer = buildComposer(stream, railBody, generation);
  composer.dataset.agentComposer = '';
  composerSlot.replaceWith(composer);
  setComposerReady(root, false);
  const tabs = buildRailTabs(railBody);
  tabs.dataset.agentRailTabs = '';
  tabsSlot.replaceWith(tabs);

  if (!toolbar) {
    toolbar = el('div', { class: 'reader-toolbar agent-toolbar agent-toolbar-loading', dataset: { agentToolbar: '' }, 'aria-hidden': 'true' });
    root.querySelector('.agent-reader').prepend(toolbar);
  }
  return { root, pauseHost, stream, railBody, toolbar, threadRail: root.querySelector('[data-agent-threads]') };
}

function setComposerReady(root, ready) {
  const composer = root.querySelector('[data-agent-composer]');
  if (!composer) return;
  composer.toggleAttribute('aria-busy', !ready);
  for (const control of composer.querySelectorAll('button, textarea')) control.disabled = !ready;
}

function replaceThreadRail(scaffold, summaries) {
  if (!scaffold.threadRail?.isConnected) scaffold.threadRail = scaffold.root.querySelector('[data-agent-threads]');
  const replacement = buildThreadRail(summaries);
  replacement.dataset.agentThreads = '';
  scaffold.threadRail.replaceWith(replacement);
  scaffold.threadRail = replacement;
}

/** Apply one typed workspace event onto the module state, then refresh the UI. */
function applyWorkspaceEvent(event, applyWorkspaceUpdate) {
  if (!event || !event.type) return;
  if (event.type === 'agent-status' && event.status) {
    // MERGE so the model/provider fields from the seed load survive a partial
    // transition snapshot (counts + pause + schedule).
    latestAgentStatus = { ...latestAgentStatus, ...event.status };
    applyWorkspaceUpdate();
  } else if (event.type === 'jobs' && Array.isArray(event.jobs)) {
    latestJobs = event.jobs;
    applyWorkspaceUpdate();
  } else if (event.type === 'coder') {
    latestCoderStatus = event.coder || null;
    applyWorkspaceUpdate();
  } else if (event.type === 'gate') {
    void handleGateEvent(event);
  }
}

/**
 * Open the workspace SSE stream, closing any prior one and guarding against a
 * navigation that happened while the token request was in flight.
 */
async function openWorkspaceStream(onEvent, isCurrent = agentRouteActive) {
  stopStreamOnly();
  let source;
  try {
    source = await api.openWorkspaceStream(onEvent);
  } catch (_) {
    return; // best-effort; the initial seed load still populated the view
  }
  if (!isCurrent()) {
    try { source.close(); } catch (_) { /* ignore */ }
    return;
  }
  workspaceStream = source;
}

/** Close just the stream (used before reopening) without disturbing the gate timer. */
function stopStreamOnly() {
  if (workspaceStream) {
    try { workspaceStream.close(); } catch (_) { /* already closed */ }
    workspaceStream = null;
  }
}

/**
 * Drive an on-screen approval gate to its terminal state from an SSE `gate`
 * event (server auto-approve after the deadline, or an approve/supersede in
 * another tab). The local timer is now display-only, so this is what advances
 * the pipeline — no polling.
 */
async function handleGateEvent(event) {
  if (!activeGateId || event.gateId !== activeGateId) return;
  const host = gateHost;
  const result = gateResult;
  if (event.status === 'proceeded') {
    stopGatePoll();
    if (host && result) {
      result.gate = { ...(result.gate || {}), status: 'proceeded' };
      try {
        await proceedToPipeline(host, result);
      } catch (_) {
        // A transient prepare failure leaves the gate view as-is; the operator
        // can retry via the on-screen controls.
      }
    }
  } else if (event.status !== 'awaiting-approval') {
    stopGatePoll(); // superseded or otherwise terminal
  }
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

function agentToolbar(status, view, railBody, isCurrentMount = () => view.isConnected && agentRouteActive()) {
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
      if (isCurrentMount()) await renderAgent(clear(view));
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
      if (isCurrentMount()) await renderAgent(clear(view));
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

function buildComposer(stream, railBody, generation = renderGeneration) {
  const input = el('textarea', {
    rows: '3',
    maxlength: '8000',
    placeholder: 'Ask anything or describe what you want done…',
    'aria-label': 'Ask or act from the Agent omnibox',
  });
  const count = el('span', { class: 'composer-count' }, '0 / 8,000');
  const send = el('button', { class: 'primary scenario-submit', type: 'button' }, 'Send');
  let persistenceQueue = Promise.resolve();
  let persistedConversationId = null;
  let submitting = false;
  const isCurrentComposer = () => generation === renderGeneration
    && agentRouteActive()
    && stream.isConnected;

  const submit = async () => {
    if (!isCurrentComposer() || submitting) return;
    const text = input.value.trim();
    if (!text) return;
    submitting = true;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    send.disabled = true;
    send.textContent = 'Checking…';

    // Best-effort client-side guard: strip anything that looks like a secret
    // BEFORE it leaves the browser. `outgoing` is used for every downstream
    // path (local echo, routing, search, persistence) so no channel leaks the
    // original. The server redacts again — this is convenience, not a control.
    let scan;
    try {
      const { scanSecrets } = await loadSecretScanner();
      scan = scanSecrets(text);
    } catch (_) {
      submitting = false;
      if (isCurrentComposer()) {
        input.value = text;
        input.dispatchEvent(new Event('input'));
        send.disabled = false;
        send.textContent = 'Send';
        toast('The browser safety check could not load. Your message was not sent.', 'err');
      }
      return;
    }
    if (!isCurrentComposer()) {
      submitting = false;
      return;
    }
    const outgoing = scan.found ? scan.redacted : text;
    const targetConversationId = activeConversationId || persistedConversationId;

    const user = { role: 'user', text: outgoing };
    conversation.push(user);
    stream.append(renderConversationEntry(user, railBody));

    if (scan.found) {
      const types = scan.types.join(', ');
      toast(`Removed secrets before sending: ${types}.`, 'err');
      stream.append(
        assistantMessage(
          'Secrets removed before sending',
          `Your message looked like it contained secrets (${types}). They were replaced with «redacted» before it left this browser and before anything was saved. Please rotate anything that was already exposed elsewhere.`,
          [],
          'notice'
        )
      );
    }

    const pending = assistantMessage('Routing your request…', 'Identifying the safest, most useful workspace path and gathering only the details it needs.');
    pending.classList.add('is-pending');
    pending.dataset.agentIntent = 'routing';
    stream.append(pending);
    scrollConversationToEnd();
    send.textContent = 'Thinking…';

    try {
      const result = await resolveOmniboxRequest(outgoing);
      if (!isCurrentComposer()) return;
      // The request needs EULA acceptance — show the inline acceptance card and
      // stop here. Accepting re-runs the exact same request; declining is recorded.
      if (result.eulaRequired) {
        pending.replaceWith(renderEulaGate({
          version: result.eula && result.eula.version,
          onAccept: async () => {
            if (!isCurrentComposer()) return;
            await api.recordEulaDecision('accepted');
            if (!isCurrentComposer()) return;
            eulaStatus = { accepted: true, version: result.eula && result.eula.version };
            input.value = text;
            await submit();
          },
          onReject: () => api.recordEulaDecision('rejected').catch(() => {}),
        }));
        scrollConversationToEnd();
        return;
      }
      const entry = { role: 'assistant', routeResult: result };
      conversation.push(entry);
      pending.replaceWith(renderConversationEntry(entry, railBody));
      scrollConversationToEnd();
      showRailResult(railBody, result);
      // Public conversations stay browser-local. Persist only after the
      // application has established an authenticated identity.
      if (getAuthenticationState().authenticated) {
        persistenceQueue = persistenceQueue.then(async () => {
          const persistedId = await persistTurn(
            outgoing,
            result,
            generation,
            targetConversationId || persistedConversationId
          );
          if (persistedId) persistedConversationId = persistedId;
        });
      }
      // A build request runs a guided, human-in-the-loop flow inline in the chat.
      if (result.route && result.route.intent === 'build' && !result.requiresAuthentication) {
        void startBuildFlow(result.route, stream, railBody);
      }
    } catch (error) {
      if (!isCurrentComposer()) return;
      pending.replaceWith(
        assistantMessage(
          'I couldn’t route that request.',
          error.message || 'The workspace service did not respond. Your request was not applied or scheduled.',
          [{ label: 'Check workspace health', href: '#/troubleshooting' }],
          'error'
        )
      );
    } finally {
      submitting = false;
      if (isCurrentComposer()) {
        send.disabled = false;
        send.textContent = 'Send';
      }
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

// Intents that perform "actual work" (schedule enrichment, prepare a business,
// create an implementation task) and therefore require EULA acceptance. The
// read-only RAG intents (knowledge/troubleshooting/general/salutation) are never
// gated, so a first-time user can still ask questions and search.
const WORK_INTENTS = new Set(['business', 'build', 'implementation']);
const AUTHENTICATED_AGENT_INTENTS = new Set(['business', 'build', 'implementation', 'troubleshooting']);

/**
 * Whether the current user may run actions. A member of an organisation is
 * considered to have already accepted (recorded once, up front). The result is
 * cached for the session; the gateway re-checks on every mutation, so this only
 * decides whether to show the acceptance prompt before doing the work.
 */
async function ensureEulaAccepted() {
  if (eulaStatus && eulaStatus.accepted) return true;
  try {
    const status = await api.getEulaStatus();
    if (status && status.accepted) { eulaStatus = status; return true; }
    const me = await api.getMe().catch(() => null);
    if (me && me.has_organization) {
      await api.recordEulaDecision('accepted', 'org-member').catch(() => {});
      eulaStatus = { accepted: true, version: status ? status.version : null };
      return true;
    }
    eulaStatus = status || { accepted: false, version: null };
    return false;
  } catch (_) {
    // Fail closed on the client (prompt to accept); the server gate is the real
    // trust boundary and will still block the mutation if this is bypassed.
    return false;
  }
}

async function resolveOmniboxRequest(text) {
  const router = await loadOmniboxRouter();
  let routed;
  // Anonymous visitors get BASIC RAG: the server router (POST /agent/message)
  // needs workspace:write, so for a public session we classify in the browser
  // and use only the public reviewed-documentation search endpoint. This
  // also avoids a 401 that would otherwise churn the auth state mid-search.
  const session = getAuthenticationState();
  if (!session.authenticated) {
    routed = { route: router.classifyOmniboxIntent(text), enrichment: null, offline: true };
  } else {
    try {
      routed = await api.routeAgentMessage({ input: text });
    } catch (error) {
      // Keep the workspace useful during a planner restart. The same deterministic
      // classifier runs in the browser as a no-mutation fallback; server routing
      // remains the authoritative pre-model safety gate during normal operation.
      routed = {
        route: router.classifyOmniboxIntent(text),
        enrichment: null,
        offline: true,
        warning: error.message || 'The server router was unavailable, so a local no-action route was used.',
      };
    }
  }
  const route = routed.route || router.classifyOmniboxIntent(text);
  const base = { route, warning: routed.warning || null };

  // Gate "actual work" behind EULA acceptance for signed-in users. RAG questions
  // fall through untouched. Anonymous visitors are not prompted here — they hit
  // the normal sign-in-required path when the server rejects the write.
  if (session.authenticated && WORK_INTENTS.has(route.intent) && !(await ensureEulaAccepted())) {
    return { ...base, eulaRequired: true, eula: { version: eulaStatus ? eulaStatus.version : null } };
  }

  // Public mode is deliberately documentation-only. These intent previews are
  // useful for explaining what Agent can do, but must not query tenant state or
  // expose controls that can start work.
  if (!session.authenticated && AUTHENTICATED_AGENT_INTENTS.has(route.intent)) {
    return { ...base, requiresAuthentication: true, payload: {} };
  }

  if (route.intent === 'knowledge') {
    if (!session.authenticated) {
      const documentsResponse = await api.searchAgentKnowledge({ query: route.input })
        .catch((error) => ({ results: [], indexedFiles: 0, error: error.message }));
      const sources = {
        documents: documentsResponse.results || [],
        indexedFiles: documentsResponse.indexedFiles || 0,
        businesses: [],
        projects: [],
        jobs: [],
      };
      return {
        ...base,
        public: true,
        payload: {
          sources,
          scope: 'documentation',
          results: router.searchWorkspaceMemory(route.input, sources),
          unavailable: documentsResponse.error ? [documentsResponse.error] : [],
        },
      };
    }
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
        results: [...memoryResults, ...router.searchWorkspaceMemory(route.input, sources)],
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
        ...router.summarizeTroubleshooting(diagnostics, jobsResponse.jobs || []),
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
      payload: routed.offline ? router.buildBusinessWorkspace(route.input, {}) : null,
    };
  }

  if (route.intent === 'implementation') {
    const projectsResponse = await api.getProjects().catch((error) => ({ projects: [], error: error.message }));
    return {
      ...base,
      payload: {
        task: router.buildImplementationTask(route.input),
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
  if (entry.stored) return renderStoredAssistant(entry.stored, railBody);
  const analysis = entry.analysis;
  const message = assistantMessage(
    analysis.goal ? 'Here’s what I heard.' : 'I’ve organized that.',
    analysis.summary,
    [{ label: 'View details', action: async () => {
      const router = await loadOmniboxRouter();
      showRailResult(railBody, { route: router.classifyOmniboxIntent(analysis.goal || analysis.summary), analysis, payload: { analysis } });
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

/** The dynamic assistant copy for a routed result (reused for stored transcripts). */
function routedCopy(result) {
  const { route = {}, payload = {} } = result || {};
  if (result.requiresAuthentication) {
    return 'Sign in to use private workspace data or start Agent work. Public access remains limited to reviewed ADLC documentation.';
  }
  if (route.intent === 'knowledge') {
    if (result.public) {
      return payload.results?.length
        ? `I found ${payload.results.length} relevant match${payload.results.length === 1 ? '' : 'es'} in the reviewed documentation.`
        : 'I searched the reviewed documentation but did not find a matching passage.';
    }
    return payload.results?.length
      ? `I found ${payload.results.length} relevant workspace ${payload.results.length === 1 ? 'record' : 'records'} across memory, projects, and recent activity.`
      : 'I checked the connected workspace sources but did not find a matching record. I won’t invent a document or memory that is not connected.';
  }
  if (route.intent === 'troubleshooting') {
    return payload.headline ? `${payload.headline}. I also checked ${payload.signals?.length || 0} recent warning or error log signals.` : route.answer;
  }
  if (route.intent === 'business') {
    return !payload || !payload.stages
      ? 'This looks like business work. Open the result and press “Prepare business plan” to run the fraud gate, revenue metrics, memory, spec breakdown, UI mockup, and scheduling.'
      : payload.blocked || payload.fraud?.level === 'high'
        ? 'The fraud gate found high-risk signals, so I stopped before scheduling work. Review the flagged claims in the side panel.'
        : 'I ran the full business pipeline. Review the fraud gate, revenue metrics, memory, segments, and UI mockup in the side panel.';
  }
  if (route.intent === 'implementation' && !payload.projects?.length) {
    return 'I drafted the implementation task. Connect or create a project before confirming the task in the side panel.';
  }
  if (route.intent === 'general' && result.analysis?.summary) {
    return result.analysis.summary;
  }
  return route.answer;
}

function chipTone(intent) {
  return intent === 'unsafe' ? 'red' : intent === 'business' ? 'green' : 'blue';
}

function renderRoutedConversation(result, railBody) {
  const { route } = result;
  const links = result.requiresAuthentication
    ? [{ label: 'Sign in to continue', href: '#/settings' }]
    : route.intent === 'build'
      ? []
      : [{ label: route.intent === 'implementation' ? 'Review task' : 'Open result', action: () => showRailResult(railBody, result) }];
  if (route.intent === 'troubleshooting' && !result.requiresAuthentication) {
    links.push({ label: 'Full diagnostics', href: '#/troubleshooting' });
  }
  if (route.intent === 'knowledge' && !result.public) links.push({ label: 'Browse projects', href: '#/projects' });
  const message = assistantMessage(route.title, routedCopy(result), links, `intent-message intent-${route.intent}`);
  message.dataset.agentIntent = route.intent;
  const body = message.querySelector('.message-copy');
  body.prepend(el('span', { class: `intent-route-chip tone-${chipTone(route.intent)}` }, route.label));
  if (result.warning) body.append(el('p', { class: 'intent-warning' }, result.warning));
  return message;
}

/** Re-render a persisted assistant turn. "Open result" re-routes the original input live (read-only, no mutation). */
function renderStoredAssistant(stored, railBody) {
  const intent = stored.intent || 'general';
  const links = (stored.input && intent !== 'build') ? [{ label: 'Open result', action: async () => {
    try {
      showRailResult(railBody, await resolveOmniboxRequest(stored.input));
    } catch (error) {
      toast(error.message, 'err');
    }
  } }] : [];
  const message = assistantMessage(stored.title || 'Result', stored.copy || '', links, `intent-message intent-${intent}`);
  message.dataset.agentIntent = intent;
  const body = message.querySelector('.message-copy');
  if (stored.label) body.prepend(el('span', { class: `intent-route-chip tone-${chipTone(intent)}` }, stored.label));
  if (stored.warning) body.append(el('p', { class: 'intent-warning' }, stored.warning));
  return message;
}

/* --------------------------- Conversation threads ----------------------- */

/** The `<id>` from `#/agent/<id>` ('new' = explicit fresh thread; null = bare #/agent). */
function parseWorkspaceId() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  return parts[0] === 'agent' && parts[1] ? parts[1] : null;
}

function hydrateMessages(messages) {
  return (messages || []).map((message) => (message.role === 'user'
    ? { role: 'user', text: message.text }
    : { role: 'assistant', stored: message }));
}

function compactAssistant(userText, result) {
  const route = result.route || {};
  return {
    role: 'assistant',
    intent: route.intent || 'general',
    title: route.title || 'Result',
    copy: routedCopy(result),
    label: route.label || '',
    warning: result.warning || '',
    input: userText,
  };
}

async function persistTurn(userText, result, generation, conversationId) {
  if (!getAuthenticationState().authenticated) return null;
  let targetConversationId = conversationId;
  try {
    if (!targetConversationId && generation === renderGeneration && agentRouteActive()) {
      targetConversationId = activeConversationId;
    }
    if (!targetConversationId) {
      const created = await api.createConversation({});
      targetConversationId = created.conversation.id;
      if (generation === renderGeneration && agentRouteActive()) {
        activeConversationId = targetConversationId;
        try { window.history.replaceState(null, '', `#/agent/${targetConversationId}`); } catch (_) { /* ignore */ }
      }
    }
    await api.appendConversationMessages(targetConversationId, [
      { role: 'user', text: userText },
      compactAssistant(userText, result),
    ]);
    if (generation === renderGeneration && agentRouteActive()) void refreshThreadRail();
    return targetConversationId;
  } catch (_) {
    // A persistence failure should never break the live conversation.
    return targetConversationId;
  }
}

async function refreshThreadRail() {
  if (!getAuthenticationState().authenticated) return;
  const host = document.querySelector('.conversation-thread-list');
  if (!host) return;
  const { conversations = [] } = await api.listConversations().catch(() => ({ conversations: [] }));
  clear(host);
  if (!conversations.length) {
    host.append(el('p', { class: 'rail-copy' }, 'No conversations yet. Start one below.'));
    return;
  }
  for (const summary of conversations) host.append(threadItem(summary));
}

function buildThreadRail(summaries) {
  const newChat = el('button', { class: 'conversation-new', type: 'button' }, '+ New chat');
  newChat.addEventListener('click', () => { window.location.hash = '#/agent/new'; });
  const list = el('div', { class: 'conversation-thread-list' }, summaries.length
    ? summaries.map((summary) => threadItem(summary))
    : [el('p', { class: 'rail-copy' }, 'No conversations yet. Start one below.')]);
  return el('aside', { class: 'conversation-rail', 'aria-label': 'Conversations' }, [
    el('div', { class: 'conversation-rail-head' }, [el('strong', {}, 'Conversations'), newChat]),
    list,
  ]);
}

function threadItem(summary) {
  const active = summary.id === activeConversationId;
  const open = el('a', { class: 'conversation-thread-open', href: `#/agent/${summary.id}` }, [
    el('strong', {}, summary.title || 'New conversation'),
    el('small', {}, `${summary.messageCount || 0} message${summary.messageCount === 1 ? '' : 's'}`),
  ]);
  const rename = el('button', { class: 'conversation-thread-rename', type: 'button', 'aria-label': 'Rename conversation', title: 'Rename' }, '✎');
  rename.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); startRename(open, summary); });
  const del = el('button', { class: 'conversation-thread-delete', type: 'button', 'aria-label': 'Delete conversation', title: 'Delete' }, '×');
  del.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await api.deleteConversation(summary.id);
      if (summary.id === activeConversationId) window.location.hash = '#/agent';
      else void refreshThreadRail();
    } catch (error) {
      toast(error.message, 'err');
    }
  });
  return el('div', { class: `conversation-thread ${active ? 'active' : ''}`.trim(), dataset: { threadId: summary.id } }, [open, rename, del]);
}

/** Inline rename: replace the row with a text input; Enter/blur commits, Escape cancels. */
function startRename(open, summary) {
  const row = open.closest('.conversation-thread');
  if (!row) return;
  const input = el('input', { class: 'conversation-rename-input', type: 'text', maxlength: '120', value: summary.title || '', 'aria-label': 'Conversation title' });
  const commit = async () => {
    const title = input.value.trim();
    if (title && title !== summary.title) {
      try { await api.renameConversation(summary.id, title); } catch (error) { toast(error.message, 'err'); }
    }
    void refreshThreadRail();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    else if (event.key === 'Escape') { input.value = summary.title || ''; input.blur(); }
  });
  input.addEventListener('blur', commit, { once: true });
  clear(row).append(input);
  input.focus();
  input.select();
}

/* --------------------------- Guided build flow -------------------------- */

/** Derive a project name from a build request ("Create medical transcription software"). */
function projectNameFromGoal(goal) {
  const stripped = String(goal || '')
    .replace(/^\s*(?:please\s+|can you\s+|i want (?:you )?to\s+)?(?:create|build|make|develop|design|prototype|scaffold|architect|spin up|stand up|kick off|start building)\s+(?:a |an |the |me a )?/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const name = (stripped || 'New product').slice(0, 80).replace(/[.!?]+$/, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Append a concise assistant note to the active thread's transcript. */
function persistNote(intent, copy) {
  if (!getAuthenticationState().authenticated || !activeConversationId) return;
  api.appendConversationMessages(activeConversationId, [{ role: 'assistant', intent, title: 'Build', copy }])
    .then(() => refreshThreadRail())
    .catch(() => { /* a note that fails to persist should not break the flow */ });
}

/** Human-in-the-loop build flow appended to the chat: resolve/create project → hand to planner. */
async function startBuildFlow(route, stream, railBody) {
  const card = el('article', { class: 'conversation-message assistant build-flow' }, [
    el('div', { class: 'message-avatar' }, 'S'),
    el('div', { class: 'message-copy build-flow-body' }),
  ]);
  stream.append(card);
  const body = card.querySelector('.build-flow-body');
  let projects = [];
  try { projects = (await api.getProjects()).projects || []; } catch (_) { /* offline: still allow create */ }
  const selected = state.currentProjectId ? projects.find((project) => project.id === state.currentProjectId) : null;
  renderBuildProjectStep(body, { goal: route.input, selected, projects, railBody });
  card.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function buildStepHead(body, title, sub) {
  clear(body).append(el('strong', { class: 'message-title' }, title), sub ? el('p', {}, sub) : null);
}

function renderBuildProjectStep(body, ctx) {
  buildStepHead(body, 'Step 1 · Project', ctx.selected
    ? `Use the selected project “${ctx.selected.name}”, create a new one, or pick another.`
    : 'No project is selected. Create a new project or pick an existing one.');
  const actions = el('div', { class: 'build-flow-actions' });
  if (ctx.selected) {
    const useBtn = el('button', { class: 'primary', type: 'button' }, `Use “${ctx.selected.name}”`);
    useBtn.addEventListener('click', () => renderBuildPlannerStep(body, { ...ctx, project: ctx.selected }));
    actions.append(useBtn);
  }
  const createBtn = el('button', { class: ctx.selected ? '' : 'primary', type: 'button' }, 'Create new project');
  createBtn.addEventListener('click', () => renderBuildCreateStep(body, ctx));
  actions.append(createBtn);
  if (ctx.projects.length) {
    const picker = el('select', { 'aria-label': 'Existing project' }, [
      el('option', { value: '' }, 'Pick an existing project…'),
      ...ctx.projects.map((project) => el('option', { value: project.id }, project.name || project.id)),
    ]);
    picker.addEventListener('change', () => {
      const project = ctx.projects.find((candidate) => candidate.id === picker.value);
      if (project) { setCurrentProject(project.id); renderBuildPlannerStep(body, { ...ctx, project }); }
    });
    body.append(picker);
  }
  body.append(actions);
}

async function renderBuildCreateStep(body, ctx) {
  buildStepHead(body, 'Step 1 · Create project', 'Confirm the team and name. This creates a business-backed project the planner can pick up.');
  const nameInput = el('input', { type: 'text', maxlength: '120', value: projectNameFromGoal(ctx.goal), 'aria-label': 'Project name' });
  const teamSelect = el('select', { 'aria-label': 'Team' }, [el('option', { value: '' }, 'Loading teams…')]);
  const feedback = el('div', { class: 'task-create-feedback', role: 'status', 'aria-live': 'polite' });
  const create = el('button', { class: 'primary', type: 'button', disabled: true }, 'Create project');
  const back = el('button', { class: '', type: 'button' }, 'Back');
  back.addEventListener('click', () => renderBuildProjectStep(body, ctx));
  try {
    const teams = (await api.getTeams()).teams || [];
    if (!teams.length) {
      clear(teamSelect).append(el('option', { value: '' }, 'No teams — connect Linear in Settings'));
    } else {
      clear(teamSelect).append(...teams.map((team) => el('option', { value: team.id }, team.name || team.id)));
      create.disabled = false;
    }
  } catch (_) {
    clear(teamSelect).append(el('option', { value: '' }, 'Could not load teams'));
  }
  create.addEventListener('click', async () => {
    if (!teamSelect.value || !nameInput.value.trim()) return;
    create.disabled = true;
    create.textContent = 'Creating…';
    feedback.className = 'task-create-feedback';
    try {
      const name = nameInput.value.trim();
      const response = await api.createBusiness({ name, description: ctx.goal, createNewProject: true, teamId: teamSelect.value, projectName: name });
      const business = response.business || {};
      const project = business.project || { id: business.projectId, name };
      if (project.id) setCurrentProject(project.id);
      persistNote('build', `Created project “${name}”.`);
      renderBuildPlannerStep(body, { ...ctx, project: { id: project.id, name: project.name || name } });
    } catch (error) {
      create.disabled = false;
      create.textContent = 'Create project';
      feedback.classList.add('error');
      feedback.textContent = error.message;
    }
  });
  body.append(formField('Team', teamSelect), formField('Project name', nameInput), el('div', { class: 'build-flow-actions' }, [create, back]), feedback);
}

function renderBuildPlannerStep(body, ctx) {
  const project = ctx.project || {};
  const label = project.name || project.id;
  buildStepHead(body, 'Step 2 · Planner', `Project “${label}” is ready. Move it to the planner to break it into milestones and tasks?`);
  const feedback = el('div', { class: 'task-create-feedback', role: 'status', 'aria-live': 'polite' });
  const start = el('button', { class: 'primary', type: 'button' }, 'Start planning');
  const notYet = el('button', { class: '', type: 'button' }, 'Not yet');
  notYet.addEventListener('click', () => {
    buildStepHead(body, 'Project ready', `“${label}” is set up. Ask me anything else, or say “start planning” when you’re ready.`);
  });
  start.addEventListener('click', async () => {
    start.disabled = true;
    start.textContent = 'Queuing…';
    feedback.className = 'task-create-feedback';
    try {
      const { conversationId } = await api.enqueueProject({ projectId: project.id, projectName: project.name });
      persistNote('build', `Queued “${label}” for the planner.`);
      buildStepHead(body, 'Queued for planning', `“${label}” is queued. I’ll break it into milestones and tasks — follow progress below or in the Activity tab. You can keep chatting.`);
      // Stream the planner's intermittent responses live into the conversation.
      if (conversationId) {
        const streamLog = el('div', { class: 'agent-stream-log' });
        body.append(streamLog);
        api.openAgentStream(conversationId, (event) => {
          const prefix = event.level && event.level !== 'info' ? `[${event.level}] ` : '';
          streamLog.append(el('div', { class: `agent-stream-line ${event.level || 'info'}` }, `${prefix}${event.message || ''}`));
        }).catch(() => { /* stream is best-effort; the Activity tab remains the source of truth */ });
      }
    } catch (error) {
      start.disabled = false;
      start.textContent = 'Start planning';
      feedback.classList.add('error');
      feedback.textContent = error.status === 403 ? 'Assume a role in Settings before starting the planner.' : error.message;
      if (error.status === 403) feedback.append(el('a', { href: '#/settings', style: 'margin-left:6px' }, 'Open Settings'));
    }
  });
  body.append(el('div', { class: 'build-flow-actions' }, [start, notYet]), feedback);
}

function renderIntentRail(host, result) {
  const route = result.route || {
    intent: 'general',
    title: 'Workspace result',
    label: 'Response',
    answer: 'The workspace returned a result without routing details.',
  };
  host.dataset.agentIntent = route.intent;
  if (result.requiresAuthentication) {
    clear(host).append(
      railIntro('Sign in to continue', 'This request needs private workspace context or can start work, so it is unavailable in public mode.'),
      el('section', { class: 'route-policy-card', dataset: { panelSection: 'authentication' } }, [
        el('span', { class: 'route-policy-icon', 'aria-hidden': 'true' }, '◇'),
        el('strong', {}, 'Your private workspace stays protected'),
        el('p', {}, 'Sign in to use organization data, project history, diagnostics, or Agent actions.'),
      ]),
      el('a', { class: 'rail-action-link', href: '#/settings' }, 'Sign in to continue'),
    );
    return;
  }
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
  const sourceCounts = result.public
    ? [['Documents', payload.sources?.indexedFiles || 0]]
    : [
        ['Documents', payload.sources?.indexedFiles || 0],
        ['Business memory', payload.sources?.businesses?.length || 0],
        ['Projects', payload.sources?.projects?.length || 0],
        ['Activity', payload.sources?.jobs?.length || 0],
      ];
  clear(host).append(
    railIntro(
      result.public ? 'Reviewed documentation' : 'Workspace memory',
      result.public
        ? 'Searched the bounded public documentation index. No tenant memory or workspace records were queried.'
        : `Searched typed memory${payload.scope && payload.scope !== 'all' ? ` (${payload.scope} scope)` : ' across all scopes'} plus connected records. Results show their real source type.`
    ),
    !result.public && result.memoryDraft ? memoryDraftBlock(result.memoryDraft) : null,
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
    el('p', { class: 'rail-copy knowledge-honesty' }, result.public
      ? 'Public results come only from a bounded lexical index of reviewed README/docs files. Sign in to search private workspace memory.'
      : 'Document results come from a bounded lexical index of connected README/docs files; typed memory (user, business, project, task, workspace) is searched live. Semantic vector retrieval is not connected yet.')
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

  // On demand: no pipeline output yet → evaluate the requirement FIRST. A green
  // signal proceeds automatically to the full pipeline; amber/red holds at a gate
  // (rendered here) until a human refines/approves or the deadline auto-approves.
  if (!business || !business.stages) {
    if (result.evaluation) {
      renderEvaluationGate(host, result);
      return;
    }
    renderEvaluatePrompt(host, result);
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

/* ---------------------- Requirement evaluation gate --------------------- */

const READINESS_DIMS = [
  ['clarity', 'Clarity'], ['completeness', 'Completeness'],
  ['measurability', 'Measurability'], ['feasibility', 'Feasibility'],
];

function signalLabel(signal) {
  if (signal === 'green') return 'Ready to build';
  if (signal === 'red') return 'Not ready';
  return 'Needs refinement';
}

function toneForScore(score) {
  return score >= 75 ? 'green' : score >= 45 ? 'amber' : 'red';
}

// Initial call-to-action: score requirement readiness before any pipeline work.
function renderEvaluatePrompt(host, result) {
  const status = el('p', { class: 'business-scheduler-status' }, 'First checks the requirement is clear, complete, and measurable enough to build — deriving acceptance criteria and a readiness signal — before running the design and scheduling steps.');
  const evaluateBtn = el('button', { class: 'primary business-prepare-button', type: 'button' }, 'Check requirement');
  evaluateBtn.addEventListener('click', async () => {
    evaluateBtn.disabled = true;
    evaluateBtn.textContent = 'Evaluating…';
    status.classList.remove('error');
    status.textContent = 'Scoring requirement readiness…';
    try {
      const response = await api.evaluateBusiness({
        input: result.route?.input || '',
        businessId: result.businessId,
        conversationId: activeConversationId || undefined,
      });
      if (response.blocked) {
        status.classList.add('error');
        status.textContent = response.answer || 'This request cannot be supported.';
        evaluateBtn.remove();
        return;
      }
      if (response.signal === 'green') {
        status.textContent = 'Requirement is ready — preparing the plan…';
        await proceedToPipeline(host, result); // auto-advance on green
        return;
      }
      result.evaluation = response.evaluation;
      result.signal = response.signal;
      result.gate = response.gate;
      renderBusinessRail(host, result);
    } catch (error) {
      evaluateBtn.disabled = false;
      evaluateBtn.textContent = 'Try again';
      status.classList.add('error');
      status.textContent = error.message;
    }
  });
  clear(host).append(
    railIntro('Business decision workspace', result.route?.input || 'Pressure-test a business idea before scheduling any work.'),
    el('section', { class: 'business-prepare-card', dataset: { panelSection: 'evaluate' } }, [
      el('span', { class: 'scheduler-pulse', 'aria-hidden': 'true' }),
      el('strong', {}, 'Evaluate the requirement first'),
      status,
      evaluateBtn,
    ])
  );
}

// Run the full pipeline and swap the rail to the 6-stage view.
async function proceedToPipeline(host, result) {
  stopGatePoll();
  const response = await api.prepareBusiness({ input: result.route?.input || '', businessId: result.businessId });
  result.payload = response.business;
  result.evaluation = null;
  result.gate = null;
  renderBusinessRail(host, result);
}

// The amber/red signal card + acceptance criteria + gate-hold controls.
function renderEvaluationGate(host, result) {
  const evaluation = result.evaluation || {};
  const signal = result.signal || evaluation.signal || 'amber';
  const gate = result.gate || null;
  const readiness = evaluation.readiness || {};

  const nodes = [
    railIntro('Requirement readiness', result.route?.input || 'A readiness check before any design or scheduling.'),
    el('section', { class: `evaluation-signal-card tone-${signal}`, dataset: { panelSection: 'evaluation', tone: signal } }, [
      el('div', { class: 'fraud-gate-head' }, [el('span', {}, 'REQ'), el('strong', {}, signalLabel(signal)), el('b', {}, `${evaluation.score ?? 0}/100`)]),
      evaluation.summary ? el('p', {}, evaluation.summary) : null,
    ]),
    el('div', { class: 'rail-section-label' }, 'Readiness'),
    el('section', { class: 'troubleshooting-summary-grid', dataset: { panelSection: 'readiness' } },
      READINESS_DIMS.map(([key, label]) => summaryStat(readiness[key] ?? 0, label, toneForScore(readiness[key] ?? 0)))),
    el('div', { class: 'rail-section-label' }, 'Acceptance criteria'),
    el('ol', { class: 'evaluation-criteria', dataset: { panelSection: 'criteria' } }, (evaluation.criteria || []).map((c) =>
      el('li', { dataset: { must: c.mustHave ? 'yes' : 'no' } }, [
        c.mustHave ? el('span', { class: 'criterion-must' }, 'must') : null,
        el('span', {}, c.text),
      ])
    )),
    evaluation.gaps && evaluation.gaps.length
      ? el('div', { class: 'rail-inline-notice warning' }, [el('strong', {}, 'Gaps: '), evaluation.gaps.join(' · ')])
      : null,
    evaluation.warnings && evaluation.warnings.length
      ? el('div', { class: 'rail-inline-notice warning' }, evaluation.warnings.join(' · '))
      : null,
    gate ? renderGateHold(host, result, gate) : null,
  ];

  clear(host).append(...nodes.filter(Boolean));

  if (gate && gate.status === 'awaiting-approval') startGatePoll(host, result, gate);
  else stopGatePoll();
}

// Human-in-the-loop controls: refine + re-check, or approve & proceed now. A
// countdown shows when the gate will auto-approve if no one responds.
function renderGateHold(host, result, gate) {
  const countdown = el('p', { class: 'rail-inline-notice gate-countdown' }, gateCountdownText(gate));

  const refine = el('textarea', { class: 'evaluation-refine', rows: '3', placeholder: 'Refine the requirement to address the gaps, then re-check…' });
  const refineBtn = el('button', { type: 'button' }, 'Re-check requirement');
  refineBtn.addEventListener('click', async () => {
    const input = refine.value.trim();
    if (!input) { refine.focus(); return; }
    refineBtn.disabled = true;
    refineBtn.textContent = 'Re-checking…';
    try {
      const out = await api.reevaluateBusinessGate(gate.id, input);
      if (out.blocked) {
        toast(out.answer || 'This request cannot be supported.', 'error');
        refineBtn.disabled = false;
        refineBtn.textContent = 'Re-check requirement';
        return;
      }
      if (out.signal === 'green') { await proceedToPipeline(host, result); return; }
      result.evaluation = out.evaluation;
      result.signal = out.signal;
      result.gate = out.gate;
      renderBusinessRail(host, result);
    } catch (error) {
      refineBtn.disabled = false;
      refineBtn.textContent = 'Re-check requirement';
      toast(error.message, 'error');
    }
  });

  const approveBtn = el('button', { class: 'primary', type: 'button' }, 'Approve & proceed now');
  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    approveBtn.textContent = 'Proceeding…';
    // Stop watching this gate BEFORE the request so the SSE `proceeded` echo it
    // triggers cannot also fire handleGateEvent — we advance from the response.
    stopGatePoll();
    try {
      const response = await api.approveBusinessGate(gate.id);
      result.payload = response.business;
      result.evaluation = null;
      result.gate = null;
      renderBusinessRail(host, result);
    } catch (error) {
      approveBtn.disabled = false;
      approveBtn.textContent = 'Approve & proceed now';
      toast(error.message, 'error');
    }
  });

  return el('section', { class: 'evaluation-gate-hold', dataset: { panelSection: 'gate' } }, [
    el('div', { class: 'rail-section-label' }, 'Awaiting your decision'),
    countdown,
    refine,
    el('div', { class: 'build-flow-actions' }, [refineBtn, approveBtn]),
  ]);
}

function gateCountdownText(gate) {
  const deadline = gate && gate.deadline ? Date.parse(gate.deadline) : NaN;
  if (!Number.isFinite(deadline)) return 'Waiting for your decision.';
  const ms = deadline - Date.now();
  if (ms <= 0) return 'Auto-approving now…';
  return `Auto-approves in ${formatDuration(ms)} if no one responds.`;
}

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.max(1, Math.floor(ms / 1000))}s`;
}

// Track the on-screen gate and run a DISPLAY-ONLY countdown tick: it only
// rewrites the countdown label (no network). The terminal transition — proceeded
// when the server auto-approves at the deadline, or superseded from another tab —
// arrives on the workspace SSE stream and is handled by handleGateEvent. Durable
// state lives server-side; this only mirrors the remaining time.
function startGatePoll(host, result, gate) {
  stopGatePoll();
  activeGateId = gate.id;
  gateHost = host;
  gateResult = result;
  gateTimer = setInterval(() => {
    if (!agentRouteActive()) return stopGatePoll();
    const label = host.querySelector('.gate-countdown');
    if (label) label.textContent = gateCountdownText(result.gate || gate);
  }, GATE_COUNTDOWN_TICK_MS);
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
  const fallbackInput = result.route?.input || 'Review implementation change';
  const draft = payload.task || {
    title: fallbackInput.slice(0, 120),
    description: `${fallbackInput}\n\nAcceptance criteria:\n- Confirm the requested behavior.\n- Add focused automated coverage.`,
  };
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
      ['Model', safe.byomActiveModel || safe.ollamaModel || 'Not configured'],
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

/**
 * Inline EULA acceptance card, shown when a first-time user asks for "actual
 * work". Accepting proceeds automatically (re-runs the request); declining is
 * recorded and the user can keep asking questions. This is the acceptance
 * prompt only — the gateway enforces acceptance on every mutation server-side.
 */
function renderEulaGate({ version, onAccept, onReject }) {
  const note = el('p', { class: 'message-note' });
  const accept = el('button', { class: 'primary', type: 'button' }, 'Accept & continue');
  const decline = el('button', { type: 'button' }, 'Decline');
  const busy = (on) => { accept.disabled = on; decline.disabled = on; };

  const card = el('article', { class: 'conversation-message assistant eula-gate' }, [
    el('div', { class: 'message-avatar' }, 'S'),
    el('div', { class: 'message-copy' }, [
      el('strong', { class: 'message-title' }, 'Accept the End User License Agreement to continue'),
      el('p', {}, `Running actions — scheduling work, creating a task, or preparing a business — requires accepting the End User License Agreement${version ? ` (v${version})` : ''}. You can keep asking questions and searching the workspace without accepting.`),
      el('div', { class: 'message-links' }, [accept, decline]),
      note,
    ]),
  ]);

  accept.addEventListener('click', async () => {
    busy(true);
    accept.textContent = 'Recording…';
    note.classList.remove('error');
    note.textContent = '';
    try {
      await onAccept();
    } catch (error) {
      busy(false);
      accept.textContent = 'Accept & continue';
      note.classList.add('error');
      note.textContent = error.message || 'Could not record your acceptance. Try again.';
    }
  });
  decline.addEventListener('click', async () => {
    busy(true);
    try { await onReject(); } catch (_) { /* recorded best-effort */ }
    card.replaceWith(assistantMessage(
      'Noted — the EULA was not accepted.',
      'Your response has been recorded. You can still ask questions and search the workspace; accept the EULA anytime to run actions.'
    ));
    scrollConversationToEnd();
  });

  return card;
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
