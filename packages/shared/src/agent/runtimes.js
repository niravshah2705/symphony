'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { traceable, getCurrentRunTree } = require('langsmith/traceable');
const { buildSafeAgentEnv } = require('./repository-broker');
const { PATTERNS, patternId } = require('./workflow-patterns');

/**
 * Provider-neutral agent-runtime registry.
 *
 * `deepagent` keeps the existing LangGraph/deepagents execution path. The two
 * SDK runtimes are loaded lazily so a deployment can keep using the default
 * without paying their startup cost, and so a partial installation fails with
 * a useful operator diagnostic instead of falling back to another provider.
 */
const RUNTIMES = Object.freeze({
  deepagent: Object.freeze({ id: 'deepagent', label: 'DeepAgent', packageName: 'deepagents' }),
  'codex-sdk': Object.freeze({ id: 'codex-sdk', label: 'Codex SDK', packageName: '@openai/codex-sdk' }),
  'claude-agent-sdk': Object.freeze({
    id: 'claude-agent-sdk',
    label: 'Claude Agent SDK',
    packageName: '@anthropic-ai/claude-agent-sdk',
  }),
});

/**
 * Short, operator-facing "harness" names for each runtime id. These are the
 * values surfaced on LangSmith traces (as the `harness:` tag) and in the
 * Settings UI, kept stable and friendlier than the internal runtime ids.
 */
const HARNESS_LABELS = Object.freeze({
  deepagent: 'deepagent',
  'codex-sdk': 'codex',
  'claude-agent-sdk': 'claudecode',
});

/** Friendly harness name for a runtime id (falls back to the id itself). */
function harnessLabel(runtime) {
  return HARNESS_LABELS[runtime] || runtime;
}

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

function normalizeAgentRuntime(value, { strict = false } = {}) {
  const id = String(value || 'deepagent').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(RUNTIMES, id)) return id;
  if (strict) {
    throw new AgentRuntimeError(
      `Agent runtime must be one of: ${Object.keys(RUNTIMES).join(', ')}.`,
      'invalid_agent_runtime',
      400
    );
  }
  return 'deepagent';
}

/**
 * A global SDK preference must not break roles routed to another provider
 * (notably XS/local coder tasks). In that case the prepared DeepAgent path is
 * the only provider-neutral execution path, so use it explicitly and surface
 * the requested/effective runtimes on the trace.
 */
function effectiveAgentRuntime(value, llm, { strict = false, workflow = '' } = {}) {
  const runtime = normalizeAgentRuntime(value, { strict });
  const provider = llm && llm.provider;
  // The unattended coding workflow requires the private Linear and scoped
  // repository-broker tools. Official SDK subprocesses deliberately never
  // receive those application credentials, so keep this lifecycle on the
  // prepared DeepAgent path instead of running an SDK that cannot finish it.
  if (workflow === 'coding' && runtime !== 'deepagent') return 'deepagent';
  if (runtime === 'codex-sdk' && provider !== 'codex') return 'deepagent';
  if (runtime === 'claude-agent-sdk' && provider !== 'claude') return 'deepagent';
  return runtime;
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

function runtimeCatalog() {
  return Object.values(RUNTIMES).map(({ id, label }) => ({ id, label }));
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

function removeEphemeralHome(home) {
  if (!home) return;
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch (_) {
    // Cleanup must not replace the SDK result/error. The home is uniquely
    // named and contains no application data beyond this one auth cache.
  }
}

/**
 * Seed the official file-backed Codex ChatGPT auth cache for one SDK run.
 * The SDK/CLI owns reading this file; application code never passes the OAuth
 * access token through the API-key option or logs the payload/path contents.
 */
function prepareCodexChatgptHome(llm, baseEnv) {
  const tokens = llm && llm.authTokens;
  const accessToken = String((tokens && tokens.accessToken) || '');
  const idToken = String((tokens && tokens.idToken) || '');
  const accountId = String((llm && llm.accountId) || '');
  if (!accessToken || !idToken || !accountId) {
    throw new AgentRuntimeError(
      'Codex ChatGPT authentication is incomplete. Sign in with Codex in Settings and try again.',
      'runtime_auth_unavailable',
      401
    );
  }

  let home = null;
  try {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'techsymphony-codex-home-'));
    fs.chmodSync(home, 0o700);
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { mode: 0o700 });
    fs.chmodSync(codexHome, 0o700);
    const authFile = path.join(codexHome, 'auth.json');
    const auth = {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        // Never stage the application's refresh token. A long SDK run could
        // rotate it inside this disposable file and leave the server-side
        // store holding a revoked value. Codex's schema accepts an empty
        // refresh string; this run uses the already-refreshed access token and
        // the next run resolves a fresh application token set again.
        refresh_token: '',
        account_id: accountId,
      },
      // resolveLlm has already refreshed the application token set when
      // needed. Mark this short-lived cache fresh so the CLI does not rotate a
      // refresh token into a file that is intentionally deleted after the run.
      last_refresh: new Date().toISOString(),
    };
    fs.writeFileSync(authFile, `${JSON.stringify(auth)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.chmodSync(authFile, 0o600);

    let cleaned = false;
    return {
      home,
      authFile,
      env: {
        ...baseEnv,
        HOME: home,
        CODEX_HOME: codexHome,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
      },
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        removeEphemeralHome(home);
      },
    };
  } catch (error) {
    removeEphemeralHome(home);
    if (error instanceof AgentRuntimeError) throw error;
    throw new AgentRuntimeError(
      'Could not prepare isolated Codex authentication for this run.',
      'runtime_auth_setup_failed',
      500,
      { cause: error }
    );
  }
}

function optionalPackageError(id, packageName, error) {
  const suffix = error && error.code === 'ERR_MODULE_NOT_FOUND'
    ? ` Install ${packageName} in @ai-fleet/shared and restart the service.`
    : '';
  return new AgentRuntimeError(
    `${RUNTIMES[id].label} is unavailable.${suffix}`,
    'runtime_unavailable',
    503,
    { cause: error }
  );
}

async function loadSdk(id, loaders = {}) {
  const custom = loaders[id];
  if (typeof custom === 'function') return custom();
  try {
    if (id === 'codex-sdk') return await import('@openai/codex-sdk');
    if (id === 'claude-agent-sdk') return await import('@anthropic-ai/claude-agent-sdk');
  } catch (error) {
    throw optionalPackageError(id, RUNTIMES[id].packageName, error);
  }
  throw new AgentRuntimeError(`No SDK loader is registered for ${id}.`, 'runtime_unavailable', 503);
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

/**
 * Provider-neutral task-completion review. When a caller supplies a `rubric`,
 * the finished run (any SDK) is scored against it by the rubric middleware.
 *
 * Fail-open by contract: the middleware itself never throws, but this backstop
 * guarantees a reviewer defect can never turn a completed run into a failure —
 * the run result is authoritative; the review is advisory metadata.
 */
async function runRubricReview(options, value) {
  const reviewer = typeof options.reviewer === 'function'
    ? options.reviewer
    : (args) => require('./rubric-middleware').reviewTaskCompletion(args);
  try {
    return await reviewer({
      rubric: options.rubric,
      task: options.prompt,
      execution: value,
      llm: options.llm,
      settings: options.settings,
      signal: options.signal,
    });
  } catch (error) {
    return require('./rubric-middleware').unavailableReview(options.rubric, error);
  }
}

function reviewMetadata(review) {
  if (!review) return {};
  const metadata = {
    rubric_reviewed: true,
    rubric_available: Boolean(review.available),
    rubric_verdict: review.verdict,
    rubric_passed: Boolean(review.passed),
  };
  if (finiteNumber(review.score) !== null) metadata.rubric_score = review.score;
  if (Array.isArray(review.unmetRequired) && review.unmetRequired.length) {
    metadata.rubric_unmet_required = review.unmetRequired.length;
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
  return { ...metadata, ...reviewMetadata(resultOrError && resultOrError.review) };
}

function langSmithProvider(llm) {
  const provider = llm && llm.provider;
  if (provider === 'codex') return 'openai';
  if (provider === 'claude') return 'anthropic';
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

function wrapExecutionError(runtime, error) {
  if (error instanceof AgentRuntimeError) return error;
  const message = error && error.message ? String(error.message).replace(/\s+/g, ' ').slice(0, 500) : 'Unknown SDK error.';
  return new AgentRuntimeError(
    `${RUNTIMES[runtime].label} execution failed: ${message}`,
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

async function executeCodex(options, prompt) {
  if (!options.llm || options.llm.provider !== 'codex') {
    throw new AgentRuntimeError(
      'Codex SDK requires the hosted Codex/OpenAI model slot.',
      'runtime_provider_mismatch',
      400
    );
  }
  if (!options.llm.accessToken) {
    throw new AgentRuntimeError(
      'Codex SDK authentication is unavailable. Sign in with Codex in Settings and try again.',
      'runtime_auth_unavailable',
      401
    );
  }
  const sdk = await loadSdk('codex-sdk', options.loaders);
  if (!sdk || typeof sdk.Codex !== 'function') {
    throw new AgentRuntimeError('The installed Codex SDK does not export Codex.', 'runtime_unavailable', 503);
  }
  const cwd = assertWorkingDirectory(options.rootDir);
  const chatgptAuth = options.llm.backend === 'chatgpt';
  let ephemeralAuth = null;
  try {
    let env = buildSafeAgentEnv(options.env || process.env, cwd);
    if (chatgptAuth) {
      ephemeralAuth = prepareCodexChatgptHome(options.llm, env);
      env = ephemeralAuth.env;
    }
    const systemPrompt = cleanSystemPrompt(options.systemPrompt, options.ctx);
    const config = {
      allow_login_shell: false,
      // Codex has no ThreadOptions.systemPrompt. Its documented
      // developer_instructions config is the authority-preserving channel for
      // trusted workflow rules; the turn input remains task data only.
      ...(systemPrompt ? { developer_instructions: systemPrompt } : {}),
      // The API backend makes the SDK inject CODEX_API_KEY into the CLI
      // process. Remove credentials again before any model-initiated command;
      // ChatGPT mode uses the isolated auth file above and the same deny list.
      shell_environment_policy: {
        inherit: 'core',
        ignore_default_excludes: false,
        exclude: [
          '*TOKEN*',
          '*KEY*',
          '*SECRET*',
          'CODEX_API_KEY',
          'OPENAI_API_KEY',
          'GH_TOKEN',
          'GITHUB_TOKEN',
          'GITLAB_TOKEN',
          'LINEAR_API_KEY',
          'LANGSMITH_API_KEY',
        ],
      },
      ...(chatgptAuth
        ? {
            cli_auth_credentials_store: 'file',
            forced_login_method: 'chatgpt',
            history: { persistence: 'none' },
          }
        : {}),
    };
    const clientOptions = { env, config };
    if (!chatgptAuth) {
      // Preserve the existing metered/custom API-backend behavior. These
      // fields must be absent (not merely undefined) for ChatGPT auth so the
      // SDK does not switch into CODEX_API_KEY mode.
      clientOptions.apiKey = options.llm.accessToken;
      if (options.llm.baseUrl) clientOptions.baseUrl = options.llm.baseUrl;
    }
    const client = new sdk.Codex(clientOptions);
    const thread = client.startThread({
      model: options.llm.model || undefined,
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      sandboxMode: options.backendKind === 'filesystem' ? 'read-only' : 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      // Planning already has an explicit web-research contract. Preserve that
      // capability for SDK runs while keeping network search off for coding and
      // every other workflow.
      webSearchMode: plannerWebSearchAllowed(options) ? 'live' : 'disabled',
      modelReasoningEffort: reasoningEffort(options.llm.reasoningEffort),
    });
    const turn = await thread.run(prompt, { signal: options.signal });
    const finalText = String((turn && turn.finalResponse) || '');
    return {
      runtime: 'codex-sdk',
      provider: 'codex',
      model: options.llm.model,
      workflowPattern: options.workflowPattern,
      result: turn,
      messages: assistantMessagesFromText(finalText),
      finalText,
      usage: normalizeUsage(turn && turn.usage),
      // Codex SDK currently exposes token usage but no billed USD amount.
      costUsd: null,
      sessionId: thread.id || null,
    };
  } catch (error) {
    throw wrapExecutionError('codex-sdk', error);
  } finally {
    if (ephemeralAuth) ephemeralAuth.cleanup();
  }
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
  const sdk = await loadSdk('claude-agent-sdk', options.loaders);
  if (!sdk || typeof sdk.query !== 'function') {
    throw new AgentRuntimeError('The installed Claude Agent SDK does not export query.', 'runtime_unavailable', 503);
  }
  const cwd = assertWorkingDirectory(options.rootDir);
  const env = buildSafeAgentEnv(options.env || process.env, cwd);
  const credential = String(options.llm.accessToken || '');
  if (credential) env.CLAUDE_CODE_OAUTH_TOKEN = credential;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'tech-symphony/1.0';
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
      model: options.llm.model || undefined,
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
    throw wrapExecutionError('claude-agent-sdk', error);
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
    runtime: 'claude-agent-sdk',
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

const EXECUTORS = Object.freeze({
  deepagent: executeDeepAgent,
  'codex-sdk': executeCodex,
  'claude-agent-sdk': executeClaude,
});

/**
 * Execute one workflow with a normalized result contract and one LangSmith root
 * span, regardless of the selected SDK. SDK-specific token/cost data is copied
 * into trace metadata and outputs for analytics.
 */
async function executeAgentRuntime(options = {}) {
  const requestedRuntime = normalizeAgentRuntime(options.runtime, { strict: true });
  const runtime = effectiveAgentRuntime(requestedRuntime, options.llm, {
    strict: true,
    workflow: options.workflow || '',
  });
  const workflowPattern = normalizeWorkflowPattern(options.workflowPattern, { strict: true });
  const prompt = applyWorkflowPattern(options.prompt, workflowPattern);
  const execute = async () => {
    try {
      const value = await EXECUTORS[runtime]({ ...options, runtime, workflowPattern }, prompt);
      if (options.rubric) value.review = await runRubricReview(options, value);
      annotateTrace(value, options.getCurrentRunTree || getCurrentRunTree);
      return value;
    } catch (error) {
      const wrapped = wrapExecutionError(runtime, error);
      annotateTrace(wrapped, options.getCurrentRunTree || getCurrentRunTree);
      throw wrapped;
    }
  };

  if (options.trace === false) return execute();
  const invokeConfig = options.invokeConfig || {};
  const harness = harnessLabel(runtime);
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

module.exports = {
  RUNTIMES,
  HARNESS_LABELS,
  harnessLabel,
  WORKFLOW_PATTERNS,
  AgentRuntimeError,
  normalizeAgentRuntime,
  effectiveAgentRuntime,
  normalizeWorkflowPattern,
  runtimeCatalog,
  workflowPatternCatalog,
  applyWorkflowPattern,
  normalizeUsage,
  deepAgentUsage,
  plannerWebSearchAllowed,
  executeAgentRuntime,
  // Exported for focused adapter tests; callers should use executeAgentRuntime.
  claudePermissionGuard,
};
