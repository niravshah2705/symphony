'use strict';

const { CONFIG } = require('../config');
const store = require('../store');
const log = require('../logger');
const linear = require('../linear');
const { resolveLlm } = require('./llm');
const { runCoder } = require('./coder');

/**
 * Board monitor for the code-writer agent — a focused equivalent of Symphony's
 * Orchestrator. On a fixed cadence it polls the tracker for active-state tickets
 * and dispatches a code-writer run per ticket, up to a global concurrency cap.
 *
 * Single-writer model: all scheduling state lives in this module's `running`
 * map and is only mutated from the (serialized) poll tick + run callbacks, so a
 * ticket is never dispatched twice concurrently. State is in-memory only and
 * re-derived from the tracker on restart (no DB), matching Symphony's design.
 *
 * The full Symphony retry/backoff, per-state caps, stall detection, and SSH
 * fan-out are intentionally omitted from this reference monitor.
 */

// issueId -> { identifier, startedAt }
const running = new Map();
let timer = null;
let started = false;

// Active-state issues carrying the AI task label (Step 3). inverseRelations of
// type `blocks` are the issues that block THIS one (see apply.js: a dependency is
// created as from `blocks` to, so the `to` issue is blocked until `from` is Done).
const ACTIVE_ISSUES_QUERY = `
  query ActiveIssues($states: [String!], $labels: [String!], $first: Int!) {
    issues(first: $first, filter: {
      state: { name: { in: $states } },
      labels: { name: { in: $labels } }
    }) {
      nodes {
        id identifier title url
        state { name }
        labels { nodes { name } }
        inverseRelations(first: 25) {
          nodes { type issue { id identifier state { type name } } }
        }
      }
    }
  }`;

/** A blocker is satisfied once it is completed or canceled. */
function isDoneState(state) {
  const t = state && state.type;
  return t === 'completed' || t === 'canceled';
}

/** True when the issue is blocked by another issue that is not yet Done. */
function blockedBy(node) {
  const inv = (node.inverseRelations && node.inverseRelations.nodes) || [];
  return inv
    .filter((r) => r.type === 'blocks' && r.issue && !isDoneState(r.issue.state))
    .map((r) => r.issue.identifier || r.issue.id);
}

/** Fetch active-state, AI-labeled issues; annotate each with its unmet blockers. */
async function fetchActiveIssues(apiKey) {
  const data = await linear.linearRequest(apiKey, ACTIVE_ISSUES_QUERY, {
    states: CONFIG.CODER.activeStates,
    labels: [CONFIG.CODER.taskLabel],
    first: 50,
  });
  const nodes = (data && data.issues && data.issues.nodes) || [];
  return nodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    url: n.url,
    state: n.state && n.state.name,
    labels: ((n.labels && n.labels.nodes) || []).map((l) => l.name),
    blockers: blockedBy(n),
  }));
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

/** Dispatch a single ticket run (fire-and-forget; releases its slot on completion). */
function dispatch(issue, llm, apiKey, keys) {
  running.set(issue.id, { identifier: issue.identifier, startedAt: Date.now() });
  const step = (m) => log.info(`[coder ${issue.identifier}] ${m}`);
  Promise.resolve()
    .then(() => runCoder({ issue, llm, apiKey, keys, onStep: step }))
    .then((r) => log.info(`[coder ${issue.identifier}] done: ${String(r.finalText || '').slice(0, 160)}`))
    .catch((err) => log.error(`[coder ${issue.identifier}] failed: ${err && err.message ? err.message : err}`))
    .finally(() => running.delete(issue.id));
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
  let issues;
  try {
    issues = await fetchActiveIssues(settings.linearApiKey);
  } catch (err) {
    log.warn(`Coder poll: issue fetch failed: ${err && err.message ? err.message : err}`);
    return;
  }
  const keys = buildKeys(settings);
  for (const issue of issues) {
    if (running.size >= CONFIG.CODER.maxConcurrent) break; // global cap
    if (running.has(issue.id)) continue; // already claimed (single-writer)
    // Dependency avoidance: never start an issue still blocked by a non-Done issue.
    if (issue.blockers && issue.blockers.length) {
      log.info(`Skipping ${issue.identifier}: blocked by ${issue.blockers.join(', ')}.`);
      continue;
    }
    log.info(`Dispatching code-writer for ${issue.identifier} (${issue.state}) via ${CONFIG.CODER.backend} backend.`);
    dispatch(issue, llm, settings.linearApiKey, keys);
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
  log.info(`Code-writer board monitor started (every ${CONFIG.CODER.pollIntervalMs} ms, max ${CONFIG.CODER.maxConcurrent} concurrent).`);
  return { started: true };
}

function stop() {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
  log.info('Code-writer board monitor stopped.');
  return { started: false };
}

/** Snapshot for status endpoints. */
function status() {
  return {
    running: started,
    activeStates: CONFIG.CODER.activeStates,
    taskLabel: CONFIG.CODER.taskLabel,
    backend: CONFIG.CODER.backend,
    maxConcurrent: CONFIG.CODER.maxConcurrent,
    inFlight: [...running.values()].map((r) => ({ identifier: r.identifier, startedAt: r.startedAt })),
  };
}

module.exports = { start, stop, status, pollOnce, fetchActiveIssues };
