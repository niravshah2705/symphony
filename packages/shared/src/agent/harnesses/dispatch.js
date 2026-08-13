'use strict';

/**
 * Execute one workflow with a normalized result contract and one LangSmith root
 * span. Executor construction happens inside that span and its error boundary,
 * so a throwing factory is observed exactly like a throwing SDK invocation.
 */

const { traceable, getCurrentRunTree } = require('langsmith/traceable');
const registry = require('./registry');
const {
  AgentRuntimeError,
  normalizeWorkflowPattern,
  applyWorkflowPattern,
  publicExecution,
  applyRubricMiddleware,
  annotateTrace,
  langSmithProvider,
  meterRun,
  wrapExecutionError,
} = require('./contract');

/** Build a dispatcher against a registry (the factory keeps tests isolated). */
function createRuntimeDispatcher(runtimeRegistry = registry) {
  return async function executeAgentRuntime(options = {}, deps = {}) {
    const resolution = runtimeRegistry.resolveAgentRuntime(options.runtime, options.llm, {
      strict: true,
      workflow: options.workflow || '',
      stage: options.stage,
      brokered: options.brokered,
      effectivePolicy: (options.ctx && options.ctx.effectivePolicy) || null,
    });
    const { requestedRuntime, runtime, fallbackReason } = resolution;
    const workflowPattern = normalizeWorkflowPattern(options.workflowPattern, { strict: true });
    const prompt = applyWorkflowPattern(options.prompt, workflowPattern);
    const runtimeOptions = { ...options, runtime, workflowPattern };
    const definition = runtimeRegistry.get(runtime);
    if (!definition) {
      throw new AgentRuntimeError(
        `Resolved agent runtime "${runtime}" has no registered definition.`,
        'runtime_unavailable',
        503,
      );
    }
    const reviewEnabled = Boolean(options.rubric || options.rubricMiddleware);

    const execute = async () => {
      try {
        // Factories receive trusted construction-time dependencies separately
        // from broad per-run options. Construct only after tracing has begun.
        const executor = definition.createExecutor(deps);
        if (typeof executor !== 'function') {
          throw new AgentRuntimeError(
            `${definition.label} executor factory did not return a function.`,
            'runtime_factory_invalid',
            500,
          );
        }
        const runOnce = (promptText) => executor(runtimeOptions, promptText);
        const value = await runOnce(prompt);
        const reviewed = reviewEnabled
          ? await applyRubricMiddleware(options, value, prompt, runOnce)
          : value;
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
    const harness = runtimeRegistry.harnessLabel(runtime);
    const modelName = (options.llm && options.llm.model) || '';
    const traceMetadataBase = {
      ...(invokeConfig.metadata || {}),
      agent_runtime: runtime,
      harness,
      ...(requestedRuntime !== runtime
        ? {
            requested_agent_runtime: requestedRuntime,
            runtime_fallback_reason: fallbackReason || 'runtime_incompatible',
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
  };
}

const executeAgentRuntime = createRuntimeDispatcher(registry);

module.exports = { executeAgentRuntime, createRuntimeDispatcher };
