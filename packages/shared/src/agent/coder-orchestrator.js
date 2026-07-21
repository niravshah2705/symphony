'use strict';

const crypto = require('crypto');
const { CONFIG } = require('../config');
const store = require('../store');
const log = require('../logger');
const linear = require('../linear');
const { resolveLlm } = require('./llm');
const { runPlannedCoder, resolvePlannedRepository } = require('./coder');
const { applyAidone, startIssue, finishIssue } = require('./apply');
const {
  AgentAvailabilityError,
  isModelAvailabilityError,
  isRepositoryAvailabilityError,
  pauseReasonFor,
  probeModelAvailability,
  probeRepositoryAvailability,
  publicAvailabilityMessage,
} = require('./availability');

/**
 * Board monitor for the code-writer — the AIPLANNED flow.
 *
 * On a fixed cadence it finds projects labelled `aiplanned` (set by the planner)
 * and works their tasks (issues) in CREATION ORDER, honoring dependencies:
 *   - a task blocked by a not-yet-Done issue is skipped until the blocker lands,
 *   - independent tasks run concurrently — within AND across projects — each in
 *     its own isolated per-task workspace at
 *     ~/git/workspace/<project>/<task>/ on its own branch,
 *   - up to `maxConcurrentCoders` (UI-configurable, env `CODER_MAX_CONCURRENT`
 *     as the default) run in parallel across all projects,
 *   - when a project has no open tasks left, it is marked `aidone`.
 *
 * Single-writer model: `running` is only mutated from the serialized poll tick +
 * run callbacks, so a task is never dispatched twice. State is in-memory only.
 */

// issueId -> { identifier, projectId, startedAt }
const running = new Map();
let timer = null;
let started = false;
let pauseReason = null;
let pauseContext = null;

// Readiness checks are intentionally much cheaper than a failed agent run.
// Deduplicate only simultaneous checks: every later dispatch probes again so a
// credential revoked moments ago cannot slip through a stale success cache.
const RECOVERY_PROBE_MS = 60 * 1000;
const readinessCache = new Map();

const PLANNED_PROJECTS_QUERY = `
  query PlannedProjects($label: String!, $first: Int!) {
    projects(first: $first, filter: { labels: { name: { eq: $label } } }) {
      nodes { id name }
    }
  }`;

// Open (non-terminal) issues for aiplanned projects, with their blockers.
const PLANNED_TASKS_QUERY = `
  query PlannedTasks($label: String!, $first: Int!) {
    issues(first: $first, filter: {
      project: { labels: { name: { eq: $label } } },
      state: { type: { nin: ["completed", "canceled"] } }
    }) {
      nodes {
        id identifier title description url createdAt
        state { name type }
        labels(first: 20) { nodes { name } }
        project { id name }
        inverseRelations(first: 25) { nodes { type issue { id identifier state { type } } } }
      }
    }
  }`;

function isDoneState(state) {
  const t = state && state.type;
  return t === 'completed' || t === 'canceled';
}

/**
 * Which deep-agent role a task routes to, from its model-routing label:
 *   - a "local" label → 'local' (the local LLM slot),
 *   - a "hosted" label OR no model label → 'global' (the hosted slot; the default).
 * The planner stamps "local" on XS issues and "hosted" on everything larger.
 */
function modelRoleForTask(task) {
  const names = (task.labels || []).map((n) => String(n).toLowerCase());
  if (names.includes(String(CONFIG.CODER.localModelLabel).toLowerCase())) return 'local';
  return 'global';
}

/** Identifiers of not-yet-Done issues that block this task. */
function blockers(node) {
  const inv = (node.inverseRelations && node.inverseRelations.nodes) || [];
  return inv
    .filter((r) => r.type === 'blocks' && r.issue && !isDoneState(r.issue.state))
    .map((r) => r.issue.identifier || r.issue.id);
}

async function fetchPlannedProjects(apiKey) {
  const data = await linear.linearRequest(apiKey, PLANNED_PROJECTS_QUERY, { label: CONFIG.CODER.plannedLabel, first: CONFIG.PAGE_SIZE });
  return (data && data.projects && data.projects.nodes) || [];
}

/** Open tasks across aiplanned projects, grouped by project, each sorted by createdAt asc. */
async function fetchPlannedTasks(apiKey) {
  const data = await linear.linearRequest(apiKey, PLANNED_TASKS_QUERY, { label: CONFIG.CODER.plannedLabel, first: 250 });
  const nodes = (data && data.issues && data.issues.nodes) || [];
  const byProject = new Map();
  for (const n of nodes) {
    const pid = n.project && n.project.id;
    if (!pid) continue;
    const task = {
      id: n.id,
      identifier: n.identifier,
      title: n.title,
      description: n.description,
      url: n.url,
      createdAt: n.createdAt,
      state: n.state && n.state.name,
      labels: ((n.labels && n.labels.nodes) || []).map((l) => l.name),
      project: { id: pid, name: n.project.name },
      blockers: blockers(n),
    };
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid).push(task);
  }
  // Creation order within each project.
  for (const tasks of byProject.values()) {
    tasks.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  return byProject;
}

function buildKeys(settings) {
  return {
    linearApiKey: settings.linearApiKey,
    langsmithApiKey: settings.langsmithApiKey,
    langsmithTracing: settings.langsmithTracing,
    langsmithProject: settings.langsmithProject,
    langsmithEndpoint: settings.langsmithEndpoint,
    agentRuntime: settings.agentRuntime,
    workflowPattern: settings.workflowPattern,
  };
}

function readinessFingerprint() {
  const data = store.readStore();
  const settings = data.settings || {};
  const relevant = {
    repositoryProvider: settings.repositoryProvider,
    repositoryUrl: settings.repositoryUrl,
    githubToken: settings.githubToken,
    gitlabToken: settings.gitlabToken,
    llmProvider: settings.llmProvider,
    localLlmProvider: settings.localLlmProvider,
    ollamaHost: settings.ollamaHost,
    ollamaModel: settings.ollamaModel,
    lmstudioHost: settings.lmstudioHost,
    lmstudioModel: settings.lmstudioModel,
    omlxHost: settings.omlxHost,
    omlxModel: settings.omlxModel,
    omlxApiKey: settings.omlxApiKey,
    codexModel: settings.codexModel,
    codexTokens: settings.codexTokens,
    claudeModel: settings.claudeModel,
    claudeTokens: settings.claudeTokens,
    businesses: (data.businesses || []).map((business) => ({
      projectId: business.projectId,
      repo: business.repo,
      repoProvider: business.repoProvider,
    })),
  };
  // The digest is process-private and never returned by status(); credentials
  // are therefore useful for change detection without entering logs or the UI.
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

function repositorySelectionForTask(task) {
  const business = store.getBusinessByProjectId(task.project && task.project.id);
  const repository = store.getRepositoryConfig();
  return resolvePlannedRepository({
    business,
    globalRepository: repository,
    configuredRepoUrl: CONFIG.CODER.repoUrl,
    tokenForProvider: store.getRepositoryToken,
  });
}

function probeKey(resource, value) {
  return crypto.createHash('sha256').update(`${resource}:${JSON.stringify(value)}`).digest('hex');
}

async function cachedReadinessProbe(key, probe) {
  const cached = readinessCache.get(key);
  if (cached) return cached;
  const promise = Promise.resolve().then(probe);
  readinessCache.set(key, promise);
  try {
    return await promise;
  } finally {
    if (readinessCache.get(key) === promise) readinessCache.delete(key);
  }
}

/**
 * Resolve and verify every external dependency before dispatch creates a job or
 * moves the task to In Progress. The repository check intentionally runs first:
 * a 403 from GitHub/GitLab therefore has no task or job side effects.
 */
async function preflightTask(task, resolveRole, dependencies = {}) {
  const role = modelRoleForTask(task);
  const selectionForTask = dependencies.repositorySelectionForTask || repositorySelectionForTask;
  const repositoryProbe = dependencies.probeRepositoryAvailability || probeRepositoryAvailability;
  const modelProbe = dependencies.probeModelAvailability || probeModelAvailability;
  const runProbe = dependencies.cachedReadinessProbe || cachedReadinessProbe;
  let selection;
  try {
    selection = selectionForTask(task);
  } catch (error) {
    const provider = store.getRepositoryConfig().provider;
    throw new AgentAvailabilityError(
      'git',
      publicAvailabilityMessage('git', { provider }),
      Number(error && (error.status || error.statusCode)) || 400,
      (error && error.code) || 'git_not_configured',
    );
  }
  const gitKey = probeKey('git', {
    provider: selection.provider,
    repoRef: selection.repoRef,
    token: selection.token,
  });
  await runProbe(gitKey, () => repositoryProbe(selection));

  const llm = await resolveRole(role);
  const modelKey = probeKey('model', {
    provider: llm.provider,
    backend: llm.backend,
    host: llm.host,
    baseUrl: llm.baseUrl,
    model: llm.model,
    accessToken: llm.accessToken,
    accountId: llm.accountId,
  });
  await runProbe(modelKey, () => modelProbe(llm));
  return { role, selection, llm };
}

async function dispatchReadyTask(task, resolveRole, ctx, dependencies = {}) {
  const readiness = await preflightTask(task, resolveRole, dependencies);
  if (typeof dependencies.beforeDispatch === 'function') dependencies.beforeDispatch(readiness);
  const dispatchImpl = dependencies.dispatch || dispatch;
  const completion = dispatchImpl(task, {
    ...ctx,
    llm: readiness.llm,
    role: readiness.role,
    repositoryProvider: readiness.selection.provider,
    repositoryToken: readiness.selection.token,
    repositoryUrl: readiness.selection.repoRef,
  }, dependencies.dispatchDependencies);
  return { ...readiness, completion };
}

/**
 * Readiness guard for direct/manual coder requests. Unlike the board poll it
 * has no dispatch lifecycle to catch the error, so establish the same global
 * pause here and return only the sanitized pause reason to the route.
 */
async function preflightAndPause(task, resolveRole, dependencies = {}) {
  const role = modelRoleForTask(task || {});
  try {
    return await preflightTask(task || {}, resolveRole, dependencies);
  } catch (error) {
    const resource = isRepositoryAvailabilityError(error) || (error && error.resource === 'git') ? 'git' : 'model';
    const repository = store.getRepositoryConfig();
    const reason = pause(resource, error, {
      task: task || null,
      taskIdentifier: task && task.identifier,
      role,
      provider: resource === 'git' ? repository.provider : undefined,
    });
    if (error && (typeof error === 'object' || typeof error === 'function')) {
      error.pauseReason = reason;
      throw error;
    }
    const availabilityError = new AgentAvailabilityError(resource, reason.message);
    availabilityError.pauseReason = reason;
    throw availabilityError;
  }
}

function pause(resource, error, context = {}) {
  if (!pauseReason || pauseReason.resource !== resource) {
    pauseReason = pauseReasonFor(resource, error, context);
  }
  pauseContext = {
    resource,
    task: context.task || null,
    role: context.role || null,
    fingerprint: readinessFingerprint(),
    nextProbeAt: Date.now() + RECOVERY_PROBE_MS,
  };
  log.warn(`Code-writer paused: ${pauseReason.message}`);
  return pauseReason;
}

function clearPause(source = 'manual resume') {
  if (!pauseReason) return false;
  log.info(`Code-writer availability pause cleared (${source}).`);
  pauseReason = null;
  pauseContext = null;
  readinessCache.clear();
  return true;
}

/** Convert only a genuine runtime Git/model outage into monitor pause state. */
function pauseForRuntimeError(error, context = {}) {
  const repositoryUnavailable = isRepositoryAvailabilityError(error);
  const modelUnavailable = !repositoryUnavailable && isModelAvailabilityError(error);
  if (!repositoryUnavailable && !modelUnavailable) return null;
  const resource = repositoryUnavailable ? 'git' : 'model';
  return pause(resource, error, {
    task: context.task || null,
    taskIdentifier: context.taskIdentifier || (context.task && context.task.identifier),
    role: context.role,
    provider: resource === 'git'
      ? context.repositoryProvider
      : context.llm && context.llm.provider,
    model: resource === 'model' && context.llm ? context.llm.model : undefined,
  });
}

async function recoverPause(settings, dependencies = {}) {
  if (!pauseReason || !pauseContext) return true;
  const fingerprint = dependencies.readinessFingerprint || readinessFingerprint;
  const now = dependencies.now || Date.now;
  const resolve = dependencies.resolveLlm || resolveLlm;
  const modelProbe = dependencies.probeModelAvailability || probeModelAvailability;
  const selectionForTask = dependencies.repositorySelectionForTask || repositorySelectionForTask;
  const repositoryProbe = dependencies.probeRepositoryAvailability || probeRepositoryAvailability;
  const changed = fingerprint() !== pauseContext.fingerprint;
  if (!changed && now() < pauseContext.nextProbeAt) return false;

  try {
    if (pauseContext.resource === 'model') {
      const llm = await resolve(settings, pauseContext.role || 'global');
      await modelProbe(llm);
    } else {
      const selection = selectionForTask(pauseContext.task || {});
      await repositoryProbe(selection);
    }
    clearPause(changed ? 'settings changed and readiness passed' : 'periodic readiness probe passed');
    return true;
  } catch (_) {
    pauseContext.fingerprint = fingerprint();
    pauseContext.nextProbeAt = now() + RECOVERY_PROBE_MS;
    return false;
  }
}

/** Persist a coding-run job (kind 'coding') so it shows in the UI job list. */
function createCodingJob(task, jobStore = store) {
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    kind: 'coding',
    projectId: task.project.id,
    projectName: task.project.name,
    taskIdentifier: task.identifier,
    taskTitle: task.title,
    taskUrl: task.url,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    error: null,
    summary: null,
    steps: [],
  };
  jobStore.addJob(job);
  return job;
}

/**
 * Parse the agent's end-of-run verdict. The workflow prompt requires a
 * ```verdict { "status": "completed"|"insufficient", "reason": "..." }``` block;
 * a plain `VERDICT: <status> — <reason>` line is also accepted. Defaults to
 * 'insufficient' so an unclear run is never silently marked done+aidone, and so
 * the task always leaves the queue (Done) instead of being re-picked forever.
 */
function parseVerdict(finalText) {
  const text = String(finalText || '');
  const json = text.match(/\{[^{}]*"status"\s*:\s*"(completed|insufficient)"[^{}]*\}/i);
  if (json) {
    try {
      const obj = JSON.parse(json[0]);
      const status = String(obj.status || '').toLowerCase() === 'completed' ? 'completed' : 'insufficient';
      return { status, reason: String(obj.reason || '').trim(), pr: String(obj.pr || '').trim() || null };
    } catch (_) {
      /* fall through to the line form */
    }
  }
  const line = text.match(/VERDICT\s*[:=]\s*(completed|insufficient)\b[\s\-–—:]*(.*)/i);
  if (line) {
    const status = line[1].toLowerCase() === 'completed' ? 'completed' : 'insufficient';
    return { status, reason: (line[2] || '').trim(), pr: null };
  }
  return { status: 'insufficient', reason: 'The agent did not emit a clear completion verdict.', pr: null };
}

/** Dispatch one planned task (fire-and-forget; releases its slot on completion). */
function dispatch(task, ctx, dependencies = {}) {
  const jobStore = dependencies.store || store;
  const startIssueImpl = dependencies.startIssue || startIssue;
  const finishIssueImpl = dependencies.finishIssue || finishIssue;
  const runPlannedCoderImpl = dependencies.runPlannedCoder || runPlannedCoder;
  running.set(task.id, { identifier: task.identifier, projectId: task.project.id, startedAt: Date.now() });

  // Track this coding run as a job (same store as enrichment jobs) so it is
  // visible in the UI with a live step trace, not just in the server log.
  const job = createCodingJob(task, jobStore);
  let phase = 'linear-start';
  const step = (message, level = 'info') => {
    (log[level] || log.info)(`[coder ${task.identifier}] ${message}`);
    jobStore.appendJobStep(job.id, { ts: new Date().toISOString(), level, message });
  };

  return Promise.resolve()
    // 1. Take ownership of the task's state: move it to "In Progress".
    .then(() => startIssueImpl(ctx.apiKey, { issueId: task.id, onStep: step }))
    // 2. Run the coder and derive a verdict. An ordinary coder-run FAILURE
    //    (recursion limit, workflow crash) is an 'insufficient' outcome rather
    //    than an endless retry. Model/repository availability failures are the
    //    exception: they reach the outer handler, pause dispatch, and keep the
    //    issue retryable. Linear start/finalize errors also reach the outer
    //    handler but do not masquerade as model failures.
    .then((state) => {
      phase = 'agent';
      const issue = { ...task, state: (state && state.name) || task.state };
      return runPlannedCoderImpl({
        issue,
        project: task.project,
        llm: ctx.llm,
        apiKey: ctx.apiKey,
        keys: ctx.keys,
        repositoryProvider: ctx.repositoryProvider,
        repositoryToken: ctx.repositoryToken,
        repositoryUrl: ctx.repositoryUrl,
        onStep: step,
      })
        .then((r) => ({ r, verdict: parseVerdict(r && r.finalText) }))
        .catch((err) => {
          // Availability failures are not task outcomes. Bubble them to the
          // outer handler so the monitor pauses and leaves the Linear issue in
          // progress for an operator-controlled retry.
          if (isRepositoryAvailabilityError(err) || isModelAvailabilityError(err)) throw err;
          const message = err && err.message ? err.message : String(err);
          step(`Coder run did not complete: ${message}`, 'error');
          return { r: null, verdict: { status: 'insufficient', reason: `Coder run did not complete: ${message}` } };
        });
    })
    // 3. Finalize: Done + aidone (completed) | aifail (insufficient). This always
    //    moves the task out of the active queue so it is not re-picked.
    .then(async ({ r, verdict }) => {
      phase = 'linear-finish';
      step(`Verdict: ${verdict.status}${verdict.pr ? ` (PR ${verdict.pr})` : ''}${verdict.reason ? ` — ${verdict.reason}` : ''}`);
      await finishIssueImpl(ctx.apiKey, { issueId: task.id, outcome: verdict.status, reason: verdict.reason, onStep: step });
      jobStore.updateJob(job.id, {
        status: 'done',
        finishedAt: new Date().toISOString(),
        error: null,
        summary: {
          coding: true,
          outcome: verdict.status,
          reason: verdict.reason || null,
          pr: verdict.pr || null,
          branch: (r && r.branch) || null,
          finalText: String((r && r.finalText) || '').slice(0, 2000),
        },
      });
    })
    .catch((err) => {
      const reason = phase === 'agent'
        ? pauseForRuntimeError(err, {
          task,
          role: ctx.role,
          repositoryProvider: ctx.repositoryProvider,
          llm: ctx.llm,
        })
        : null;
      if (reason) {
        step(`Agent jobs paused: ${reason.message}`, 'warn');
        jobStore.updateJob(job.id, {
          // Keep the persisted job lifecycle on its established four states;
          // the monitor-level pause is exposed separately by status().
          status: 'error',
          finishedAt: new Date().toISOString(),
          error: reason.message,
          summary: { coding: true, paused: true, pauseReason: reason },
        });
        return;
      }
      // Linear-side failure (couldn't start or finalize the issue) — leave it for
      // the next poll to retry rather than losing the task.
      const message = err && err.message ? err.message : String(err);
      step(`Failed: ${message}`, 'error');
      jobStore.updateJob(job.id, { status: 'error', finishedAt: new Date().toISOString(), error: message });
    })
    .finally(() => running.delete(task.id));
}

/** True when this project still has any task in flight (guards the aidone stamp). */
function projectBusy(projectId) {
  for (const r of running.values()) if (r.projectId === projectId) return true;
  return false;
}

/**
 * Effective concurrent-coder cap. Prefers the UI-editable agent-config value
 * (`maxConcurrentCoders`), falling back to the `CODER_MAX_CONCURRENT` env default.
 */
function resolveMaxConcurrent() {
  try {
    const cfg = store.getAgentConfig();
    const n = Number(cfg && cfg.maxConcurrentCoders);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  } catch (_) {
    /* fall through to the env-backed default */
  }
  return CONFIG.CODER.maxConcurrent;
}

/** One poll+dispatch cycle. Serialized (never overlaps itself). */
async function pollOnce() {
  const settings = store.getSettings();
  if (!settings.linearApiKey) {
    log.warn('Coder poll skipped: add a Linear API key in Settings.');
    return { skipped: 'missing-linear-key' };
  }
  if (pauseReason && !(await recoverPause(settings))) {
    return { skipped: 'paused', pauseReason };
  }
  let projects;
  let tasksByProject;
  try {
    projects = await fetchPlannedProjects(settings.linearApiKey);
    tasksByProject = await fetchPlannedTasks(settings.linearApiKey);
  } catch (err) {
    log.warn(`Coder poll: fetch failed: ${err && err.message ? err.message : err}`);
    return { skipped: 'planning-provider-unavailable' };
  }

  const repository = store.getRepositoryConfig();
  const ctx = {
    apiKey: settings.linearApiKey,
    keys: buildKeys(settings),
    repositoryProvider: repository.provider,
    repositoryToken: repository.token,
    repositoryUrl: repository.url,
  };
  // Resolve each role's provider at most once per tick, on demand — a task routes
  // to 'local' or 'global' by its model label. Resolution can throw (e.g. an
  // OAuth provider not signed in); we cache the promise and skip only the tasks
  // that need an unavailable role rather than failing the whole poll.
  const roleLlm = new Map();
  const resolveRole = (role) => {
    if (!roleLlm.has(role)) roleLlm.set(role, resolveLlm(settings, role));
    return roleLlm.get(role);
  };

  const cap = resolveMaxConcurrent();
  for (const project of projects) {
    const tasks = tasksByProject.get(project.id) || [];
    // No open tasks left → the project is fully coded; mark it aidone (once),
    // but only when nothing for it is still in flight.
    if (!tasks.length) {
      if (!projectBusy(project.id)) {
        applyAidone(settings.linearApiKey, { project, onStep: (m) => log.info(`[coder ${project.name}] ${m}`) })
          .then(() => log.info(`Project "${project.name}" fully coded → aidone.`))
          .catch((err) => log.warn(`aidone for "${project.name}" failed: ${err && err.message ? err.message : err}`));
      }
      continue;
    }
    if (running.size >= cap) break; // global cap

    // Dispatch every unblocked, not-already-running task in creation order, up to
    // the global cap. Independent tasks of the same project now run concurrently,
    // each in its own isolated per-task workspace; a task blocked by a not-yet-Done
    // issue stays skipped until its blocker lands.
    let dispatchedForProject = 0;
    for (const next of tasks) {
      if (running.size >= cap) break;
      if (running.has(next.id) || (next.blockers && next.blockers.length)) continue;
      const role = modelRoleForTask(next);
      try {
        await dispatchReadyTask(next, resolveRole, ctx, {
          beforeDispatch: ({ llm }) => {
            log.info(`Dispatching ${next.identifier} ("${project.name}", created ${next.createdAt}, ${role} agent → ${llm.provider}) via ${CONFIG.CODER.backend} backend.`);
          },
        });
        dispatchedForProject += 1;
      } catch (err) {
        const resource = isRepositoryAvailabilityError(err) || (err && err.resource === 'git') ? 'git' : 'model';
        const reason = pause(resource, err, {
          task: next,
          taskIdentifier: next.identifier,
          role,
          provider: resource === 'git' ? store.getRepositoryConfig().provider : undefined,
        });
        return { skipped: 'paused', pauseReason: reason };
      }
    }
    // Nothing dispatched despite free capacity → the remaining tasks are blocked.
    if (!dispatchedForProject && running.size < cap) {
      const head = tasks.find((t) => t.blockers && t.blockers.length && !running.has(t.id));
      if (head) log.info(`Project "${project.name}": next task ${head.identifier} blocked by ${head.blockers.join(', ')}.`);
    }
    if (running.size >= cap) break; // cap reached; stop scanning further projects
  }
  return { dispatched: true };
}

/** Start the board monitor (idempotent). Serializes ticks so they never overlap. */
function start() {
  const resumed = clearPause('monitor start requested');
  if (started) return { started: true, already: true, resumed };
  started = true;
  const tick = () => {
    pollOnce().finally(() => {
      if (started) timer = setTimeout(tick, CONFIG.CODER.pollIntervalMs);
    });
  };
  tick();
  log.info(`Code-writer monitor started (aiplanned flow, every ${CONFIG.CODER.pollIntervalMs} ms, max ${resolveMaxConcurrent()} concurrent).`);
  return { started: true, resumed };
}

function resume() {
  const resumed = clearPause('manual resume');
  if (!started) start();
  return { ...status(), resumed };
}

function stop() {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
  log.info('Code-writer monitor stopped.');
  return { started: false };
}

/** Snapshot for status endpoints. */
function status() {
  return {
    running: started,
    paused: Boolean(pauseReason),
    pauseReason,
    plannedLabel: CONFIG.CODER.plannedLabel,
    backend: CONFIG.CODER.backend,
    maxConcurrent: resolveMaxConcurrent(),
    inFlight: [...running.values()].map((r) => ({ identifier: r.identifier, startedAt: r.startedAt })),
  };
}

module.exports = {
  start,
  stop,
  resume,
  status,
  pollOnce,
  fetchPlannedProjects,
  fetchPlannedTasks,
  parseVerdict,
  modelRoleForTask,
  repositorySelectionForTask,
  preflightTask,
  preflightAndPause,
  pauseForRuntimeError,
  dispatchReadyTask,
  dispatch,
  _test: {
    clearPause,
    pause,
    recoverPause,
    readinessFingerprint,
    resolveMaxConcurrent,
  },
};
