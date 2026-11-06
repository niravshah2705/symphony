'use strict';

const store = require('../store');
const log = require('../logger');
const pricing = require('./pricing');
const { resolveOrgId } = require('./org-context');

/**
 * First-party usage metering — the ONLY place an agent run's token/cost usage is
 * persisted. Two call sites, and which one applies depends on where the run
 * executed: in-process harnesses call it from harnesses/contract.js meterRun,
 * and a Substrate actor run is metered by the dispatching planner pod (see
 * agent/substrate-runner.js) because the actor itself has no tenant store.
 *
 * The runtime already NORMALIZES usage (agent/runtimes normalizeUsage) before we
 * see it, so this module only picks the persisted subset and computes cost. It
 * MUST be fail-open: any error is swallowed so metering never breaks a run.
 */

function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

/** Reduce a normalized-usage object to the small persisted shape. */
function pickUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    totalTokens: num(u.totalTokens) || num(u.inputTokens) + num(u.outputTokens),
    cachedInputTokens: num(u.cachedInputTokens),
    reasoningOutputTokens: num(u.reasoningOutputTokens),
  };
}

/**
 * Persist one granular usage record for a completed (or errored) agent run.
 * @param {object} attribution { orgId?, projectId?, projectName?, userId?, userEmail?, taskId?, taskIdentifier?, source?, runId?, traceId?, gatewayMode? }
 * @param {object} result      the runtime result { usage, costUsd }
 * @param {object} [llm]        { provider, model } for cost estimation + labels
 * @returns {object|null} the stored record, or null when skipped / on error
 */
function recordUsage(attribution = {}, result = {}, llm = {}) {
  try {
    const usage = pickUsage(result.usage);
    // Skip empty runs (no tokens) to avoid noise in the ledger/drill-down.
    if (!usage.totalTokens && !usage.inputTokens && !usage.outputTokens) return null;
    const costUsd = pricing.costUsdFromResult(result, llm);
    const costPaise = pricing.usdToPaise(costUsd);
    const orgId = resolveOrgId(attribution);
    return store.addUsageRecord({
      orgId,
      projectId: attribution.projectId || null,
      projectName: attribution.projectName || null,
      userId: attribution.userId || null,
      userEmail: attribution.userEmail || null,
      taskId: attribution.taskId || null,
      taskIdentifier: attribution.taskIdentifier || null,
      source: attribution.source || 'run',
      // Correlation handles: the trace id links this row to Langfuse + the
      // service logs, and runId links it to the job that made it. Both are
      // best-effort — a run recorded without them is still billable.
      runId: attribution.runId || null,
      traceId: attribution.traceId || null,
      gatewayMode: attribution.gatewayMode || null,
      provider: (llm && llm.provider) || 'unknown',
      model: (llm && llm.model) || 'unknown',
      usage,
      costUsd,
      costPaise,
    });
  } catch (err) {
    log.warn(`recordUsage failed: ${err && err.message ? err.message : err}`);
    return null;
  }
}

module.exports = {
  pickUsage,
  recordUsage,
};
