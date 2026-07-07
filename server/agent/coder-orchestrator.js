'use strict';

const { CONFIG } = require('../config');
const store = require('../store');
const log = require('../logger');
const linear = require('../linear');
const { resolveLlm } = require('./llm');
const { runPlannedCoder } = require('./coder');
const { applyAidone } = require('./apply');

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
        project { id name }
        inverseRelations(first: 25) { nodes { type issue { id identifier state { type } } } }
      }
    }
  }`;

function isDoneState(state) {
  const t = state && state.type;
  return t === 'completed' || t === 'canceled';
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

/** Dispatch one planned task (fire-and-forget; releases its slot on completion). */
function dispatch(task, ctx) {
  running.set(task.id, { identifier: task.identifier, projectId: task.project.id, startedAt: Date.now() });
  const step = (m) => log.info(`[coder ${task.identifier}] ${m}`);
  Promise.resolve()
    .then(() => runPlannedCoder({ issue: task, project: task.project, llm: ctx.llm, apiKey: ctx.apiKey, keys: ctx.keys, githubToken: ctx.githubToken, onStep: step }))
    .then((r) => log.info(`[coder ${task.identifier}] done: ${String(r.finalText || '').slice(0, 160)}`))
    .catch((err) => log.error(`[coder ${task.identifier}] failed: ${err && err.message ? err.message : err}`))
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
  let llm;
  try {
    llm = await resolveLlm(settings);
  } catch (err) {
    log.warn(`Coder poll skipped: ${err && err.message ? err.message : err}`);
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

  const ctx = { llm, apiKey: settings.linearApiKey, keys: buildKeys(settings), githubToken: store.getGithubToken() };

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
    log.info(`Dispatching ${next.identifier} ("${project.name}", created ${next.createdAt}) via ${CONFIG.CODER.backend} backend.`);
    dispatch(next, ctx);
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

module.exports = { start, stop, status, pollOnce, fetchPlannedProjects, fetchPlannedTasks };
