'use strict';

const crypto = require('crypto');
const store = require('../store');
const linear = require('../linear');
const log = require('../logger');
const { generatePlan, generateIssuesForMilestones } = require('./plan');
const { applyPlan, applyIssuesForMilestones, applyAiplanned, applyAifail } = require('./apply');
const { llmReady, notReadyReason, resolveLlm } = require('./llm');

const { CONFIG } = require('../config');

/**
 * Enrichment job queue + scheduler.
 *
 * Jobs are processed on a configurable cadence (5/10/15 min, "to avoid fast
 * processing"), with configurable per-tick parallelism and a hard cap on
 * projects per tick. Ticks never overlap. The Linear/LLM/LangSmith keys are
 * read fresh from the store on every tick (no long-lived credential cache).
 */

const DEFAULT_INTERVAL_MINUTES = 5;

/** Resolve the configured cadence, falling back to an allowed default. */
function intervalMs(config) {
  const minutes = CONFIG.INTERVAL_OPTIONS.includes(Number(config.intervalMinutes))
    ? Number(config.intervalMinutes)
    : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60 * 1000;
}

const runtime = {
  timer: null,
  isTicking: false,
  lastRunAt: null,
  nextRunAt: null,
  lastError: null,
};

/** Queue a project for enrichment, skipping duplicates already in flight. */
function enqueue({ projectId, projectName, assumedRole }) {
  const active = store.listJobs().some(
    (j) => j.projectId === projectId && (j.status === 'pending' || j.status === 'running')
  );
  if (active) return null;

  const job = {
    id: crypto.randomUUID(),
    projectId,
    projectName: projectName || projectId,
    status: 'pending',
    assumedRole: assumedRole ? { id: assumedRole.id, name: assumedRole.name } : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
    traceUrl: null,
    traced: false,
    summary: null,
    steps: [],
  };
  store.addJob(job);
  return job;
}

/** Run one enrichment job end-to-end, recording a step trace on the job. */
async function runJob(job, { apiKey, keys, llm, config }) {
  // Records a step both to the persistent log file and onto the job (for the UI).
  const step = (message, level = 'info') => {
    log[level] ? log[level](`[job ${job.id.slice(0, 8)} · ${job.projectName}] ${message}`) : log.info(message);
    store.appendJobStep(job.id, { ts: new Date().toISOString(), level, message });
  };

  const finish = (patch) =>
    store.updateJob(job.id, { status: 'done', finishedAt: new Date().toISOString(), error: null, ...patch });

  store.updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() });
  step('Enrichment started.');
  try {
    // Inspect existing milestones to decide: NEW plan vs RESUME (create issues).
    const { project, milestones } = await linear.getMilestonesWithIssueCounts(apiKey, job.projectId);

    if (milestones.length > 0) {
      // ---- RESUME: milestones already exist; ensure each has issues, then aidone.
      const missing = milestones.filter((m) => m.issueCount === 0);
      step(`Found ${milestones.length} existing milestone(s); ${missing.length} without issues.`);
      let summary = { milestonesCreated: 0, issuesCreated: 0, dependenciesCreated: 0, warnings: [], resumed: true };
      if (missing.length && config.createIssues) {
        const gen = await generateIssuesForMilestones({ project, milestones: missing, config, llm, keys, onStep: step });
        summary = await applyIssuesForMilestones(apiKey, { project, milestones: missing, generated: gen.milestones, config, onStep: step });
        await applyAiplanned(apiKey, { project, onStep: step });
        step(`Resumed: created ${summary.issuesCreated} task(s); marked aiplanned.`);
        finish({ traceUrl: gen.traceUrl, traced: gen.traced, summary });
      } else {
        await applyAiplanned(apiKey, { project, onStep: step });
        step('All milestones already have issues; marked aiplanned.');
        finish({ summary });
      }
      return;
    }

    // ---- NEW: no milestones yet — viability + full business plan.
    const result = await generatePlan({ project, assumedRole: job.assumedRole, config, llm, keys, onStep: step });

    if (!result.viable) {
      const summary = await applyAifail(apiKey, { project, reason: result.reason, onStep: step });
      step(`Marked aifail: ${result.reason.slice(0, 160)}`, 'warn');
      finish({ traceUrl: result.traceUrl, traced: result.traced, summary });
      return;
    }

    const summary = await applyPlan(apiKey, { project, plan: result.plan, assumedRole: job.assumedRole, config, onStep: step });
    // Mark aiplanned once issues exist (or when issue creation is disabled) — the
    // project is now planned and ready for the coding flow to work its tasks.
    if (summary.issuesCreated > 0 || !config.createIssues) {
      await applyAiplanned(apiKey, { project, onStep: step });
    }
    step(`Done: ${summary.milestonesCreated} milestones, ${summary.issuesCreated} issues, ${summary.dependenciesCreated} deps${summary.warnings.length ? `, ${summary.warnings.length} warning(s)` : ''}.`);
    finish({ traceUrl: result.traceUrl, traced: result.traced, summary });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    step(`Failed: ${message}`, 'error');
    store.updateJob(job.id, {
      status: 'error',
      finishedAt: new Date().toISOString(),
      error: message,
    });
  }
}

/**
 * Auto-discover projects that still carry an enrich label (e.g. `AI`) and enqueue
 * any without an in-flight job. Completed projects become `aidone` and unfit ones
 * `aifail` (both replace the enrich label), so they drop out naturally; projects
 * with milestones-but-no-issues stay labelled and are picked up for RESUME.
 * @returns {Promise<number>} count of newly queued projects
 */
async function discover({ apiKey, assumedRole, config }) {
  const candidates = await linear.getProjectsWithLabels(apiKey, config.enrichLabels);
  const inFlight = new Set(
    store
      .listJobs()
      .filter((j) => j.status === 'pending' || j.status === 'running')
      .map((j) => j.projectId)
  );
  let queued = 0;
  for (const project of candidates) {
    if (inFlight.has(project.id)) continue;
    const job = enqueue({ projectId: project.id, projectName: project.name, assumedRole });
    if (job) {
      queued += 1;
      log.info(`Queued "${project.name}" for enrichment.`);
    }
  }
  return queued;
}

/** Process one tick: auto-discover by label, then enrich. Never overlaps. */
async function processPending() {
  if (runtime.isTicking) return { skipped: 'already-running' };
  runtime.isTicking = true;
  runtime.lastRunAt = new Date().toISOString();
  log.info('Scheduler tick started.');
  try {
    const apiKey = store.getApiKey();
    const settings = store.getSettings();
    const config = store.getAgentConfig();
    const assumedRole = store.getAssumedRole();

    if (!apiKey) {
      runtime.lastError = 'Add your Linear API key in Settings.';
      log.warn(`Tick skipped: ${runtime.lastError}`);
      return { skipped: 'missing-keys', reason: runtime.lastError };
    }
    if (!llmReady(settings)) {
      runtime.lastError = notReadyReason(settings);
      log.warn(`Tick skipped: ${runtime.lastError}`);
      return { skipped: 'missing-keys', reason: runtime.lastError };
    }
    if (!assumedRole) {
      runtime.lastError = 'Assume a role in Settings to enable automatic enrichment.';
      log.warn(`Tick skipped: ${runtime.lastError}`);
      return { skipped: 'no-role', reason: runtime.lastError };
    }
    runtime.lastError = null;

    // Resolve the active provider (refreshes the Codex OAuth token if needed).
    let llm;
    try {
      llm = await resolveLlm(settings);
    } catch (err) {
      runtime.lastError = err && err.message ? err.message : 'LLM provider unavailable.';
      log.warn(`Tick skipped: ${runtime.lastError}`);
      return { skipped: 'missing-keys', reason: runtime.lastError };
    }
    const keys = {
      langsmithApiKey: settings.langsmithApiKey,
      langsmithProject: settings.langsmithProject,
      langsmithEndpoint: settings.langsmithEndpoint,
      langsmithTracing: settings.langsmithTracing,
    };

    // 1. Discover projects to enrich automatically (by label).
    let discovered = 0;
    try {
      discovered = await discover({ apiKey, assumedRole, config });
    } catch (err) {
      runtime.lastError = `Discovery failed: ${err && err.message ? err.message : err}`;
    }

    // 2. Process the pending queue, bounded by config.
    const pending = store.listJobs().filter((j) => j.status === 'pending');
    const batch = pending.slice(0, Math.max(1, config.maxProjectsPerRun));
    const concurrency = Math.max(1, Math.min(config.parallelProcessing || 1, batch.length || 1));

    log.info(`Tick: discovered ${discovered}, processing ${batch.length} (parallel ${concurrency}).`);
    await runWithConcurrency(batch, concurrency, (job) => runJob(job, { apiKey, keys, llm, config }));
    store.pruneJobs();
    log.info(`Tick finished (processed ${batch.length}).`);
    return { discovered, processed: batch.length };
  } catch (err) {
    runtime.lastError = err && err.message ? err.message : String(err);
    log.error(`Tick error: ${runtime.lastError}`);
    return { error: runtime.lastError };
  } finally {
    runtime.isTicking = false;
  }
}

/** Simple bounded-concurrency pool. */
async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Self-scheduling loop: reads the cadence from config each cycle so interval
 * changes (5/10/15) take effect on the next tick. Never runs immediately —
 * the cadence intentionally throttles processing.
 */
function scheduleNext() {
  const ms = intervalMs(store.getAgentConfig());
  runtime.nextRunAt = new Date(Date.now() + ms).toISOString();
  runtime.timer = setTimeout(async () => {
    const config = store.getAgentConfig();
    if (config.scheduleEnabled) {
      await processPending().catch(() => {});
    }
    scheduleNext();
  }, ms);
}

const RESTART_KICKOFF_MS = 4000;

function startScheduler() {
  if (runtime.timer) return;
  const interrupted = store.reconcileRunningJobs();
  if (interrupted) log.warn(`Marked ${interrupted} interrupted job(s) as error after restart.`);
  const minutes = intervalMs(store.getAgentConfig()) / 60000;
  log.info(`Scheduler started (every ${minutes} min).`);
  scheduleNext();
  // On restart, promptly review existing milestones and resume issue creation.
  setTimeout(() => {
    if (store.getAgentConfig().scheduleEnabled) {
      log.info('Restart resume pass…');
      processPending().catch(() => {});
    }
  }, RESTART_KICKOFF_MS);
}

function getStatus() {
  const config = store.getAgentConfig();
  const jobs = store.listJobs();
  return {
    intervalMinutes: CONFIG.INTERVAL_OPTIONS.includes(Number(config.intervalMinutes))
      ? Number(config.intervalMinutes)
      : DEFAULT_INTERVAL_MINUTES,
    scheduleEnabled: config.scheduleEnabled,
    isTicking: runtime.isTicking,
    lastRunAt: runtime.lastRunAt,
    nextRunAt: runtime.nextRunAt,
    lastError: runtime.lastError,
    counts: {
      pending: jobs.filter((j) => j.status === 'pending').length,
      running: jobs.filter((j) => j.status === 'running').length,
      done: jobs.filter((j) => j.status === 'done').length,
      error: jobs.filter((j) => j.status === 'error').length,
    },
  };
}

module.exports = {
  enqueue,
  processPending,
  startScheduler,
  getStatus,
};
