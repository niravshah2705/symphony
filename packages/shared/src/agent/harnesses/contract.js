'use strict';

/**
 * Harness contract — the SDK-free primitives every harness module shares:
 * the result-contract helpers, usage/cost normalization, workflow-pattern
 * application, trace metadata, rubric middleware, and the generic SDK loader.
 *
 * This module has NO agent-SDK dependency and MUST NOT require the registry
 * (registry.js requires this — a cycle would break both). Executors and the
 * dispatcher compose these helpers; the registry owns definitions/labels.
 */

const fs = require('fs');
const path = require('path');
const { getCurrentRunTree } = require('langsmith/traceable');
const { PATTERNS, patternId } = require('../workflow-patterns');
const { cleanList } = require('../trace-annotations');

/**
 * Workflow patterns are deliberately runtime-neutral. The selected pattern is
 * expressed as trusted orchestration guidance before the task. A single SDK
 * session remains responsible for tool ordering, which avoids concurrent
 * writers corrupting one coding workspace while still letting capable SDKs use
 * their own subagents/parallel tool execution.
 */
const WORKFLOW_PATTERNS = Object.freeze({
  sequential: Object.freeze({
    id: 'sequential',
    label: 'Sequential',
    directive: '', // exact backwards-compatible prompt
  }),
  parallel: Object.freeze({
    id: 'parallel',
    label: 'Parallel workstreams',
    directive:
      'Split independent investigation or validation work into parallel workstreams when the runtime supports it. ' +
      'Never let two workers edit the same file or mutate the same repository state concurrently; synthesize their findings before editing.',
  }),
  evaluator: Object.freeze({
    id: 'evaluator',
    label: 'Generator + evaluator',
    directive:
      'Use a generator-evaluator loop: produce a candidate, evaluate it against the task acceptance criteria, repair concrete gaps, then validate the final result.',
  }),
  supervisor: Object.freeze({
    id: 'supervisor',
    label: 'Supervisor',
    directive:
      'Act as a supervisor: decompose the task into bounded specialist work, review each result before accepting it, and integrate only verified changes into the final outcome.',
  }),
});

class AgentRuntimeError extends Error {
  constructor(message, code = 'agent_runtime_error', status = 502, details = {}) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function normalizeWorkflowPattern(value, { strict = false } = {}) {
  const requested = value === undefined || value === null || value === '' ? 'sequential' : value;
  const id = patternId(requested);
  if (id && Object.prototype.hasOwnProperty.call(WORKFLOW_PATTERNS, id)) return id;
  if (strict) {
    throw new AgentRuntimeError(
      `Workflow pattern must be one of: ${Object.keys(WORKFLOW_PATTERNS).join(', ')}.`,
      'invalid_workflow_pattern',
      400
    );
  }
  return 'sequential';
}

function workflowPatternCatalog() {
  return PATTERNS.map(({ id, label }) => ({ id, label }));
}

function applyWorkflowPattern(prompt, value) {
  const pattern = normalizeWorkflowPattern(value, { strict: true });
  const directive = WORKFLOW_PATTERNS[pattern].directive;
  if (!directive) return String(prompt || '');
  return [
    `<workflow_pattern id="${pattern}">`,
    directive,
    '</workflow_pattern>',
    '',
    String(prompt || ''),
  ].join('\n');
}

function cleanSystemPrompt(systemPrompt, ctx) {
  const value = typeof systemPrompt === 'function' ? systemPrompt(ctx || {}) : systemPrompt;
  return String(value || '').trim();
}

function assertWorkingDirectory(value) {
  const cwd = path.resolve(value || process.cwd());
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch (_) {
    throw new AgentRuntimeError(`Agent working directory does not exist: ${cwd}`, 'invalid_working_directory', 400);
  }
  if (!stat.isDirectory()) {
    throw new AgentRuntimeError(`Agent working directory is not a directory: ${cwd}`, 'invalid_working_directory', 400);
  }
  return cwd;
}

function optionalPackageError(label, packageName, error) {
  const suffix = error && error.code === 'ERR_MODULE_NOT_FOUND'
    ? ` Install ${packageName} in @ai-fleet/shared and restart the service.`
    : '';
  return new AgentRuntimeError(
    `${label} is unavailable.${suffix}`,
    'runtime_unavailable',
    503,
    { cause: error }
  );
}

/**
 * Lazy-load a harness's SDK. A test/caller-supplied `loaders[id]` wins (used to
 * inject a fake SDK); otherwise `importer()` performs the real dynamic import so
 * a partial install fails with a useful operator diagnostic instead of silently
 * falling back to another provider.
 */
async function loadSdk({ id, label, packageName, importer, loaders = {} }) {
  const custom = loaders && loaders[id];
  if (typeof custom === 'function') return custom();
  try {
    return await importer();
  } catch (error) {
    throw optionalPackageError(label, packageName, error);
  }
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const inputTokens = finiteNumber(value.inputTokens ?? value.input_tokens);
  const outputTokens = finiteNumber(value.outputTokens ?? value.output_tokens);
  const cachedInputTokens = finiteNumber(
    value.cachedInputTokens ?? value.cached_input_tokens ?? value.cacheReadInputTokens ?? value.cache_read_input_tokens
  );
  const cacheCreationInputTokens = finiteNumber(
    value.cacheCreationInputTokens ?? value.cache_creation_input_tokens
  );
  const reasoningOutputTokens = finiteNumber(value.reasoningOutputTokens ?? value.reasoning_output_tokens);
  const reportedTotal = finiteNumber(value.totalTokens ?? value.total_tokens);
  const totalTokens = reportedTotal ?? (
    inputTokens !== null || outputTokens !== null
      ? (inputTokens || 0) + (outputTokens || 0)
      : null
  );
  if (
    inputTokens === null && outputTokens === null && cachedInputTokens === null &&
    cacheCreationInputTokens === null && reasoningOutputTokens === null && totalTokens === null
  ) return null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function mergeUsage(target, source) {
  if (!source) return target;
  const next = target || {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  for (const key of Object.keys(next)) next[key] += source[key] || 0;
  return next;
}

function deepAgentUsage(messages) {
  let usage = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    usage = mergeUsage(usage, normalizeUsage(message && (message.usage_metadata || message.usage)));
  }
  return usage;
}

function deepAgentCost(messages) {
  let total = 0;
  let found = false;
  for (const message of Array.isArray(messages) ? messages : []) {
    const metadata = (message && (message.usage_metadata || message.response_metadata)) || {};
    const value = finiteNumber(metadata.total_cost_usd ?? metadata.cost_usd ?? metadata.cost);
    if (value !== null) {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

function assistantMessagesFromText(text) {
  return text ? [{ role: 'assistant', content: text }] : [];
}

function publicExecution(result) {
  return {
    runtime: result.runtime,
    provider: result.provider,
    model: result.model,
    workflowPattern: result.workflowPattern,
    finalText: String(result.finalText || '').slice(0, 20_000),
    usage: result.usage,
    costUsd: result.costUsd,
    costAvailable: result.costUsd !== null,
    sessionId: result.sessionId || null,
    ...(result.review ? { review: result.review } : {}),
  };
}

function addCost(a, b) {
  const x = finiteNumber(a);
  const y = finiteNumber(b);
  if (x === null && y === null) return null;
  return (x || 0) + (y || 0);
}

/**
 * Apply the RubricMiddleware to a finished run. When a caller supplies a
 * `rubric` (or a prebuilt `rubricMiddleware`), the middleware grades the output
 * against the checklist and — on `needs_revision` — re-runs the SAME runtime
 * with the per-criterion gaps appended, up to its iteration cap. This is what
 * makes the review work for every SDK: `runOnce` re-invokes whichever runtime
 * produced the run.
 *
 * Usage/cost from every (re-)run accumulate onto the returned value so the one
 * trace span reflects all iterations. Fail-open: the middleware never throws,
 * and this backstop guarantees a grader defect can never fail a completed run.
 *
 * @param {(prompt:string)=>Promise<object>} runOnce re-invokes the runtime executor
 */
async function applyRubricMiddleware(options, value, prompt, runOnce) {
  const rubricLib = require('../rubric-middleware');
  const middleware = options.rubricMiddleware && typeof options.rubricMiddleware.run === 'function'
    ? options.rubricMiddleware
    : rubricLib.createRubricMiddleware({ rubric: options.rubric, ...(options.rubricOptions || {}) });

  let accUsage = value.usage ? { ...value.usage } : null;
  let accCost = value.costUsd;
  const runAgent = async (revisionPrompt) => {
    const next = await runOnce(revisionPrompt);
    accUsage = mergeUsage(accUsage, next.usage);
    accCost = addCost(accCost, next.costUsd);
    return next;
  };

  let review;
  try {
    review = await middleware.run({
      rubric: options.rubric,
      task: options.prompt,
      output: value,
      basePrompt: prompt,
      runAgent,
      settings: options.settings,
      signal: options.signal,
    });
  } catch (error) {
    review = rubricLib.failedReview(options.rubric, error);
  }

  // A re-run's result is authoritative; carry the accumulated usage/cost onto it.
  const finalValue = review.finalResult && review.finalResult !== value ? review.finalResult : value;
  finalValue.usage = accUsage;
  finalValue.costUsd = accCost;
  delete review.finalResult; // internal loop plumbing; not part of the public review
  finalValue.review = review;
  return finalValue;
}

function reviewMetadata(review) {
  if (!review) return {};
  const metadata = {
    rubric_reviewed: true,
    rubric_result: review.result,
    rubric_satisfied: Boolean(review.satisfied),
    rubric_iterations: review.iterations,
  };
  if (Array.isArray(review.unsatisfied) && review.unsatisfied.length) {
    metadata.rubric_unsatisfied = review.unsatisfied.length;
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// Actually-used resources (skills / tools / plugins)
//
// Derived post-run from the returned message history so one code path covers
// every runtime that streams tool calls (deepagent's LangGraph messages and the
// Claude Agent SDK's tool_use blocks). Codex/Antigravity carry no tool-call
// history, so they contribute nothing here and keep the configured-set stamp
// from the caller. NAMES ONLY — never tool args, results, prompts, or secrets.
// ---------------------------------------------------------------------------

/** Filesystem-read tool names whose path reveals which skill dir was consulted. */
const READ_TOOL_NAMES = new Set(['read_file', 'Read', 'read']);
/** `/.agent-skills/<name>/…` or `…/skills/<name>/…` → captures the skill name. */
const SKILL_PATH_RE = /(?:\.agent-skills|skills)[/\\]([^/\\]+)[/\\]/;

/** MCP tools are prefixed with `__` (server name); local tools never use `__`. */
function mcpServerFromToolName(name) {
  if (!name.includes('__')) return null;
  const parts = name.split('__').filter(Boolean);
  const server = parts[0] === 'mcp' ? parts[1] : parts[0];
  return server || null;
}

/**
 * Collect { name, args } for every tool call in a single message, tolerant of
 * the shapes emitted by the different SDKs:
 *  - LangGraph AIMessage: `tool_calls: [{ name, args }]`
 *  - OpenAI-style: `additional_kwargs.tool_calls: [{ function: { name, arguments } }]`
 *  - Claude Agent SDK: `{ message: { content: [{ type: 'tool_use', name, input }] } }`
 */
function toolCallsFromMessage(message) {
  if (!message || typeof message !== 'object') return [];
  const calls = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (call && call.name) calls.push({ name: String(call.name), args: call.args || {} });
    }
  }
  const legacy = message.additional_kwargs && message.additional_kwargs.tool_calls;
  if (Array.isArray(legacy)) {
    for (const call of legacy) {
      const fn = call && call.function;
      if (fn && fn.name) calls.push({ name: String(fn.name), args: fn.arguments || {} });
    }
  }
  const content = (message.message && message.message.content) || message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'tool_use' && block.name) {
        calls.push({ name: String(block.name), args: block.input || {} });
      }
    }
  }
  return calls;
}

/** The skill name a read tool consulted, or null for non-skill reads. */
function skillFromReadCall(call) {
  if (!READ_TOOL_NAMES.has(call.name)) return null;
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  const filePath = args.file_path || args.path || args.filePath;
  const match = typeof filePath === 'string' && filePath.match(SKILL_PATH_RE);
  return match ? match[1] : null;
}

/**
 * Derive the skills/tools/plugins a run actually exercised from its messages.
 * @returns {{ toolsUsed: string[], skillsUsed: string[], pluginsUsed: string[] }}
 */
function extractUsedResources(resultOrError) {
  const messages = resultOrError && Array.isArray(resultOrError.messages) ? resultOrError.messages : [];
  const tools = new Set();
  const skills = new Set();
  const plugins = new Set();
  for (const message of messages) {
    for (const call of toolCallsFromMessage(message)) {
      tools.add(call.name);
      const server = mcpServerFromToolName(call.name);
      if (server) plugins.add(server);
      const skill = skillFromReadCall(call);
      if (skill) skills.add(skill);
    }
  }
  return {
    toolsUsed: cleanList([...tools]),
    skillsUsed: cleanList([...skills]),
    pluginsUsed: cleanList([...plugins]),
  };
}

/** Trace-metadata fragment for actually-used resources (omits empty categories). */
function usedResourceMetadata(resultOrError) {
  const { toolsUsed, skillsUsed, pluginsUsed } = extractUsedResources(resultOrError);
  const metadata = {};
  if (toolsUsed.length) {
    metadata.tools_used = toolsUsed;
    metadata.tools_used_count = toolsUsed.length;
  }
  if (skillsUsed.length) {
    metadata.skills_used = skillsUsed;
    metadata.skills_used_count = skillsUsed.length;
  }
  if (pluginsUsed.length) {
    metadata.plugins_used = pluginsUsed;
    metadata.plugins_used_count = pluginsUsed.length;
  }
  return metadata;
}

function traceMetadata(resultOrError) {
  const usage = resultOrError && resultOrError.usage;
  const costUsd = finiteNumber(resultOrError && resultOrError.costUsd);
  const metadata = {
    usage_available: Boolean(usage),
    cost_available: costUsd !== null,
  };
  if (usage) {
    metadata.usage_metadata = {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      ...(costUsd !== null ? { total_cost: costUsd } : {}),
    };
    metadata.usage_input_tokens = usage.inputTokens;
    metadata.usage_output_tokens = usage.outputTokens;
    metadata.usage_total_tokens = usage.totalTokens;
    metadata.usage_cached_input_tokens = usage.cachedInputTokens;
    metadata.usage_reasoning_output_tokens = usage.reasoningOutputTokens;
  }
  if (costUsd !== null) metadata.cost_usd = costUsd;
  return {
    ...metadata,
    ...usedResourceMetadata(resultOrError),
    ...reviewMetadata(resultOrError && resultOrError.review),
  };
}

function langSmithProvider(llm) {
  const provider = llm && llm.provider;
  if (provider === 'codex') return 'openai';
  if (provider === 'claude') return 'anthropic';
  if (provider === 'antigravity') return 'google';
  if (provider === 'lmstudio' || provider === 'omlx' || provider === 'huggingface') return 'openai';
  return provider || 'unknown';
}

function annotateTrace(resultOrError, currentRun = getCurrentRunTree) {
  try {
    const current = currentRun();
    current.metadata = { ...(current.metadata || {}), ...traceMetadata(resultOrError) };
  } catch (_) {
    // No active LangSmith context (tracing disabled) is a normal deployment.
  }
}

function wrapExecutionError(label, error) {
  if (error instanceof AgentRuntimeError) return error;
  const message = error && error.message ? String(error.message).replace(/\s+/g, ' ').slice(0, 500) : 'Unknown SDK error.';
  return new AgentRuntimeError(
    `${label} execution failed: ${message}`,
    'runtime_execution_failed',
    502,
    {
      cause: error,
      usage: error && error.usage,
      costUsd: finiteNumber(error && error.costUsd),
    }
  );
}

function reasoningEffort(value) {
  const effort = String(value || '').toLowerCase();
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : undefined;
}

function plannerWebSearchAllowed(options) {
  return options && options.workflow === 'planning' && options.backendKind === 'filesystem';
}

function safePathIn(cwd, candidate) {
  if (typeof candidate !== 'string' || !candidate) return true;
  const root = fs.realpathSync(cwd);
  // Resolve from the caller-visible cwd first. On macOS /var and /private/var
  // can name the same directory; comparing a real root with an unresolved
  // absolute candidate would incorrectly reject that harmless alias.
  const resolved = path.resolve(cwd, candidate);

  // Resolve the deepest existing ancestor as well. A repository may contain a
  // symlink whose lexical path is inside the workspace but whose target is not.
  // This covers both reads of an existing symlink and writes below one.
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  let realExisting;
  try {
    realExisting = fs.realpathSync(existing);
  } catch (_) {
    return false;
  }
  const realRelative = path.relative(root, realExisting);
  return realRelative !== '..' && !realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative);
}

/**
 * Persist first-party usage metering for a finished run (success or error). This
 * is the single choke point where every SDK's { usage, costUsd } result returns,
 * so it is the one place billing meters a run. Opt-in: only runs whose caller
 * supplied `options.attribution` are metered (so nested/utility sub-runs don't
 * double-count). Fail-open + lazy-required — billing must never break a run.
 */
function meterRun(options, resultOrError) {
  try {
    if (!options || !options.attribution) return;
    require('../../billing/usage').recordUsage(options.attribution, resultOrError || {}, options.llm || {});
  } catch (_) {
    /* metering is best-effort */
  }
}

module.exports = {
  WORKFLOW_PATTERNS,
  AgentRuntimeError,
  normalizeWorkflowPattern,
  workflowPatternCatalog,
  applyWorkflowPattern,
  cleanSystemPrompt,
  assertWorkingDirectory,
  optionalPackageError,
  loadSdk,
  finiteNumber,
  normalizeUsage,
  mergeUsage,
  deepAgentUsage,
  deepAgentCost,
  assistantMessagesFromText,
  publicExecution,
  addCost,
  applyRubricMiddleware,
  reviewMetadata,
  extractUsedResources,
  usedResourceMetadata,
  traceMetadata,
  langSmithProvider,
  annotateTrace,
  wrapExecutionError,
  reasoningEffort,
  plannerWebSearchAllowed,
  safePathIn,
  meterRun,
};
