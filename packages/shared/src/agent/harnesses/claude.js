'use strict';

/**
 * Claude Agent SDK harness (`@anthropic-ai/claude-agent-sdk`). Runs the hosted
 * Claude model slot. SECURITY: when a credential is present the permission guard
 * denies `Bash` (the OAuth token lives in the subprocess env) and confines every
 * file tool to the prepared workspace via `safePathIn`.
 */

const { CONFIG } = require('../../config');
const { buildSafeAgentEnv } = require('../repository-broker');
const { wireModelId } = require('../llm');
const registry = require('./registry');
const {
  AgentRuntimeError,
  loadSdk,
  assertWorkingDirectory,
  cleanSystemPrompt,
  plannerWebSearchAllowed,
  normalizeUsage,
  finiteNumber,
  safePathIn,
  wrapExecutionError,
} = require('./contract');

const ID = 'claude-agent-sdk';
const LABEL = 'Claude Agent SDK';
const PACKAGE = '@anthropic-ai/claude-agent-sdk';

/** Restrict Claude tools to the prepared workspace and keep SDK auth out of Bash. */
function claudePermissionGuard(cwd, carriesCredential) {
  return async (toolName, input) => {
    if (carriesCredential && toolName === 'Bash') {
      return {
        behavior: 'deny',
        message: 'Bash is disabled for this run because SDK authentication is held in the subprocess environment.',
      };
    }
    for (const key of ['file_path', 'path', 'notebook_path']) {
      if (!safePathIn(cwd, input && input[key])) {
        return { behavior: 'deny', message: 'Tool access is limited to the prepared agent workspace.' };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

async function executeClaude(options, prompt) {
  if (!options.llm || options.llm.provider !== 'claude') {
    throw new AgentRuntimeError(
      'Claude Agent SDK requires the hosted Claude model slot.',
      'runtime_provider_mismatch',
      400
    );
  }
  if (!options.llm.accessToken) {
    throw new AgentRuntimeError(
      'Claude Agent SDK authentication is unavailable. Sign in with Claude in Settings and try again.',
      'runtime_auth_unavailable',
      401
    );
  }
  const sdk = await loadSdk({ id: ID, label: LABEL, packageName: PACKAGE, loaders: options.loaders, importer: () => import('@anthropic-ai/claude-agent-sdk') });
  if (!sdk || typeof sdk.query !== 'function') {
    throw new AgentRuntimeError('The installed Claude Agent SDK does not export query.', 'runtime_unavailable', 503);
  }
  const cwd = assertWorkingDirectory(options.rootDir);
  const env = buildSafeAgentEnv(options.env || process.env, cwd);
  const credential = String(options.llm.accessToken || '');
  const viaLlmGateway = options.llm.gateway === 'langsmith';
  if (credential) {
    // A LangSmith-gateway run authenticates with a plain Bearer credential
    // (ANTHROPIC_AUTH_TOKEN — the workspace key, or the sentinel in proxy
    // mode); the subscription path keeps the Claude Code OAuth env.
    if (viaLlmGateway) env.ANTHROPIC_AUTH_TOKEN = credential;
    else env.CLAUDE_CODE_OAUTH_TOKEN = credential;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'tech-symphony/1.0';
  // Route the SDK's Anthropic calls at the descriptor's base: the egress
  // proxy's /anthropic prefix (include-SDK mode), or the LangSmith gateway
  // (flagged run — its base already points at /llmgw when also proxied).
  if (CONFIG.EGRESS_PROXY_INCLUDE_SDK || viaLlmGateway) {
    env.ANTHROPIC_BASE_URL = options.llm.baseUrl || CONFIG.CLAUDE.baseUrl;
  }
  const sdkTools = options.backendKind === 'filesystem'
    ? ['Read', 'Glob', 'Grep', ...(plannerWebSearchAllowed(options) ? ['WebSearch'] : [])]
    : credential
      ? ['Read', 'Edit', 'Write', 'Glob', 'Grep']
      : ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];
  if (options.workflowPattern === 'parallel' || options.workflowPattern === 'supervisor') {
    sdkTools.push('Agent');
  }
  const messages = [];
  let outcome = null;
  const query = sdk.query({
    prompt,
    options: {
      cwd,
      env,
      model: wireModelId(options.llm) || undefined,
      maxTurns: Number(options.maxTurns) || 24,
      systemPrompt: cleanSystemPrompt(options.systemPrompt, options.ctx) || undefined,
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      tools: sdkTools,
      permissionMode: 'default',
      canUseTool: claudePermissionGuard(cwd, Boolean(credential)),
    },
  });
  try {
    for await (const message of query) {
      messages.push(message);
      if (message && message.type === 'result') outcome = message;
      if (typeof options.onEvent === 'function') options.onEvent(message);
    }
  } catch (error) {
    throw wrapExecutionError(LABEL, error);
  }
  if (!outcome) {
    throw new AgentRuntimeError('Claude Agent SDK ended without a result message.', 'runtime_incomplete', 502);
  }
  if (outcome.is_error || outcome.subtype !== 'success') {
    const error = new AgentRuntimeError(
      `Claude Agent SDK did not complete (${outcome.subtype || 'unknown result'}).`,
      'runtime_execution_failed',
      502,
      { usage: normalizeUsage(outcome.usage), costUsd: finiteNumber(outcome.total_cost_usd) }
    );
    throw error;
  }
  return {
    runtime: ID,
    provider: 'claude',
    model: options.llm.model,
    workflowPattern: options.workflowPattern,
    result: outcome,
    messages,
    finalText: String(outcome.result || ''),
    usage: normalizeUsage(outcome.usage),
    costUsd: finiteNumber(outcome.total_cost_usd),
    sessionId: outcome.session_id || null,
  };
}

registry.register(registry.builtinDefinition(ID, () => executeClaude));

module.exports = { executeClaude, claudePermissionGuard };
