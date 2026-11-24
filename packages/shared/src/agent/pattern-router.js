'use strict';

/**
 * Execution-substrate router for agent runs.
 *
 * Agent Substrate is the only execution substrate: every run is dispatched to
 * a per-run ephemeral actor, which executes the selected harness in-process.
 * `agentRuntime`/harness (which SDK) and `workflowPattern` (how it reasons)
 * stay orthogonal and travel with the run. The retired in-process Cloud Run
 * harness is no longer selectable — `agentPattern` settings are ignored.
 */

const { currentTraceparent } = require('./langfuse');
const { cleanTraceparent, traceparentFromEnv } = require('@software-factory/shared-core/traceparent');

/**
 * The trace this run belongs to, whichever way it was handed to us: an explicit
 * value from the caller, the span we are currently inside, or the ambient value
 * a job was launched with. None of the three is reliable on its own — an HTTP
 * route has the header, an in-process run has the span, a job launched without
 * either has nothing — and a run that loses its trace id loses its billing
 * history too.
 */
function resolveTraceparent(options = {}) {
  return cleanTraceparent(
    options.traceparent
      || (options.ctx && options.ctx.traceparent)
      || currentTraceparent()
      || traceparentFromEnv(),
  ) || null;
}

/**
 * Dispatch one run to a per-run substrate actor. Returns the same result
 * contract the in-process harness dispatcher used to return.
 */
async function dispatchPlanning(options = {}) {
  const { runPlanningOnSubstrate } = require('./substrate-runner');
  return runPlanningOnSubstrate({
    organizationId: options.organizationId || (options.ctx && options.ctx.organizationId),
    projectId: options.projectId || (options.ctx && options.ctx.projectId),
    projectName: options.projectName || (options.ctx && options.ctx.projectName),
    userId: (options.attribution && options.attribution.userId) || (options.ctx && options.ctx.userId) || null,
    userEmail: (options.attribution && options.attribution.userEmail) || (options.ctx && options.ctx.userEmail) || null,
    prompt: options.prompt,
    guardrailSpec: (options.settings && options.settings.guardrailSpec) || undefined,
    secrets: options.secrets || {},
    llm: options.llm,
    runtime: options.runtime,
    agentRuntime: options.agentRuntime || (options.settings && options.settings.agentRuntime),
    workflowPattern: options.workflowPattern || (options.settings && options.settings.workflowPattern),
    settings: options.settings,
    // Which key pays: a stage run threads the admitted decision on attribution,
    // the legacy planner on its settings blob. Absent means a platform key.
    providerSource: (options.attribution && options.attribution.providerSource)
      || (options.settings && options.settings.providerSource)
      || null,
    workflow: options.workflow,
    stage: options.stage,
    traceContext: {
      runId: options.invokeConfig && options.invokeConfig.runId,
      organizationId: options.organizationId,
      traceparent: resolveTraceparent(options),
    },
    transport: options.substrateTransport,
    applyManifest: options.applyManifest,
    fetchImpl: options.fetchImpl,
    onStep: options.onStep,
  });
}

module.exports = { dispatchPlanning, resolveTraceparent };
