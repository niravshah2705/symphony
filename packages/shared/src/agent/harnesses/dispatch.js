'use strict';

/**
 * Execute one workflow with a normalized result contract and one Langfuse root
 * observation. Executor construction happens inside that observation and its
 * error boundary, so a throwing factory is observed exactly like a throwing SDK
 * invocation.
 */

const registry = require('./registry');
const langfuse = require('../langfuse');
const {
  AgentRuntimeError,
  normalizeWorkflowPattern,
  applyWorkflowPattern,
  publicExecution,
  applyRubricMiddleware,
  traceMetadata,
  meterRun,
  wrapExecutionError,
  resolveAndRouteSkills,
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

    // Progressive disclosure: route skills dynamically per turn using Laya / CLM / LangChain.
    let routingMetrics = runtimeOptions.skillRouterMetrics || null;
    let routedSkillPaths = runtimeOptions.skillPaths || runtimeOptions.skills || null;
    if (!routingMetrics) {
      try {
        const routingResult = await resolveAndRouteSkills(runtimeOptions, prompt);
        if (routingResult && routingResult.routingMetrics) {
          routingMetrics = routingResult.routingMetrics;
          routedSkillPaths = routingResult.selectedSkillPaths;
          runtimeOptions.skillRouterMetrics = routingMetrics;
          if (routedSkillPaths && routedSkillPaths.length) {
            runtimeOptions.skillPaths = routedSkillPaths;
          }
        }
      } catch (_) {}
    }

    // MemoryMiddleware (claude-mem, harness-agnostic) — opt-in, off by default,
    // and fully isolated so it can never fail a real run. Gate resolution is
    // cheap and never throws; the inject/capture calls are individually guarded.
    let memory = null;
    let memoryOn = false;
    try {
      memory = require('../memory-middleware');
      memoryOn = memory.isEnabled(options);
    } catch (_) {
      memoryOn = false;
    }

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
        // SessionStart / UserPromptSubmit equivalent: recall + inject durable memory.
        let runPrompt = prompt;
        if (memoryOn) {
          try {
            runPrompt = await memory.inject(prompt, runtimeOptions);
          } catch (_) {
            runPrompt = prompt;
          }
        }
        const value = await runOnce(runPrompt);
        if (routingMetrics && value && !value.skillRouterMetrics) {
          value.skillRouterMetrics = routingMetrics;
        }
        if (routedSkillPaths && value && !value.skillPaths) {
          value.skillPaths = routedSkillPaths;
        }
        const reviewed = reviewEnabled
          ? await applyRubricMiddleware(options, value, runPrompt, runOnce)
          : value;
        meterRun(options, reviewed);
        // Stop / SessionEnd equivalent: compress + persist. Awaited because Cloud
        // Run has no reliable post-response background window; fully fail-open.
        if (memoryOn) {
          try {
            await memory.capture(reviewed, runtimeOptions);
          } catch (_) {
            /* memory capture is best-effort — never fail a completed run */
          }
        }
        return reviewed;
      } catch (error) {
        const wrapped = wrapExecutionError(definition.label, error);
        if (routingMetrics && wrapped && !wrapped.skillRouterMetrics) {
          wrapped.skillRouterMetrics = routingMetrics;
        }
        meterRun(options, wrapped);
        throw wrapped;
      }
    };

    if (options.trace === false) return execute();
    const invokeConfig = options.invokeConfig || {};
    const harness = runtimeRegistry.harnessLabel(runtime);
    const modelName = (options.llm && options.llm.model) || '';
    const attribution = options.attribution || {};
    const metadata = {
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
      workflow_pattern: workflowPattern,
      workflow_name: options.workflow || 'agent',
    };
    const tags = [
      ...new Set([
        ...(invokeConfig.tags || []),
        ...(options.tags || []),
        `runtime:${runtime}`,
        `harness:${harness}`,
        `pattern:${workflowPattern}`,
        ...(modelName ? [`model:${modelName}`] : []),
        // One shared Langfuse project: tenancy is a dimension, not a partition.
        ...(attribution.orgId ? [`org:${attribution.orgId}`] : []),
        ...(attribution.projectId ? [`project:${attribution.projectId}`] : []),
      ]),
    ];
    let traceId = null;
    const traceRun = options.traceRun || langfuse.traceAgentRun;
    const result = await traceRun(
      {
        name: String(invokeConfig.runName || `agent-runtime:${runtime}`).slice(0, 200),
        traceName: options.workflow || `agent-runtime:${runtime}`,
        input: String(prompt).slice(0, 20_000),
        metadata,
        tags,
        userId: attribution.userId || null,
        // The caller-supplied run session groups every observation of one planner
        // or coder job; the harness's own conversation id rides in the output.
        sessionId: invokeConfig.metadata && invokeConfig.metadata.session_id
          ? invokeConfig.metadata.session_id
          : attribution.taskId || null,
        model: modelName,
        llm: options.llm,
        describe: traceDetail,
        onTraceId: (id) => {
          traceId = id;
        },
      },
      execute
    );
    if (traceId && result && typeof result === 'object') result.traceId = traceId;
    return result;
  };
}

/**
 * Map a normalized execution (or a wrapped failure) onto Langfuse trace fields:
 * the public view of the result as output, the contract's usage/cost metadata for
 * search, and structured usage/cost on the generation child for Langfuse's own
 * cost accounting.
 */
function traceDetail(value) {
  const failed = value instanceof Error;
  const usage = value && value.usage;
  return {
    ...(!failed ? { output: publicExecution(value) } : {}),
    metadata: traceMetadata(value),
    ...(usage ? { usageDetails: usageDetails(usage) } : {}),
    ...(() => {
      const cost = value && value.costUsd;
      return Number.isFinite(cost) && cost >= 0 ? { costDetails: { total: cost } } : {};
    })(),
  };
}

function usageDetails(usage) {
  const map = [
    ['input', 'inputTokens'],
    ['output', 'outputTokens'],
    ['total', 'totalTokens'],
    ['cache_read_input_tokens', 'cachedInputTokens'],
    ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
    ['reasoning', 'reasoningOutputTokens'],
  ];
  const details = {};
  for (const [key, field] of map) {
    // normalizeUsage reports a dimension as a finite number or null — null must
    // stay absent, or Langfuse books unreported dimensions as zero usage.
    const value = usage[field];
    if (Number.isFinite(value)) details[key] = value;
  }
  return details;
}

const executeAgentRuntime = createRuntimeDispatcher(registry);

module.exports = { executeAgentRuntime, createRuntimeDispatcher };
