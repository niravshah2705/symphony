'use strict';

const crypto = require('crypto');
const { CONFIG } = require('../config');
const store = require('../store');
const log = require('../logger');
const linear = require('../linear');
const { resolveLlm } = require('./llm');
const { runPlannedCoder } = require('./coder');
const { applyAidone, startIssue, finishIssue } = require('./apply');

/**
 * Board monitor for the code-writer — the AIPLANNED flow.
 *
 * On a fixed cadence it finds projects labelled `aiplanned` (set by the planner)
 * and works their tasks (issues) in CREATION ORDER, honoring dependencies:
 *   - a task blocked by a not-yet-Done issue is skipped until the blocker lands,
 *   - at most ONE task per project runs at a time (they share the project's
 *     monorepo workspace at ~/git/workspace/<project>/, each on its own branch),
 *   - across different projects, up to `maxConcurrent` run in parallel,
 *   - when a project has no open tasks left, it is marked `aidone`.
 *
 * Single-writer model: `running` is only mutated from the serialized poll tick +
 * run callbacks, so a task is never dispatched twice. State is in-memory only.
 */

// issueId -> { identifier, projectId, startedAt }
const running = new Map();
let timer = null;
let started = false;

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
  };
}

/** Persist a coding-run job (kind 'coding') so it shows in the UI job list. */
function createCodingJob(task) {
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
  store.addJob(job);
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
function dispatch(task, ctx) {
  running.set(task.id, { identifier: task.identifier, projectId: task.project.id, startedAt: Date.now() });

  // Track this coding run as a job (same store as enrichment jobs) so it is
  // visible in the UI with a live step trace, not just in the server log.
  const job = createCodingJob(task);
  const step = (message, level = 'info') => {
    (log[level] || log.info)(`[coder ${task.identifier}] ${message}`);
    store.appendJobStep(job.id, { ts: new Date().toISOString(), level, message });
  };

  Promise.resolve()
    // 1. Take ownership of the task's state: move it to "In Progress".
    .then(() => startIssue(ctx.apiKey, { issueId: task.id, onStep: step }))
    // 2. Run the coder and derive a verdict. A coder-run FAILURE (recursion
    //    limit, crash) is treated as an 'insufficient' outcome rather than
    //    re-thrown: otherwise the issue would stay In Progress and be
    //    re-dispatched (a full agent run) every poll, forever. Only
    //    startIssue/finishIssue (Linear) errors reach the outer catch → retry.
    .then((state) => {
      const issue = { ...task, state: (state && state.name) || task.state };
      return runPlannedCoder({
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
          const message = err && err.message ? err.message : String(err);
          step(`Coder run did not complete: ${message}`, 'error');
          return { r: null, verdict: { status: 'insufficient', reason: `Coder run did not complete: ${message}` } };
        });
    })
    // 3. Finalize: Done + aidone (completed) | aifail (insufficient). This always
    //    moves the task out of the active queue so it is not re-picked.
    .then(async ({ r, verdict }) => {
      step(`Verdict: ${verdict.status}${verdict.pr ? ` (PR ${verdict.pr})` : ''}${verdict.reason ? ` — ${verdict.reason}` : ''}`);
      await finishIssue(ctx.apiKey, { issueId: task.id, outcome: verdict.status, reason: verdict.reason, onStep: step });
      store.updateJob(job.id, {
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
      // Linear-side failure (couldn't start or finalize the issue) — leave it for
      // the next poll to retry rather than losing the task.
      const message = err && err.message ? err.message : String(err);
      step(`Failed: ${message}`, 'error');
      store.updateJob(job.id, { status: 'error', finishedAt: new Date().toISOString(), error: message });
    })
    .finally(() => running.delete(task.id));
}

/** True when this project already has a task in flight (monorepo workspace is shared). */
function projectBusy(projectId) {
  for (const r of running.values()) if (r.projectId === projectId) return true;
  return false;
}

/** One poll+dispatch cycle. Serialized (never overlaps itself). */
async function pollOnce() {
  const settings = store.getSettings();
  if (!settings.linearApiKey) {
    log.warn('Coder poll skipped: add a Linear API key in Settings.');
    return;
  }
  let projects;
  let tasksByProject;
  try {
    projects = await fetchPlannedProjects(settings.linearApiKey);
    tasksByProject = await fetchPlannedTasks(settings.linearApiKey);
  } catch (err) {
    log.warn(`Coder poll: fetch failed: ${err && err.message ? err.message : err}`);
    return;
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

  for (const project of projects) {
    const tasks = tasksByProject.get(project.id) || [];
    // No open tasks left → the project is fully coded; mark it aidone (once).
    if (!tasks.length) {
      if (!projectBusy(project.id)) {
        applyAidone(settings.linearApiKey, { project, onStep: (m) => log.info(`[coder ${project.name}] ${m}`) })
          .then(() => log.info(`Project "${project.name}" fully coded → aidone.`))
          .catch((err) => log.warn(`aidone for "${project.name}" failed: ${err && err.message ? err.message : err}`));
      }
      continue;
    }
    if (running.size >= CONFIG.CODER.maxConcurrent) break; // global cap
    if (projectBusy(project.id)) continue; // one task per project (shared monorepo workspace)

    // Next unblocked, not-already-running task in creation order.
    const next = tasks.find((t) => !running.has(t.id) && (!t.blockers || t.blockers.length === 0));
    if (!next) {
      const head = tasks.find((t) => t.blockers && t.blockers.length);
      if (head) log.info(`Project "${project.name}": next task ${head.identifier} blocked by ${head.blockers.join(', ')}.`);
      continue;
    }
    // Route to the local or hosted deep-agent slot by the task's model label.
    const role = modelRoleForTask(next);
    let llm;
    try {
      llm = await resolveRole(role);
    } catch (err) {
      log.warn(`Coder poll: ${role} LLM not ready for ${next.identifier}: ${err && err.message ? err.message : err}; skipping.`);
      continue;
    }
    log.info(`Dispatching ${next.identifier} ("${project.name}", created ${next.createdAt}, ${role} agent → ${llm.provider}) via ${CONFIG.CODER.backend} backend.`);
    dispatch(next, { ...ctx, llm });
  }
}

/** Start the board monitor (idempotent). Serializes ticks so they never overlap. */
function start() {
  if (started) return { started: true, already: true };
  started = true;
  const tick = () => {
    pollOnce().finally(() => {
      if (started) timer = setTimeout(tick, CONFIG.CODER.pollIntervalMs);
    });
  };
  tick();
  log.info(`Code-writer monitor started (aiplanned flow, every ${CONFIG.CODER.pollIntervalMs} ms, max ${CONFIG.CODER.maxConcurrent} concurrent).`);
  return { started: true };
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
    plannedLabel: CONFIG.CODER.plannedLabel,
    backend: CONFIG.CODER.backend,
    maxConcurrent: CONFIG.CODER.maxConcurrent,
    inFlight: [...running.values()].map((r) => ({ identifier: r.identifier, startedAt: r.startedAt })),
  };
}

module.exports = { start, stop, status, pollOnce, fetchPlannedProjects, fetchPlannedTasks, parseVerdict, modelRoleForTask };
