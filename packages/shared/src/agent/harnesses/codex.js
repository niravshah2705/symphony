'use strict';

/**
 * Codex SDK harness (`@openai/codex-sdk`). Runs the hosted Codex/OpenAI model
 * slot. SECURITY-CRITICAL: the ChatGPT auth cache is written to an ephemeral,
 * 0700 home that is always removed after the run (secret-leakage), the app
 * refresh token is never staged into that file (token-cache-revocation), and
 * the CLI subprocess env excludes all TOKEN / KEY / SECRET names.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CONFIG } = require('../../config');
const { buildSafeAgentEnv } = require('../repository-broker');
const registry = require('./registry');
const {
  AgentRuntimeError,
  loadSdk,
  assertWorkingDirectory,
  cleanSystemPrompt,
  reasoningEffort,
  plannerWebSearchAllowed,
  normalizeUsage,
  assistantMessagesFromText,
  wrapExecutionError,
} = require('./contract');

const ID = 'codex-sdk';
const LABEL = 'Codex SDK';
const PACKAGE = '@openai/codex-sdk';

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
  const sdk = await loadSdk({ id: ID, label: LABEL, packageName: PACKAGE, loaders: options.loaders, importer: () => import('@openai/codex-sdk') });
  if (!sdk || typeof sdk.Codex !== 'function') {
    throw new AgentRuntimeError('The installed Codex SDK does not export Codex.', 'runtime_unavailable', 503);
  }
  const cwd = assertWorkingDirectory(options.rootDir);
  // In include-SDK proxy mode the agent has no real ChatGPT tokens (accessToken
  // is a sentinel, authTokens null), so the auth.json path can't be used. Route
  // the ChatGPT backend through the proxy's /codex prefix with the sentinel via
  // the base-URL client path instead (the proxy injects the real bearer +
  // account id). Best-effort: verify against your installed @openai/codex-sdk.
  const proxySdk = Boolean(CONFIG.EGRESS_PROXY_INCLUDE_SDK);
  const chatgptAuth = options.llm.backend === 'chatgpt' && !proxySdk;
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
      runtime: ID,
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
    throw wrapExecutionError(LABEL, error);
  } finally {
    if (ephemeralAuth) ephemeralAuth.cleanup();
  }
}

registry.register({
  id: ID,
  label: LABEL,
  harnessName: 'codex',
  packageName: PACKAGE,
  requiresProvider: 'codex',
  capabilities: { coding: true, planning: true, streaming: false, subagents: false },
  createExecutor: () => executeCodex,
});

module.exports = { executeCodex, prepareCodexChatgptHome };
