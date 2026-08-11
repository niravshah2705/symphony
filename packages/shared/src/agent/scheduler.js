'use strict';

const crypto = require('crypto');
const store = require('../store');
const linear = require('../linear');
const log = require('../logger');
const { generatePlan, generateIssuesForMilestones } = require('./plan');
const { applyPlan, applyIssuesForMilestones, applyAiplanned, applyAifail } = require('./apply');
const { llmReady, notReadyReason, resolveLlm, providerForRole } = require('./llm');
const { isModelAvailabilityError, pauseReasonFor, probeModelAvailability } = require('./availability');
const {
  fetchOrgEffectivePolicy,
  isOrganizationContextMismatch,
  isPolicyUnavailableError,
  PolicyUnavailableError,
} = require('./org-policy-client');
const {
  enforceLlmModel,
  applyOperationalPrefs,
  isPolicyDeniedError,
} = require('./policy-runtime');
const workspaceEvents = require('./workspace-events');
const { processBillingSweep } = require('../billing/sweep');
const { billingStatus } = require('../billing/gate');
const {
  normalizeWorkspaceContext,
  currentWorkspaceContext,
  runWithWorkspaceContext,
  workspaceCacheKey,
  pinnedWorkspaceOrganizationId,
} = require('../store/workspace-context');

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

function hasEffectivePolicy(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length,
  );
}

/** Resolve the configured cadence, falling back to an allowed default. */
function intervalMs(config) {
  const minutes = CONFIG.INTERVAL_OPTIONS.includes(Number(config.intervalMinutes))
    ? Number(config.intervalMinutes)
    : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60 * 1000;
}

function createRuntime() {
  return {
    timer: null,
    kickoffTimer: null,
    isTicking: false,
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    pauseReason: null,
  };
}

const runtimes = new Map();

/** Canonical scheduler scope, falling back to a dedicated deployment's pin. */
function schedulerContext(context) {
  const selected = normalizeWorkspaceContext(
    context === undefined ? currentWorkspaceContext() : context,
  );
  if (selected.organizationId) return selected;
  const pinned = pinnedWorkspaceOrganizationId();
  return pinned
    ? normalizeWorkspaceContext({ organizationId: pinned })
    : selected;
}

function runtimeFor(context) {
  const selected = schedulerContext(context);
  const key = workspaceCacheKey(selected);
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createRuntime();
    runtimes.set(key, runtime);
  }
  return runtime;
}

/** Authenticated shared deployments may only run autonomous work for a tenant. */
function shouldSkipUnscopedSharedTick(context, options = {}) {
  const selected = normalizeWorkspaceContext(
    context === undefined ? currentWorkspaceContext() : context,
  );
  const authEnabled = options.authEnabled === undefined
    ? Boolean(CONFIG.AUTH && CONFIG.AUTH.enabled)
    : Boolean(options.authEnabled);
  const storeNamespace = options.storeNamespace === undefined
    ? CONFIG.STORE_NAMESPACE
    : String(options.storeNamespace || '');
  const pinnedOrganizationId = options.pinnedOrganizationId === undefined
    ? pinnedWorkspaceOrganizationId()
    : String(options.pinnedOrganizationId || '');
  return authEnabled
    && !storeNamespace
    && !pinnedOrganizationId
    && !selected.organizationId;
}

function pauseForModel(error, settings, llm = null, context) {
  const runtime = runtimeFor(context);
  if (!runtime.pauseReason) {
    runtime.pauseReason = pauseReasonFor('model', error, {
      provider: (llm && llm.provider) || providerForRole(settings, 'thinking'),
      model: llm && llm.model,
      role: 'thinking',
    });
  }
  runtime.lastError = runtime.pauseReason.message;
  return runtime.pauseReason;
}

function pauseForPolicy(context) {
  const runtime = runtimeFor(context);
  const reason = {
    code: 'policy-unavailable',
    resource: 'policy',
    message: 'Workspace policy is temporarily unavailable. Agent jobs will retry automatically.',
    since: new Date().toISOString(),
  };
  runtime.pauseReason = reason;
  runtime.lastError = reason.message;
  return reason;
}

function clearModelPause(context) {
  const runtime = runtimeFor(context);
  const cleared = Boolean(runtime.pauseReason);
  runtime.pauseReason = null;
  if (cleared) log.info('Planner model availability pause cleared.');
}

async function verifyModelReadiness(settings, dependencies = {}, context) {
  const runtime = runtimeFor(context);
  const resolve = dependencies.resolveLlm || resolveLlm;
  const probe = dependencies.probeModelAvailability || probeModelAvailability;
  let llm;
  try {
    llm = await resolve(settings, 'thinking');
    await probe(llm);
    clearModelPause(context);
    runtime.lastError = null;
    return llm;
  } catch (error) {
    pauseForModel(error, settings, llm, context);
    throw error;
  }
}

/**
 * Push the current jobs + planner-status snapshot to the global workspace channel
 * so the SPA updates live instead of polling /status + /jobs. Best-effort —
 * telemetry must never break enqueue or a running job.
 */
function contextForJob(job, fallback) {
  const selected = normalizeWorkspaceContext({
    organizationId: job && job.orgId,
    projectId: job && job.nativeProjectId,
  });
  return selected.organizationId ? selected : schedulerContext(fallback);
}

function emitWorkspaceState(job = null, context) {
  try {
    const selected = contextForJob(job, context);
    workspaceEvents.publishJobsSnapshot(selected);
    workspaceEvents.publishAgentStatus(
      { ...getStatus(selected), assumedRole: store.getAssumedRole() },
      selected,
    );
  } catch (_) {
    /* telemetry only */
  }
}

/** Queue a project for enrichment, skipping duplicates already in flight. */
function enqueue({ projectId, projectName, assumedRole, orgId = null, nativeProjectId = null }) {
  const activeContext = schedulerContext();
  const requestedContext = normalizeWorkspaceContext({
    organizationId: orgId || activeContext.organizationId,
    projectId: nativeProjectId || activeContext.projectId,
  });
  if (
    activeContext.organizationId
    && requestedContext.organizationId
    && activeContext.organizationId !== requestedContext.organizationId
  ) {
    const error = new Error('Queued job organization does not match the active workspace.');
    error.code = 'workspace_organization_mismatch';
    error.status = 403;
    throw error;
  }
  if (
    activeContext.projectId
    && requestedContext.projectId
    && activeContext.projectId !== requestedContext.projectId
  ) {
    const error = new Error('Queued job project does not match the active workspace.');
    error.code = 'workspace_project_mismatch';
    error.status = 403;
    throw error;
  }
  const selectedOrgId = requestedContext.organizationId || null;
  const selectedProjectId = requestedContext.projectId || null;
  const active = store.listJobs('enrichment').some(
    (j) => j.projectId === projectId
      && (j.orgId || null) === selectedOrgId
      && (j.nativeProjectId || null) === selectedProjectId
      && (j.status === 'pending' || j.status === 'running')
  );
  if (active) return null;

  const job = {
    id: crypto.randomUUID(),
    kind: 'enrichment',
    projectId,
    projectName: projectName || projectId,
    ...(selectedOrgId ? { orgId: selectedOrgId } : {}),
    ...(selectedProjectId ? { nativeProjectId: selectedProjectId } : {}),
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
  emitWorkspaceState(job);
  return job;
}

/** Run one enrichment job end-to-end, recording a step trace on the job. */
async function runJob(job, { apiKey, keys, llm, config }, dependencies = {}) {
  const jobStore = dependencies.store || store;
  const linearClient = dependencies.linear || linear;
  const generatePlanImpl = dependencies.generatePlan || generatePlan;
  const generateIssuesImpl = dependencies.generateIssuesForMilestones || generateIssuesForMilestones;
  const applyPlanImpl = dependencies.applyPlan || applyPlan;
  const applyIssuesImpl = dependencies.applyIssuesForMilestones || applyIssuesForMilestones;
  const applyAiplannedImpl = dependencies.applyAiplanned || applyAiplanned;
  const applyAifailImpl = dependencies.applyAifail || applyAifail;
  const getSettings = dependencies.getSettings || store.getSettings;
  // Resolve THIS org's effective policy (org→project cascade) so the planning
  // agent ENFORCES the harness/tools/skills allow-deny cascade (framework.js
  // prunes tools/skills; runtimes.js rejects a denied harness). The autonomous
  // loop has no end-user token, so this is a token-gated S2S org resolve. A
  // selected organization fails closed when that policy is unavailable; only
  // the legacy empty local context keeps its allow-all fallback.
  const resolvePolicyImpl = dependencies.resolvePolicy || fetchOrgEffectivePolicy;
  // Records a step both to the persistent log file and onto the job (for the UI).
  const step = (message, level = 'info') => {
    log[level] ? log[level](`[job ${job.id.slice(0, 8)} · ${job.projectName}] ${message}`) : log.info(message);
    jobStore.appendJobStep(job.id, { ts: new Date().toISOString(), level, message });
  };

  const finish = (patch) => {
    const done = jobStore.updateJob(job.id, { status: 'done', finishedAt: new Date().toISOString(), error: null, ...patch });
    emitWorkspaceState(job);
    return done;
  };

  jobStore.updateJob(job.id, {
    status: 'running',
    startedAt: new Date().toISOString(),
    error: null,
    pauseReason: null,
  });
  emitWorkspaceState(job);
  step('Enrichment started.');
  let phase = 'planning-provider';
  try {
    // Inspect existing milestones to decide: NEW plan vs RESUME (create issues).
    const { project, milestones } = await linearClient.getMilestonesWithIssueCounts(apiKey, job.projectId);

    // Resolve the org's effective policy for enforcement. A selected
    // organization must never downgrade an outage to allow-all.
    const selectedPolicyContext = contextForJob(job);
    const policyOrgId = job.orgId || selectedPolicyContext.organizationId || null;
    const policyProjectId = job.nativeProjectId || selectedPolicyContext.projectId || null;
    let resolved = null;
    try {
      resolved = await resolvePolicyImpl(policyOrgId || undefined, policyProjectId || undefined);
    } catch (error) {
      if (isOrganizationContextMismatch(error)) throw error;
      if (policyOrgId) {
        throw isPolicyUnavailableError(error)
          ? error
          : new PolicyUnavailableError(undefined, error);
      }
    }
    const effectivePolicy = (resolved && resolved.effectivePolicy) || null;
    if (policyOrgId && !hasEffectivePolicy(effectivePolicy)) {
      throw new PolicyUnavailableError();
    }
    const opPrefs = (resolved && resolved.prefs) || {};
    const policySettings = {
      effectivePolicy,
      orgId: policyOrgId,
      nativeProjectId: policyProjectId,
    };
    // Enforce the models policy on the resolved model. A denied model may move
    // only to an allowed same-provider preset; otherwise enforcement fails
    // closed before any model-backed planning runs.
    const enforcedLlm = enforceLlmModel(llm, effectivePolicy);
    if (enforcedLlm.model !== llm.model) {
      step(`Model "${llm.model}" is denied by organization policy; using allowed "${enforcedLlm.model}".`, 'warn');
    }
    // Overlay the org's per-scope operational prefs (runtime/workflow/tracing)
    // onto the planner keys. Fail-open: unset prefs leave keys unchanged.
    const runKeys = applyOperationalPrefs(keys, opPrefs, step);

    if (milestones.length > 0) {
      // ---- RESUME: milestones already exist; ensure each has issues, then aidone.
      const missing = milestones.filter((m) => m.issueCount === 0);
      step(`Found ${milestones.length} existing milestone(s); ${missing.length} without issues.`);
      let summary = { milestonesCreated: 0, issuesCreated: 0, dependenciesCreated: 0, warnings: [], resumed: true };
      if (missing.length && config.createIssues) {
        phase = 'model';
        const gen = await generateIssuesImpl({ project, milestones: missing, config, llm: enforcedLlm, keys: runKeys, onStep: step });
        phase = 'planning-provider';
        summary = await applyIssuesImpl(apiKey, { project, milestones: missing, generated: gen.milestones, config, onStep: step });
        await applyAiplannedImpl(apiKey, { project, onStep: step });
        step(`Resumed: created ${summary.issuesCreated} task(s); marked aiplanned.`);
        finish({ traceUrl: gen.traceUrl, traced: gen.traced, summary });
      } else {
        await applyAiplannedImpl(apiKey, { project, onStep: step });
        step('All milestones already have issues; marked aiplanned.');
        finish({ summary });
      }
      return;
    }

    // ---- NEW: no milestones yet — viability + full business plan.
    phase = 'model';
    const result = await generatePlanImpl({ project, assumedRole: job.assumedRole, config, llm: enforcedLlm, keys: runKeys, onStep: step, settings: policySettings });
    phase = 'planning-provider';

    if (!result.viable) {
      const summary = await applyAifailImpl(apiKey, { project, reason: result.reason, onStep: step });
      step(`Marked aifail: ${result.reason.slice(0, 160)}`, 'warn');
      finish({ traceUrl: result.traceUrl, traced: result.traced, summary });
      return;
    }

    const summary = await applyPlanImpl(apiKey, { project, plan: result.plan, assumedRole: job.assumedRole, config, onStep: step });
    // Mark aiplanned once issues exist (or when issue creation is disabled) — the
    // project is now planned and ready for the coding flow to work its tasks.
    if (summary.issuesCreated > 0 || !config.createIssues) {
      await applyAiplannedImpl(apiKey, { project, onStep: step });
    }
    step(`Done: ${summary.milestonesCreated} milestones, ${summary.issuesCreated} issues, ${summary.dependenciesCreated} deps${summary.warnings.length ? `, ${summary.warnings.length} warning(s)` : ''}.`);
    finish({ traceUrl: result.traceUrl, traced: result.traced, summary });
  } catch (err) {
    if (isPolicyUnavailableError(err)) {
      const reason = pauseForPolicy(contextForJob(job));
      step(`Agent jobs paused: ${reason.message}`, 'warn');
      jobStore.updateJob(job.id, {
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        error: reason.message,
        pauseReason: reason,
      });
      emitWorkspaceState(job);
      return { paused: true, pauseReason: reason };
    }
    if (isPolicyDeniedError(err)) {
      const message = err && err.message ? err.message : String(err);
      step(`Failed: ${message}`, 'error');
      jobStore.updateJob(job.id, {
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: message,
        policyDenied: true,
      });
      emitWorkspaceState(job);
      return { error: message, policyDenied: true };
    }
    if (phase === 'model' && isModelAvailabilityError(err)) {
      const reason = pauseForModel(err, getSettings(), llm, contextForJob(job));
      step(`Agent jobs paused: ${reason.message}`, 'warn');
      jobStore.updateJob(job.id, {
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        error: reason.message,
        pauseReason: reason,
      });
      emitWorkspaceState(job);
      return { paused: true, pauseReason: reason };
    }
    const message = err && err.message ? err.message : String(err);
    step(`Failed: ${message}`, 'error');
    jobStore.updateJob(job.id, {
      status: 'error',
      finishedAt: new Date().toISOString(),
      error: message,
      ...(isPolicyDeniedError(err) ? { policyDenied: true } : {}),
    });
    emitWorkspaceState(job);
    return { error: message };
  }
  return { done: true };
}

/**
 * Auto-discover projects that still carry an enrich label (e.g. `AI`) and enqueue
 * any without an in-flight job. Completed projects become `aidone` and unfit ones
 * `aifail` (both replace the enrich label), so they drop out naturally; projects
 * with milestones-but-no-issues stay labelled and are picked up for RESUME.
 * @returns {Promise<number>} count of newly queued projects
 */
function jobMatchesContext(job, context) {
  const selected = schedulerContext(context);
  if (selected.organizationId && (job.orgId || null) !== selected.organizationId) {
    const legacyDedicatedRecord = !job.orgId
      && Boolean(CONFIG.STORE_NAMESPACE)
      && pinnedWorkspaceOrganizationId() === selected.organizationId;
    if (!legacyDedicatedRecord) return false;
  }
  if (selected.projectId && (job.nativeProjectId || null) !== selected.projectId) return false;
  return true;
}

function jobsForContext(jobs, context) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) => jobMatchesContext(job, context));
}

function runJobInWorkspace(job, fallbackContext, task) {
  const selected = contextForJob(job, fallbackContext);
  return runWithWorkspaceContext(selected, () => task(selected));
}

async function discover({ apiKey, assumedRole, config, context }, dependencies = {}) {
  const selected = schedulerContext(context);
  const linearClient = dependencies.linear || linear;
  const jobStore = dependencies.store || store;
  const enqueueImpl = dependencies.enqueue || enqueue;
  const candidates = await linearClient.getProjectsWithLabels(apiKey, config.enrichLabels);
  const inFlight = new Set(
    jobsForContext(jobStore.listJobs('enrichment'), selected)
      .filter((j) => j.status === 'pending' || j.status === 'running')
      .map((j) => j.projectId)
  );
  let queued = 0;
  for (const project of candidates) {
    if (inFlight.has(project.id)) continue;
    const job = enqueueImpl({
      projectId: project.id,
      projectName: project.name,
      assumedRole,
      orgId: selected.organizationId || null,
      nativeProjectId: selected.projectId || null,
    });
    if (job) {
      queued += 1;
      log.info(`Queued "${project.name}" for enrichment.`);
    }
  }
  return queued;
}

/** Process one tick: auto-discover by label, then enrich. Never overlaps. */
async function processPending(context, options = {}) {
  const selected = schedulerContext(context);
  const active = schedulerContext();
  if (
    context !== undefined
    && workspaceCacheKey(selected) !== workspaceCacheKey(active)
  ) {
    return runWithWorkspaceContext(selected, async () => {
      await store.initStore();
      return processPending(undefined, options);
    });
  }
  if (shouldSkipUnscopedSharedTick(selected, options.workspaceGuard)) {
    log.warn('Scheduler tick skipped: an organization context is required in the shared deployment.');
    return { skipped: 'workspace-context-required' };
  }
  const runtime = runtimeFor(selected);
  if (runtime.isTicking) return { skipped: 'already-running' };
  runtime.isTicking = true;
  runtime.lastRunAt = new Date().toISOString();
  emitWorkspaceState(null, selected);
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
    if (!llmReady(settings, 'thinking')) {
      const reason = pauseForModel(
        new Error(notReadyReason(settings, 'thinking')),
        settings,
        null,
        selected,
      );
      log.warn(`Tick skipped: ${reason.message}`);
      return { skipped: 'paused', reason: reason.message, pauseReason: reason };
    }
    if (!assumedRole) {
      runtime.lastError = 'Assume a role in Settings to enable automatic enrichment.';
      log.warn(`Tick skipped: ${runtime.lastError}`);
      return { skipped: 'no-role', reason: runtime.lastError };
    }
    // Negative-balance gate: pause enrichment when the org's credit is exhausted.
    // Inert unless billing is enabled + the account opts in (see billing/gate.js).
    const billing = billingStatus({ orgId: selected.organizationId || undefined });
    if (billing.blocked) {
      runtime.lastError = billing.reason;
      log.warn(`Tick skipped: ${billing.reason}`);
      return { skipped: 'billing', reason: billing.reason };
    }
    runtime.lastError = null;

    // Resolve the active provider (refreshes the Codex OAuth token if needed).
    let llm;
    try {
      llm = await verifyModelReadiness(settings, {}, selected);
    } catch (err) {
      const reason = runtime.pauseReason;
      log.warn(`Tick skipped: ${reason.message}`);
      return { skipped: 'paused', reason: reason.message, pauseReason: reason };
    }
    const keys = {
      langsmithApiKey: settings.langsmithApiKey,
      langsmithProject: settings.langsmithProject,
      langsmithEndpoint: settings.langsmithEndpoint,
      langsmithTracing: settings.langsmithTracing,
      agentRuntime: settings.agentRuntime,
      workflowPattern: settings.workflowPattern,
    };

    // 1. Discover projects to enrich automatically (by label).
    let discovered = 0;
    try {
      discovered = await discover({ apiKey, assumedRole, config, context: selected });
    } catch (err) {
      runtime.lastError = `Discovery failed: ${err && err.message ? err.message : err}`;
    }

    // 2. Process the pending queue, bounded by config.
    const pending = jobsForContext(store.listJobs('enrichment'), selected)
      .filter((j) => j.status === 'pending');
    const batch = pending.slice(0, Math.max(1, config.maxProjectsPerRun));
    const concurrency = Math.max(1, Math.min(config.parallelProcessing || 1, batch.length || 1));

    log.info(`Tick: discovered ${discovered}, processing ${batch.length} (parallel ${concurrency}).`);
    await runWithConcurrency(batch, concurrency, (job) => {
      const jobContext = contextForJob(job, selected);
      if (runtimeFor(jobContext).pauseReason) return Promise.resolve({ skipped: 'paused' });
      return runJobInWorkspace(
        job,
        selected,
        () => runJob(job, { apiKey, keys, llm, config }),
      );
    });
    // A project-scoped tick must never prune another native project's history.
    if (!selected.projectId) store.pruneJobs();
    log.info(`Tick finished (processed ${batch.length}).`);
    if (runtime.pauseReason) {
      return { discovered, processed: batch.length, paused: true, pauseReason: runtime.pauseReason };
    }
    return { discovered, processed: batch.length };
  } catch (err) {
    runtime.lastError = err && err.message ? err.message : String(err);
    log.error(`Tick error: ${runtime.lastError}`);
    return { error: runtime.lastError };
  } finally {
    runtime.isTicking = false;
    emitWorkspaceState(null, selected);
  }
}

/**
 * Auto-approve requirement-evaluation gates whose deadline has elapsed. Runs
 * every cadence, INDEPENDENT of the Linear-key/role/LLM guards in
 * `processPending` — a missing Linear key must never stall auto-approval. Errors
 * are swallowed (logged) so a bad gate cannot break the scheduling loop.
 */
function gateMatchesContext(gate, context) {
  const selected = schedulerContext(context);
  if (selected.organizationId && (gate.orgId || null) !== selected.organizationId) {
    const legacyDedicatedRecord = !gate.orgId
      && Boolean(CONFIG.STORE_NAMESPACE)
      && pinnedWorkspaceOrganizationId() === selected.organizationId;
    if (!legacyDedicatedRecord) return false;
  }
  if (selected.projectId && (gate.nativeProjectId || null) !== selected.projectId) return false;
  return true;
}

function scopedApprovalStore(baseStore, context) {
  const selected = schedulerContext(context);
  if (!selected.organizationId) return baseStore;
  const scoped = Object.create(baseStore);
  scoped.listApprovalGates = (filter) => baseStore
    .listApprovalGates(filter)
    .filter((gate) => gateMatchesContext(gate, selected));
  return scoped;
}

async function processApprovalDeadlines(deps = {}, context) {
  const selected = schedulerContext(context);
  const sweep = deps.sweepExpiredGates || require('./approval-gate').sweepExpiredGates;
  const baseStore = (deps.gateDeps && deps.gateDeps.store) || store;
  const gateDeps = {
    ...(deps.gateDeps || {}),
    store: scopedApprovalStore(baseStore, selected),
  };
  try {
    return await sweep(Date.now(), gateDeps);
  } catch (err) {
    log.warn(`Approval-gate sweep failed: ${err && err.message ? err.message : err}`);
    return { error: true };
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
function scheduleNext(context) {
  const selected = schedulerContext(context);
  if (shouldSkipUnscopedSharedTick(selected)) return null;
  const runtime = runtimeFor(selected);
  if (runtime.timer) return runtime.timer;
  const ms = intervalMs(store.getAgentConfig());
  runtime.nextRunAt = new Date(Date.now() + ms).toISOString();
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    Promise.resolve(runWithWorkspaceContext(selected, async () => {
      await store.initStore();
      const config = store.getAgentConfig();
      // The billing sweep runs every cadence INDEPENDENT of scheduleEnabled and
      // of the billing gate (a recharge posted here unblocks a paused runner).
      await processBillingSweep().catch(() => {});
      if (config.scheduleEnabled) {
        // Approval deadlines first, independent of processPending's guards.
        await processApprovalDeadlines().catch(() => {});
        await processPending(selected).catch(() => {});
      }
    }))
      .catch((error) => {
        runtime.lastError = error && error.message ? error.message : String(error);
        log.error(`Scheduler cycle failed: ${runtime.lastError}`);
      })
      .finally(() => {
        scheduleNext(selected);
      });
  }, ms);
  return runtime.timer;
}

const RESTART_KICKOFF_MS = 4000;

function reconcileRunningJobsForContext(context) {
  const selected = schedulerContext(context);
  if (!selected.projectId) return store.reconcileRunningJobs();
  let count = 0;
  const now = new Date().toISOString();
  for (const job of jobsForContext(store.listJobs('enrichment'), selected)) {
    if (job.status !== 'running') continue;
    count += 1;
    const step = { ts: now, level: 'error', message: 'Interrupted by server restart.' };
    store.updateJob(job.id, {
      status: 'error',
      error: step.message,
      finishedAt: now,
      steps: [...(job.steps || []), step],
    });
  }
  return count;
}

function startScheduler(context) {
  const selected = schedulerContext(context);
  if (shouldSkipUnscopedSharedTick(selected)) {
    log.warn('Scheduler not started: shared authenticated deployments require tenant-scoped ticks.');
    return { skipped: 'workspace-context-required' };
  }
  const runtime = runtimeFor(selected);
  if (runtime.timer) return;
  const interrupted = reconcileRunningJobsForContext(selected);
  if (interrupted) log.warn(`Marked ${interrupted} interrupted job(s) as error after restart.`);
  const minutes = intervalMs(store.getAgentConfig()) / 60000;
  log.info(`Scheduler started (every ${minutes} min).`);
  scheduleNext(selected);
  // On restart, promptly review existing milestones and resume issue creation.
  runtime.kickoffTimer = setTimeout(() => {
    runtime.kickoffTimer = null;
    Promise.resolve(runWithWorkspaceContext(selected, async () => {
      await store.initStore();
      if (store.getAgentConfig().scheduleEnabled) {
        log.info('Restart resume pass…');
        // Fire any approval deadlines that elapsed while the server was down.
        await processApprovalDeadlines().catch(() => {});
        await processPending(selected).catch(() => {});
      }
    })).catch((error) => {
      runtime.lastError = error && error.message ? error.message : String(error);
      log.error(`Restart resume pass failed: ${runtime.lastError}`);
    });
  }, RESTART_KICKOFF_MS);
}

function getStatus(context) {
  const selected = schedulerContext(context);
  const runtime = runtimeFor(selected);
  const config = store.getAgentConfig();
  const jobs = jobsForContext(store.listJobs('enrichment'), selected);
  return {
    intervalMinutes: CONFIG.INTERVAL_OPTIONS.includes(Number(config.intervalMinutes))
      ? Number(config.intervalMinutes)
      : DEFAULT_INTERVAL_MINUTES,
    scheduleEnabled: config.scheduleEnabled,
    isTicking: runtime.isTicking,
    lastRunAt: runtime.lastRunAt,
    nextRunAt: runtime.nextRunAt,
    lastError: runtime.lastError,
    paused: Boolean(runtime.pauseReason),
    pauseReason: runtime.pauseReason,
    counts: {
      pending: jobs.filter((j) => j.status === 'pending').length,
      running: jobs.filter((j) => j.status === 'running').length,
      done: jobs.filter((j) => j.status === 'done').length,
      error: jobs.filter((j) => j.status === 'error').length,
    },
  };
}

function resetRuntime(context) {
  const selected = schedulerContext(context);
  const key = workspaceCacheKey(selected);
  const runtime = runtimes.get(key);
  if (!runtime) return false;
  if (runtime.timer) clearTimeout(runtime.timer);
  if (runtime.kickoffTimer) clearTimeout(runtime.kickoffTimer);
  runtimes.delete(key);
  return true;
}

function resetAllRuntimes() {
  for (const runtime of runtimes.values()) {
    if (runtime.timer) clearTimeout(runtime.timer);
    if (runtime.kickoffTimer) clearTimeout(runtime.kickoffTimer);
  }
  runtimes.clear();
}

module.exports = {
  enqueue,
  processPending,
  startScheduler,
  getStatus,
  processApprovalDeadlines,
  _test: {
    clearModelPause,
    pauseForModel,
    pauseForPolicy,
    runJob,
    verifyModelReadiness,
    processApprovalDeadlines,
    enforceLlmModel,
    schedulerContext,
    runtimeFor,
    resetRuntime,
    resetAllRuntimes,
    shouldSkipUnscopedSharedTick,
    jobMatchesContext,
    jobsForContext,
    runJobInWorkspace,
    gateMatchesContext,
    scopedApprovalStore,
    discover,
    scheduleNext,
    reconcileRunningJobsForContext,
  },
};
