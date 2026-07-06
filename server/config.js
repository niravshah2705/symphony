'use strict';

const path = require('path');

const PORT = Number(process.env.PORT) || 4000;

/**
 * Codex (OpenAI) OAuth provider configuration.
 *
 * SECURITY (oauth-oidc checklist): provider endpoint URLs (authorize/token/base)
 * and the client id are TRUSTED server-side config — they come from env vars or
 * the OpenAI Codex defaults and are NEVER accepted from a request body. Backend
 * auth flows must derive provider URLs from server-side trusted config, not from
 * user-controllable input. The browser can only choose a model name.
 *
 * The redirect URI is derived from THIS server's own fixed origin so the callback
 * is always served by us; it is compared exact-match on the callback.
 *
 * Defaults target OpenAI's "Sign in with ChatGPT" (Codex CLI public client). To
 * use your own OAuth client, override via env (CODEX_OAUTH_*). The redirect URI
 * you register with the provider must equal `${origin}/auth/callback`.
 */
const OAUTH = Object.freeze({
  authorizeUrl: process.env.CODEX_OAUTH_AUTHORIZE_URL || 'https://auth.openai.com/oauth/authorize',
  tokenUrl: process.env.CODEX_OAUTH_TOKEN_URL || 'https://auth.openai.com/oauth/token',
  clientId: process.env.CODEX_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann',
  scope: process.env.CODEX_OAUTH_SCOPE || 'openid profile email offline_access',
  // OpenAI-compatible chat endpoint the access token is used against.
  baseUrl: process.env.CODEX_OPENAI_BASE_URL || 'https://api.openai.com/v1',
  defaultModel: process.env.CODEX_OPENAI_MODEL || 'gpt-5-codex',
  /**
   * Codex request backend:
   *   'chatgpt' (default) — route through the ChatGPT-plan Codex backend
   *      (Responses API + `chatgpt-account-id` header). Usage is covered by the
   *      signed-in ChatGPT/Codex subscription, NOT the metered API. This is the
   *      only path that works for accounts without funded API credits.
   *   'api' — the metered OpenAI Chat Completions API (`baseUrl` above); needs
   *      funded platform credits. Set CODEX_BACKEND=api to use it.
   * NOTE: the ChatGPT backend is OpenAI's internal Codex endpoint (undocumented);
   * it may change without notice.
   */
  backend: (process.env.CODEX_BACKEND || 'chatgpt').toLowerCase() === 'api' ? 'api' : 'chatgpt',
  chatgptBaseUrl: process.env.CODEX_CHATGPT_BASE_URL || 'https://chatgpt.com/backend-api/codex',
  // Only 'gpt-5.5' is currently served for ChatGPT-account Codex auth.
  chatgptModel: process.env.CODEX_CHATGPT_MODEL || 'gpt-5.5',
  // Served by this server; must match the client's registered redirect exactly.
  redirectUri: `http://localhost:${PORT}/auth/callback`,
  // A login attempt (state + PKCE verifier) is valid for this long.
  loginTtlMs: 10 * 60 * 1000,
  // Refresh the access token when it is within this window of expiring.
  refreshSkewMs: 60 * 1000,
});

/**
 * Claude (Anthropic) OAuth 2.0 + PKCE configuration — "Sign in with Claude"
 * using the public Claude Code client so a Claude Pro/Max (or Console) account
 * can drive the deep agent without a metered API key.
 *
 * SECURITY (oauth-oidc checklist): provider endpoint URLs, client id, and scope
 * are TRUSTED server-side config (env-overridable), NEVER read from a request.
 * PKCE S256 + a single-use, server-issued `state` guard the exchange; the state
 * is echoed back in the pasted `code#state` and matched against a login we
 * issued. Tokens are stored server-side only and masked in responses.
 *
 * The redirect URI is Anthropic's hosted "copy this code" callback, so no local
 * loopback port needs to be registered with the provider (the operator pastes
 * the returned `code#state` back into the app).
 *
 * OAuth access tokens are sent as `Authorization: Bearer` with the beta header
 * `anthropic-beta: oauth-2025-04-20` (NOT `x-api-key`).
 */
const CLAUDE = Object.freeze({
  authorizeUrl: process.env.CLAUDE_OAUTH_AUTHORIZE_URL || 'https://claude.ai/oauth/authorize',
  tokenUrl: process.env.CLAUDE_OAUTH_TOKEN_URL || 'https://console.anthropic.com/v1/oauth/token',
  clientId: process.env.CLAUDE_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  scope: process.env.CLAUDE_OAUTH_SCOPE || 'org:create_api_key user:profile user:inference',
  redirectUri: process.env.CLAUDE_OAUTH_REDIRECT_URI || 'https://console.anthropic.com/oauth/code/callback',
  baseUrl: process.env.CLAUDE_ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  defaultModel: process.env.CLAUDE_MODEL || 'claude-opus-4-8',
  // Beta header required for OAuth (subscription) bearer tokens on /v1/messages.
  betaHeader: process.env.CLAUDE_OAUTH_BETA || 'oauth-2025-04-20',
  // Subscription OAuth tokens require a Claude Code identity system prompt; the
  // wrapper prepends this as the first system block. Set CLAUDE_OAUTH_SYSTEM_PREFIX=
  // to disable (e.g. if using a Console credential that doesn't require it).
  systemPrefix:
    process.env.CLAUDE_OAUTH_SYSTEM_PREFIX !== undefined
      ? process.env.CLAUDE_OAUTH_SYSTEM_PREFIX
      : "You are Claude Code, Anthropic's official CLI for Claude.",
  loginTtlMs: 10 * 60 * 1000,
  refreshSkewMs: 60 * 1000,
});

/**
 * LM Studio (local, OpenAI-compatible) provider configuration.
 *
 * LM Studio serves an OpenAI-compatible API (default http://localhost:1234/v1),
 * so — like Ollama — it needs no credentials and is meant for a local, single-user
 * deployment. It exists alongside Ollama because some models are only available in
 * LM Studio's catalog. The operator-supplied host is stored server-side; the
 * browser only chooses the host + model.
 *
 * `defaultHost` is env-overridable (LMSTUDIO_HOST). `apiPath` is the OpenAI-compatible
 * mount LM Studio exposes; access tokens/models are used against `${host}${apiPath}`.
 */
const LMSTUDIO = Object.freeze({
  defaultHost: process.env.LMSTUDIO_HOST || 'http://localhost:1234',
  apiPath: process.env.LMSTUDIO_API_PATH || '/v1',
});

/**
 * Code-writer deep agent + workflow config (an equivalent of OpenAI Symphony's
 * WORKFLOW.md frontmatter). The agent works a Linear ticket end-to-end in an
 * isolated git workspace, driving it through the ticket state machine while
 * keeping a single "## Workpad" comment as the source of truth.
 *
 * All values are env-overridable (CODER_*). `repoUrl` is the repository the
 * agent clones per ticket; `workspaceRoot` is where isolated clones live.
 */
const CODER = Object.freeze({
  repoUrl: process.env.CODER_REPO_URL || '',
  workspaceRoot: process.env.CODER_WORKSPACE_ROOT || path.join(require('os').homedir(), 'code', 'techmavins-workspaces'),
  // Ticket states the workflow acts on vs. leaves alone (from Symphony's tracker config).
  activeStates: (process.env.CODER_ACTIVE_STATES || 'Todo,In Progress,Merging,Rework').split(',').map((s) => s.trim()),
  terminalStates: (process.env.CODER_TERMINAL_STATES || 'Done,Closed,Cancelled,Canceled,Duplicate').split(',').map((s) => s.trim()),
  // deepagents recursion budget (analogous to Symphony's agent.max_turns).
  maxTurns: Number(process.env.CODER_MAX_TURNS) || 40,
  // Max tickets worked concurrently by the board monitor (agent.max_concurrent_agents).
  maxConcurrent: Number(process.env.CODER_MAX_CONCURRENT) || 3,
  // Poll cadence when running as a board monitor.
  pollIntervalMs: Number(process.env.CODER_POLL_INTERVAL_MS) || 15000,
  // Shell command timeout (seconds) for the workspace backend.
  shellTimeoutSec: Number(process.env.CODER_SHELL_TIMEOUT_SEC) || 600,
  // PR label the agent stamps on its pull requests.
  prLabel: process.env.CODER_PR_LABEL || 'techmavins',
});

/** Server configuration and shared constants. */
const CONFIG = Object.freeze({
  PORT,
  LINEAR_API_URL: 'https://api.linear.app/graphql',
  DATA_DIR: path.join(__dirname, '..', 'data'),
  STORE_FILE: path.join(__dirname, '..', 'data', 'store.json'),
  LOG_FILE: path.join(__dirname, '..', 'data', 'app.log'),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
  // Number of records to request from Linear in list queries.
  PAGE_SIZE: 100,
  ISSUE_PAGE_SIZE: 250,
  // Allowed scheduler cadences (minutes).
  INTERVAL_OPTIONS: [5, 10, 15],
  // Deep-agent LLM providers.
  LLM_PROVIDERS: ['ollama', 'lmstudio', 'codex', 'claude'],
  // How each local provider constrains JSON output for the planner's structured
  // calls. Not every model/engine accepts the same format (e.g. some LM Studio
  // engines reject `json_object` and require `json_schema` or `text`), so the
  // operator can pick a compatible mode per provider.
  //   ollama:   'json'        → Ollama `format: 'json'` (native constrained mode)
  //             'text'        → prompt-driven only (parsed loosely)
  //   lmstudio: 'text'        → prompt-driven only; most compatible (default)
  //             'json_object' → OpenAI-style `response_format: json_object`
  //             'json_schema' → OpenAI-style structured output (permissive object)
  OLLAMA_JSON_MODES: ['json', 'text'],
  LMSTUDIO_JSON_MODES: ['text', 'json_object', 'json_schema'],
  OAUTH,
  CLAUDE,
  LMSTUDIO,
  CODER,
});

module.exports = { CONFIG };
