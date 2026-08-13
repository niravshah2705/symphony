'use strict';

/**
 * DeepAgent harness — provider-neutral LangGraph/`deepagents` construction and
 * execution. SDK-specific backend, safe-read, filesystem-argument middleware,
 * model, skill and tool wiring live here; framework.js retains compatibility
 * wrappers and generic workflow/scratch orchestration.
 */

const { createChatModel } = require('../llm');
const toolRegistry = require('../tools');
const { installSafeRead } = require('../safe-read');
const { createFsArgNormalizerMiddleware } = require('../fs-arg-normalizer');
const { buildSafeAgentEnv } = require('../repository-broker');
const { applyPolicyToWorkflow, filterSkillPaths } = require('../settings-policy');
const registry = require('./registry');
const { AgentRuntimeError, deepAgentUsage, deepAgentCost } = require('./contract');

/** Build the DeepAgent backend for a workflow kind, rooted at `rootDir`. */
function buildBackend(kind, rootDir, opts = {}, deps = {}) {
  const deepagents = deps.deepagents || require('deepagents');
  const { FilesystemBackend, LocalShellBackend } = deepagents;
  if (kind === 'shell') {
    // The shell never inherits the service environment. Re-sanitize even an
    // explicitly supplied env so repository/API credentials cannot reach agent
    // commands through a future caller by mistake.
    const env = buildSafeAgentEnv(opts.env || process.env, rootDir);
    return new LocalShellBackend({ rootDir, env, inheritEnv: false, timeout: opts.timeout || 600 });
  }
  return new FilesystemBackend({ rootDir });
}

/**
 * Build a DeepAgent from a workflow. `deps.installSkills` is supplied by the
 * generic framework wrapper when a caller provides only a root directory. It
 * stays injected here to avoid a deepagent↔framework module cycle.
 */
function buildAgent({ workflow, llm, backend, skillPaths, rootDir, ctx = {}, extraTools = [], env }, deps = {}) {
  const deepagents = deps.deepagents || require('deepagents');
  const makeChatModel = deps.createChatModel || createChatModel;
  const install = deps.installSkills;
  let skills = skillPaths;
  let be = backend;
  if (!be) {
    if (!rootDir) throw new Error('buildAgent needs a backend or a rootDir.');
    if (!skills) {
      if (typeof install !== 'function') {
        throw new Error('buildAgent needs installSkills when skill paths are not prepared.');
      }
      skills = install(rootDir, workflow.skills);
    }
    be = buildBackend(
      workflow.backend,
      rootDir,
      { timeout: workflow.shellTimeoutSec, env },
      { deepagents },
    );
  }

  // Guard read_file against Anthropic's content-block rules: unrecognized or
  // binary files must not be sent as non-PDF `document` blocks.
  be = installSafeRead(be);
  const effective = ctx.effectivePolicy;
  const effectiveWorkflow = applyPolicyToWorkflow(workflow, effective, {
    toolDomains: toolRegistry.TOOL_DOMAIN,
  });
  skills = filterSkillPaths(skills, effective);
  const tools = [...toolRegistry.buildMany(effectiveWorkflow.tools, ctx), ...(extraTools || [])];
  const systemPrompt = typeof workflow.systemPrompt === 'function'
    ? workflow.systemPrompt(ctx)
    : workflow.systemPrompt;

  // Repair mis-keyed filesystem calls before schema validation. A single
  // `read_file({ path })` typo must not abort the entire graph execution.
  const middleware = [createFsArgNormalizerMiddleware()];
  const agent = deepagents.createDeepAgent({
    model: makeChatModel(llm),
    backend: be,
    skills,
    tools,
    systemPrompt,
    middleware,
    permissions: Array.isArray(effectiveWorkflow.permissions) ? effectiveWorkflow.permissions : [],
  });
  return { agent, backend: be, skillPaths: skills, tools };
}

async function executeDeepAgent(options, prompt) {
  if (typeof options.deepAgentInvoke !== 'function') {
    throw new AgentRuntimeError('DeepAgent runtime was selected without a prepared agent.', 'runtime_not_prepared', 500);
  }
  const result = await options.deepAgentInvoke(prompt, options.invokeConfig || {});
  const messages = (result && result.messages) || [];
  return {
    runtime: 'deepagent',
    provider: options.llm && options.llm.provider,
    model: options.llm && options.llm.model,
    workflowPattern: options.workflowPattern,
    result,
    messages,
    finalText: options.lastText ? options.lastText(result) : '',
    usage: deepAgentUsage(messages),
    costUsd: deepAgentCost(messages),
    sessionId: null,
  };
}

registry.register(registry.builtinDefinition('deepagent', () => executeDeepAgent));

module.exports = { buildBackend, buildAgent, executeDeepAgent };
