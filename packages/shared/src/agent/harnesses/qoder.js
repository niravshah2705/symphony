'use strict';

/**
 * Qoder Agent SDK harness (`@qoder-ai/qoder-agent-sdk`). Drives qodercli over the
 * SDK's Claude-Code-compatible surface (query/assistant/result messages, tool
 * allow-list, canUseTool guard).
 *
 * SECURITY: the personal access token is a raw credential the egress sidecar
 * cannot broker (qodercli owns its own endpoint discovery and login), so this
 * harness refuses to run in proxy mode rather than hold a secret the coder could
 * read. When it does run (trusted local profile), the run is isolated: the token
 * is handed to a daemon started for THIS run only — never the process-wide
 * default daemon another tenant's run could share — under the workspace-scoped
 * HOME from buildSafeAgentEnv, and always stopped afterwards. Because the
 * credential lives in the subprocess environment, `Bash` is denied and every
 * file tool is confined to the prepared workspace.
 */

const { CONFIG } = require('../../config');
const { buildSafeAgentEnv } = require('../repository-broker');
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
  resolveAndRouteSkills,
} = require('./contract');

const ID = 'qoder-sdk';
const LABEL = 'Qoder Agent SDK';
const PACKAGE = '@qoder-ai/qoder-agent-sdk';

/** Restrict Qoder tools to the prepared workspace and keep the PAT out of Bash. */
function qoderPermissionGuard(cwd, carriesCredential) {
  return async (toolName, input) => {
    if (carriesCredential && toolName === 'Bash') {
      return {
        behavior: 'deny',
        message: 'Bash is disabled for this run because Qoder authentication is held in the subprocess environment.',
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

/**
 * Start a daemon scoped to this run so the credential is never installed on the
 * process-wide daemon. Returns null on SDKs without the daemon surface, in which
 * case `query()` owns (and authenticates) the default daemon.
 */
async function startRunDaemon(sdk, { accessToken, cliPath, env }) {
  if (typeof sdk.startDaemon !== 'function' || typeof sdk.accessToken !== 'function') return null;
  const daemon = await sdk.startDaemon({
    auth: sdk.accessToken(accessToken),
    env,
    ...(cliPath ? { pathToQoderCLIExecutable: cliPath } : {}),
  });
  return daemon || null;
}

async function stopRunDaemon(daemon) {
  if (!daemon || typeof daemon.stop !== 'function') return;
  try {
    await daemon.stop();
  } catch (_) {
    // Cleanup must never replace the run's result or error.
  }
}

async function executeQoder(options, prompt) {
  if (!options.llm || options.llm.provider !== 'qoder') {
    throw new AgentRuntimeError(
      'Qoder Agent SDK requires the Qoder model slot.',
      'runtime_provider_mismatch',
      400
    );
  }
  // The sidecar cannot broker qodercli's own control plane, and an agent
  // container must never hold a raw third-party credential. Fail closed.
  if (CONFIG.EGRESS_PROXY_URL) {
    throw new AgentRuntimeError(
      'Qoder Agent SDK cannot run with egress isolation enabled: the sidecar cannot broker the qodercli endpoint. Use DeepAgent or a proxy-brokered SDK harness.',
      'runtime_unavailable',
      503
    );
  }
  const accessToken = String(options.llm.accessToken || '');
  if (!accessToken) {
    throw new AgentRuntimeError(
      'Qoder Agent SDK authentication is unavailable. Add your Qoder Personal Access Token in Settings → LLM and try again.',
      'runtime_auth_unavailable',
      401
    );
  }
  const sdk = await loadSdk({ id: ID, label: LABEL, packageName: PACKAGE, loaders: options.loaders, importer: () => import('@qoder-ai/qoder-agent-sdk') });
  if (!sdk || typeof sdk.query !== 'function') {
    throw new AgentRuntimeError('The installed Qoder Agent SDK does not export query.', 'runtime_unavailable', 503);
  }
  const cwd = assertWorkingDirectory(options.rootDir);
  const env = buildSafeAgentEnv(options.env || process.env, cwd);
  const sdkTools = options.backendKind === 'filesystem'
    ? ['Read', 'Glob', 'Grep', ...(plannerWebSearchAllowed(options) ? ['WebSearch'] : [])]
    : ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
  if (options.workflowPattern === 'parallel' || options.workflowPattern === 'supervisor') {
    sdkTools.push('Agent');
  }

  const { selectedSkillPaths, routingMetrics } = await resolveAndRouteSkills(
    { ...options, rootDir: cwd },
    prompt,
  );

  const auth = typeof sdk.accessToken === 'function' ? sdk.accessToken(accessToken) : { type: 'accessToken', accessToken };
  const baseQueryOptions = {
    cwd,
    env,
    model: options.llm.model || CONFIG.QODER.defaultModel,
    maxTurns: Number(options.maxTurns) || 24,
    systemPrompt: cleanSystemPrompt(options.systemPrompt, options.ctx) || undefined,
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    tools: sdkTools,
    permissionMode: 'default',
    canUseTool: qoderPermissionGuard(cwd, true),
  };

  const messages = [];
  let outcome = null;
  let daemon = null;
  try {
    daemon = await startRunDaemon(sdk, {
      accessToken,
      cliPath: options.llm.cliPath || CONFIG.QODER.cliPath,
      env,
    });
    // A run-scoped daemon already carries the credential; `options.auth` is only
    // required when query() has to start the default daemon itself.
    const query = sdk.query({
      prompt,
      options: daemon
        ? { ...baseQueryOptions, daemon }
        : { ...baseQueryOptions, auth },
    });
    for await (const message of query) {
      messages.push(message);
      if (message && message.type === 'result') outcome = message;
      if (typeof options.onEvent === 'function') options.onEvent(message);
    }
  } catch (error) {
    throw wrapExecutionError(LABEL, error);
  } finally {
    await stopRunDaemon(daemon);
  }
  if (!outcome) {
    throw new AgentRuntimeError('Qoder Agent SDK ended without a result message.', 'runtime_incomplete', 502);
  }
  if (outcome.is_error || outcome.subtype !== 'success') {
    throw new AgentRuntimeError(
      `Qoder Agent SDK did not complete (${outcome.subtype || 'unknown result'}).`,
      'runtime_execution_failed',
      502,
      { usage: normalizeUsage(outcome.usage), costUsd: finiteNumber(outcome.total_cost_usd) }
    );
  }
  return {
    runtime: ID,
    provider: 'qoder',
    model: options.llm.model,
    workflowPattern: options.workflowPattern,
    result: outcome,
    messages,
    finalText: String(outcome.result || ''),
    usage: normalizeUsage(outcome.usage),
    costUsd: finiteNumber(outcome.total_cost_usd),
    sessionId: outcome.session_id || null,
    skillRouterMetrics: routingMetrics,
    skillPaths: selectedSkillPaths,
  };
}

registry.register(registry.builtinDefinition(ID, () => executeQoder));

module.exports = { executeQoder, qoderPermissionGuard };
