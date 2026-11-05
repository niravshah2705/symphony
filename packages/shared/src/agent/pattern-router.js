'use strict';

/**
 * Execution-substrate router for the PLANNING stage.
 *
 * `agentPattern` selects WHERE the agent process runs (in-process Cloud Run,
 * OpenShell, or Agent Substrate) — orthogonal to `agentRuntime`/harness (which SDK)
 * and `workflowPattern` (how it reasons). This router diverts only the planning stage
 * to a substrate runner when the operator selects 'substrate'; every other pattern
 * falls through to the existing in-process dispatcher, so `cloudrun`/`openshell`
 * behavior is byte-for-byte unchanged.
 */

const { executeAgentRuntime } = require('./harnesses/dispatch');
const { getSettings } = require('../store');

const SUBSTRATE = 'substrate';

function resolveAgentPattern(explicit, settings) {
  if (explicit && String(explicit).trim()) return String(explicit).trim().toLowerCase();
  if (settings && settings.agentPattern && String(settings.agentPattern).trim()) {
    return String(settings.agentPattern).trim().toLowerCase();
  }
  try {
    const s = getSettings?.() || {};
    if (s.agentPattern) return String(s.agentPattern).trim().toLowerCase();
  } catch { /* ignore store read errors */ }
  return 'cloudrun';
}

// Planning stages we divert to the substrate (the business-plan / framework plan).
function isPlanningStage(options) {
  const stage = String(options.stage || '').toLowerCase();
  const workflow = String(options.workflow || '').toLowerCase();
  return stage === 'planning' || stage === 'plan' || workflow.includes('plan');
}

/**
 * Dispatch one run. Substrate + planning → per-run ephemeral actor; otherwise the
 * standard in-process harness dispatcher. Returns the same result contract either way.
 */
async function dispatchPlanning(options = {}, deps = {}) {
  const pattern = resolveAgentPattern(options.agentPattern, options.settings);
  if (pattern === SUBSTRATE && isPlanningStage(options)) {
    const { runPlanningOnSubstrate } = require('./substrate-runner');
    return runPlanningOnSubstrate({
      organizationId: options.organizationId || (options.ctx && options.ctx.organizationId),
      projectId: options.projectId || (options.ctx && options.ctx.projectId),
      projectName: options.projectName || (options.ctx && options.ctx.projectName),
      prompt: options.prompt,
      guardrailSpec: (options.settings && options.settings.guardrailSpec) || undefined,
      secrets: options.secrets || {},
      llm: options.llm,
      traceContext: { runId: options.invokeConfig && options.invokeConfig.runId, organizationId: options.organizationId },
      transport: options.substrateTransport,
      applyManifest: options.applyManifest,
      fetchImpl: options.fetchImpl,
      onStep: options.onStep,
    });
  }
  return executeAgentRuntime(options, deps);
}

module.exports = { dispatchPlanning, resolveAgentPattern, isPlanningStage, SUBSTRATE };
