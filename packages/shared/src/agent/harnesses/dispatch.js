'use strict';

/**
 * Execute one workflow with a normalized result contract and one LangSmith root
 * span, regardless of the selected harness. The executor is resolved from the
 * pluggable registry (registry.get(runtime).createExecutor) rather than a frozen
 * map, so new harnesses become dispatchable simply by registering.
 */

const { traceable, getCurrentRunTree } = require('langsmith/traceable');
const registry = require('./registry');
const {
  normalizeWorkflowPattern,
  applyWorkflowPattern,
  publicExecution,
  applyRubricMiddleware,
  annotateTrace,
  langSmithProvider,
  meterRun,
  wrapExecutionError,
} = require('./contract');

async function executeAgentRuntime(options = {}) {
  const requestedRuntime = registry.normalizeAgentRuntime(options.runtime, { strict: true });
  const runtime = registry.effectiveAgentRuntime(requestedRuntime, options.llm, {
    strict: true,
    workflow: options.workflow || '',
    effectivePolicy: (options.ctx && options.ctx.effectivePolicy) || null,
  });
  const workflowPattern = normalizeWorkflowPattern(options.workflowPattern, { strict: true });
  const prompt = applyWorkflowPattern(options.prompt, workflowPattern);
  const runtimeOptions = { ...options, runtime, workflowPattern };
  const definition = registry.get(runtime);
  const executor = definition.createExecutor({});
  const runOnce = (promptText) => executor(runtimeOptions, promptText);
  const reviewEnabled = Boolean(options.rubric || options.rubricMiddleware);
  const execute = async () => {
    try {
      const value = await runOnce(prompt);
      const reviewed = reviewEnabled ? await applyRubricMiddleware(options, value, prompt, runOnce) : value;
      annotateTrace(reviewed, options.getCurrentRunTree || getCurrentRunTree);
      meterRun(options, reviewed);
      return reviewed;
    } catch (error) {
      const wrapped = wrapExecutionError(definition.label, error);
      annotateTrace(wrapped, options.getCurrentRunTree || getCurrentRunTree);
      meterRun(options, wrapped);
      throw wrapped;
    }
  };

  if (options.trace === false) return execute();
  const invokeConfig = options.invokeConfig || {};
  const harness = registry.harnessLabel(runtime);
  const modelName = (options.llm && options.llm.model) || '';
  const traceMetadataBase = {
    ...(invokeConfig.metadata || {}),
    agent_runtime: runtime,
    harness,
    ...(requestedRuntime !== runtime
      ? {
          requested_agent_runtime: requestedRuntime,
          runtime_fallback_reason: options.workflow === 'coding'
            ? 'workflow_requires_broker'
            : 'provider_mismatch',
        }
      : {}),
    model_provider: (options.llm && options.llm.provider) || 'unknown',
    model_name: modelName || 'unknown',
    ls_provider: langSmithProvider(options.llm),
    ls_model_name: modelName || 'unknown',
    workflow_pattern: workflowPattern,
    workflow_name: options.workflow || 'agent',
  };
  const traceFactory = options.traceFactory || traceable;
  const traced = traceFactory(execute, {
    name: String(invokeConfig.runName || `agent-runtime:${runtime}`).slice(0, 120),
    run_type: runtime === 'deepagent' ? 'chain' : 'llm',
    id: invokeConfig.runId,
    tags: [
      ...new Set([
        ...(invokeConfig.tags || []),
        ...(options.tags || []),
        `runtime:${runtime}`,
        `harness:${harness}`,
        `pattern:${workflowPattern}`,
        ...(modelName ? [`model:${modelName}`] : []),
      ]),
    ],
    metadata: traceMetadataBase,
    processInputs: () => ({ prompt: String(prompt).slice(0, 20_000) }),
    processOutputs: (result) => publicExecution(result),
  });
  return traced();
}

module.exports = { executeAgentRuntime };
