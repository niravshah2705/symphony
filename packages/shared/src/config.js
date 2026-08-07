'use strict';

const path = require('path');
const { ROLES } = require('./authz');

const PORT = Number(process.env.PORT) || 4000;

// Application login modes: 'disabled' (local single-user workflow — open) and
// 'firebase' (Google SSO via Firebase Authentication).
const AUTH_MODES = new Set(['disabled', 'firebase']);

function boundedEnv(env, name, max = 512) {
  const value = String(env[name] || '').trim();
  if (value.length > max || /[\r\n]/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

/**
 * Application login config.
 *
 * Off ('disabled') for the local single-user workflow. In the cloud ('firebase')
 * the SPA signs in with Google through Firebase Authentication and the gateway
 * verifies the Firebase ID token (services/gateway/src/auth.js): issuer
 * `https://securetoken.google.com/<projectId>`, audience `<projectId>`.
 *
 * The Firebase WEB config (apiKey/authDomain/projectId) is PUBLIC by design — it
 * is safe to expose to the browser via /api/auth/config and is NOT a secret.
 * Authorization defaults to "any verified user"; set FIREBASE_ALLOWED_EMAILS
 * (comma-separated) or FIREBASE_ALLOWED_DOMAIN to restrict who may sign in.
 */
function buildFirebaseAuthConfig(env = process.env) {
  const mode = String(env.AUTH_MODE || 'disabled').trim().toLowerCase();
  if (!AUTH_MODES.has(mode)) throw new Error('AUTH_MODE must be either disabled or firebase');
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production' && mode === 'disabled') {
    throw new Error('AUTH_MODE must be firebase when NODE_ENV=production');
  }

  if (mode === 'disabled') {
    return Object.freeze({ mode, enabled: false, provider: 'none' });
  }

  const projectId = boundedEnv(env, 'FIREBASE_PROJECT_ID', 256)
    || boundedEnv(env, 'GCP_PROJECT_ID', 256)
    || boundedEnv(env, 'GOOGLE_CLOUD_PROJECT', 256);
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID (or GCP_PROJECT_ID) is required when AUTH_MODE=firebase');
  const apiKey = boundedEnv(env, 'FIREBASE_API_KEY', 256);
  if (!apiKey) throw new Error('FIREBASE_API_KEY is required when AUTH_MODE=firebase');
  const authDomain = boundedEnv(env, 'FIREBASE_AUTH_DOMAIN', 256) || `${projectId}.firebaseapp.com`;
  // Google OAuth Web client id for the One Tap prompt. PUBLIC (like apiKey) — no
  // client secret is involved. Optional: when unset the SPA falls back to the
  // Firebase Google popup. Accepts either alias for operator convenience.
  const googleClientId = boundedEnv(env, 'GOOGLE_ONE_TAP_CLIENT_ID', 256)
    || boundedEnv(env, 'FIREBASE_GOOGLE_CLIENT_ID', 256);
  const allowedEmails = boundedEnv(env, 'FIREBASE_ALLOWED_EMAILS', 4096)
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const allowedDomain = boundedEnv(env, 'FIREBASE_ALLOWED_DOMAIN', 256).toLowerCase();
  const hostedDomain = boundedEnv(env, 'FIREBASE_HD', 256);

  // Authorization (RBAC): bootstrap admins by email (config-backed, not
  // hardcoded — set via terraform/gh var) and the least-privilege role handed to
  // any other signed-in user who has no `role` custom claim yet. Roles are
  // otherwise assigned as a Firebase custom claim; see packages/shared/src/authz.js.
  const adminEmails = boundedEnv(env, 'AUTH_ADMIN_EMAILS', 4096)
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const defaultRole = boundedEnv(env, 'AUTH_DEFAULT_ROLE', 32).toLowerCase() || 'viewer';
  if (!ROLES.includes(defaultRole)) {
    throw new Error(`AUTH_DEFAULT_ROLE must be one of: ${ROLES.join(', ')}`);
  }

  return Object.freeze({
    mode,
    enabled: true,
    provider: 'firebase',
    projectId,
    apiKey,
    authDomain,
    googleClientId,
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    allowedEmails: Object.freeze(allowedEmails),
    allowedDomain,
    hostedDomain,
    adminEmails: Object.freeze(adminEmails),
    defaultRole,
  });
}

const AUTH = buildFirebaseAuthConfig();

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
  // The Codex models endpoint filters its response by client version. Keep this
  // overrideable so a newer server rollout can be adopted without a code change.
  clientVersion: process.env.CODEX_CLIENT_VERSION || '0.144.1',
  // Fallback used only when live model discovery is unavailable.
  chatgptModel: process.env.CODEX_CHATGPT_MODEL || 'gpt-5.6-sol',
  // Served by this server; must match the client's registered redirect exactly.
  redirectUri: `http://localhost:${PORT}/auth/callback`,
  // A login attempt (state + PKCE verifier) is valid for this long.
  loginTtlMs: 10 * 60 * 1000,
  // Refresh the access token when it is within this window of expiring.
  refreshSkewMs: 60 * 1000,
  // Prompt-budget trimming for Codex — same purpose as LM Studio's: the deep
  // agent re-sends its whole (growing) history each turn, so a long run can
  // eventually exceed even a large hosted context window. We bound the prompt to
  // a token budget (context window minus the output reserve and this margin) and
  // trim/summarize the oldest turns only when it actually overflows.
  //   charsPerToken     — chars→tokens estimate (GPT BPE averages ~4 for code/prose).
  //   promptMarginTokens — fixed headroom under the window for request framing.
  //   summaryMaxTokens   — output cap for the 'summarize' mode's condensed note.
  charsPerToken: Number(process.env.CODEX_CHARS_PER_TOKEN) || 4,
  promptMarginTokens: Number(process.env.CODEX_PROMPT_MARGIN_TOKENS) || 4096,
  summaryMaxTokens: Number(process.env.CODEX_SUMMARY_MAX_TOKENS) || 2048,
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
  // Per-request timeout for LM Studio calls. The OpenAI SDK default is 600000ms
  // (10 min); a large local reasoning model (e.g. a 35B) can spend longer than
  // that on a single coder turn and hit "Request timed out." Default 30 min,
  // env-overridable. Pair with a small retry count so a genuine timeout isn't
  // retried 2× (the SDK default), which would triple the wait.
  requestTimeoutMs: Number(process.env.LMSTUDIO_REQUEST_TIMEOUT_MS) || 30 * 60 * 1000,
  maxRetries: Number.isFinite(Number(process.env.LMSTUDIO_MAX_RETRIES)) ? Number(process.env.LMSTUDIO_MAX_RETRIES) : 1,
  // Prompt-budget trimming. The deep agent re-sends its whole (growing) history
  // each turn; LM Studio's loaded context window is fixed, so an unbounded history
  // eventually overflows it ("...tokens to keep from the initial prompt is greater
  // than the context length"). We trim the oldest turns to fit a token budget.
  //   charsPerToken     — chars→tokens estimate used for the (model-agnostic) budget.
  //                       Deliberately low (code is token-dense) so we over-estimate
  //                       tokens and trim conservatively rather than under-count and
  //                       overflow. Raise for prose-heavy workloads.
  //   promptMarginTokens — fixed headroom left under the window for chat-template
  //                       framing the char estimate doesn't see.
  charsPerToken: Number(process.env.LMSTUDIO_CHARS_PER_TOKEN) || 3,
  promptMarginTokens: Number(process.env.LMSTUDIO_PROMPT_MARGIN_TOKENS) || 1024,
  // Output budget for the summarization sub-call ('summarize' context mode): the
  // condensed history note is capped to this many tokens so it stays compact.
  summaryMaxTokens: Number(process.env.LMSTUDIO_SUMMARY_MAX_TOKENS) || 1024,
});

/**
 * oMLX (local, OpenAI-compatible) provider configuration.
 *
 * oMLX serves multiple MLX models on Apple Silicon and exposes its OpenAI API
 * below `/v1`. Keep its runtime knobs separate from LM Studio: the two servers
 * accept different provider-native request fields even though both implement
 * Chat Completions.
 */
const OMLX = Object.freeze({
  defaultHost: process.env.OMLX_HOST || 'http://127.0.0.1:8000',
  apiPath: process.env.OMLX_API_PATH || '/v1',
  requestTimeoutMs: Number(process.env.OMLX_REQUEST_TIMEOUT_MS) || 30 * 60 * 1000,
  maxRetries: Number.isFinite(Number(process.env.OMLX_MAX_RETRIES)) ? Number(process.env.OMLX_MAX_RETRIES) : 1,
  charsPerToken: Number(process.env.OMLX_CHARS_PER_TOKEN) || 3,
  promptMarginTokens: Number(process.env.OMLX_PROMPT_MARGIN_TOKENS) || 1024,
  summaryMaxTokens: Number(process.env.OMLX_SUMMARY_MAX_TOKENS) || 1024,
});

/**
 * Hugging Face hosted inference. The router exposes an OpenAI-compatible Chat
 * Completions API (`https://router.huggingface.co/v1/chat/completions`) that
 * fans out to serverless Inference Providers, authenticated with an HF access
 * token. Targeted with the same ChatOpenAI client as Codex's metered backend.
 */
const HUGGINGFACE = Object.freeze({
  defaultHost: process.env.HUGGINGFACE_HOST || 'https://router.huggingface.co',
  apiPath: process.env.HUGGINGFACE_API_PATH || '/v1',
  requestTimeoutMs: Number(process.env.HUGGINGFACE_REQUEST_TIMEOUT_MS) || 10 * 60 * 1000,
  maxRetries: Number.isFinite(Number(process.env.HUGGINGFACE_MAX_RETRIES)) ? Number(process.env.HUGGINGFACE_MAX_RETRIES) : 1,
});

/**
 * Antigravity (Google) provider — backed by the Gemini API.
 *
 * Google Antigravity ships no npm package (its managed-agent SDK is Python +
 * a Go CLI), so the Node adapter is backed by @google/genai. Authentication is a
 * Gemini API key (PREVIEW): the key is REQUIRED and lives server-side only,
 * exposed solely through masked status fields, and read from GEMINI_API_KEY in
 * the cloud (see store.js SECRET_ENV → antigravityApiKey).
 *
 * The called target is config-driven: `defaultModel` is a stable Gemini model
 * by default; set ANTIGRAVITY_AGENT_ID to route the harness at the Antigravity
 * preview managed-agent id instead. `openaiBaseUrl` is Gemini's
 * OpenAI-compatible endpoint used by the deep-agent (createChatModel) path.
 */
const ANTIGRAVITY = Object.freeze({
  defaultModel: process.env.ANTIGRAVITY_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  // Optional override to the Antigravity preview agent id (else the model above).
  agentId: process.env.ANTIGRAVITY_AGENT_ID || '',
  // OpenAI-compatible Gemini endpoint targeted by the ChatOpenAI-based deep-agent path.
  openaiBaseUrl: process.env.GEMINI_OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
  requestTimeoutMs: Number(process.env.ANTIGRAVITY_REQUEST_TIMEOUT_MS) || 10 * 60 * 1000,
  maxRetries: Number.isFinite(Number(process.env.ANTIGRAVITY_MAX_RETRIES)) ? Number(process.env.ANTIGRAVITY_MAX_RETRIES) : 1,
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
  // Monorepo workspace root for the aiplanned flow: one clone per project at
  // <plannedWorkspaceRoot>/<project-slug>/, a branch per task. Default ~/git/workspace.
  plannedWorkspaceRoot: process.env.CODER_PLANNED_WORKSPACE_ROOT || path.join(require('os').homedir(), 'git', 'workspace'),
  // Project label that signals "planned — ready to code" (set by the planner).
  plannedLabel: process.env.CODER_PLANNED_LABEL || 'aiplanned',
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
  // Execution backend: 'local' (framework deepagents sandbox, default) or 'openswe'
  // (dispatch to a running Open SWE LangGraph server — see agent/openswe.js).
  backend: (process.env.CODER_BACKEND || 'local').toLowerCase() === 'openswe' ? 'openswe' : 'local',
  // The issue label the coder board monitor picks up (Step 3: AI-labeled tasks).
  taskLabel: process.env.CODER_TASK_LABEL || 'AI',
  // T-shirt sizes the planner assigns per issue (smallest → largest).
  tshirtSizes: (process.env.CODER_TSHIRT_SIZES || 'XS,S,M,L,XL').split(',').map((s) => s.trim()).filter(Boolean),
  // Model-routing labels stamped on each issue by size and read by the coder: XS
  // routes to the LOCAL deep-agent LLM, every larger size to the HOSTED (global)
  // one. An issue with no model label defaults to hosted.
  localModelLabel: process.env.CODER_LOCAL_MODEL_LABEL || 'local',
  hostedModelLabel: process.env.CODER_HOSTED_MODEL_LABEL || 'hosted',
  // Parent label the model-routing labels are grouped under. Linear renders a
  // group's members as a single-select dropdown on issues, so "local"/"hosted"
  // become mutually-exclusive options of a "Models" dropdown.
  modelLabelGroup: process.env.CODER_MODEL_LABEL_GROUP || 'Models',
  // Only this size runs on the local agent; all others run hosted.
  localSize: process.env.CODER_LOCAL_SIZE || 'XS',
  // Open SWE integration (used only when backend === 'openswe').
  openswe: Object.freeze({
    // Base URL of the locally-running Open SWE LangGraph server (`langgraph dev`).
    url: process.env.OPENSWE_URL || 'http://localhost:2024',
    // The graph/assistant id to run (Open SWE's coding graph).
    assistant: process.env.OPENSWE_ASSISTANT || 'agent',
    // GitHub repo the coding agent operates on, "owner/name" (defaults to the coder repo).
    repo: process.env.OPENSWE_REPO || '',
    // Max seconds to wait for a run to finish before returning (poll timeout).
    runTimeoutSec: Number(process.env.OPENSWE_RUN_TIMEOUT_SEC) || 1800,
  }),
});

/**
 * Optional MCP tool servers the agent framework can attach as tools (in addition
 * to the built-in web_search / linear_graphql tools) — "use a good mix of tools
 * along with skills to avoid rewriting code". Both are OFF by default so the
 * standard flow is unchanged; enable per env and the framework loads their tools
 * via @langchain/mcp-adapters when a workflow declares `mcp: [...]`.
 *   - Linear MCP  (hosted, streamable HTTP): authenticated with the stored Linear
 *     API key as a Bearer token. Enable with LINEAR_MCP_ENABLED=true.
 *   - GitHub MCP  (hosted/Docker): authenticated with a PAT. Enable by setting
 *     GITHUB_MCP_TOKEN (a fine-grained PAT).
 */
const MCP = Object.freeze({
  linear: Object.freeze({
    enabled: (process.env.LINEAR_MCP_ENABLED || 'false').toLowerCase() === 'true',
    url: process.env.LINEAR_MCP_URL || 'https://mcp.linear.app/mcp',
  }),
  github: Object.freeze({
    enabled: Boolean(process.env.GITHUB_MCP_TOKEN),
    url: process.env.GITHUB_MCP_URL || 'https://api.githubcopilot.com/mcp/',
    token: process.env.GITHUB_MCP_TOKEN || '',
  }),
  // Playwright MCP (local, stdio): interactive browser automation tools
  // (navigate/click/snapshot). Launched as a child process via npx, so no
  // network credentials are involved. Enable with PLAYWRIGHT_MCP_ENABLED=true.
  playwright: Object.freeze({
    enabled: (process.env.PLAYWRIGHT_MCP_ENABLED || 'false').toLowerCase() === 'true',
    transport: 'stdio',
    command: process.env.PLAYWRIGHT_MCP_COMMAND || 'npx',
    args: (process.env.PLAYWRIGHT_MCP_ARGS || '-y,@playwright/mcp@latest,--headless,--isolated')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }),
});

/**
 * Developer-tool folder limits (packages/shared/src/agent/tools/*). These tools
 * delegate to pre-installed CLIs (docker, gradle, uv, npm, trivy, playwright…)
 * via hardened execFile calls. `timeoutSec` bounds a single delegated command;
 * `maxOutputBytes` bounds the (secret-redacted) output returned to the model.
 */
const TOOLS = Object.freeze({
  timeoutSec: Number(process.env.TOOLS_TIMEOUT_SEC) || 900,
  maxOutputBytes: Number(process.env.TOOLS_MAX_OUTPUT_BYTES) || 64 * 1024,
});

/**
 * Repo-root-anchored data/public locations. This module lives at
 * packages/shared/src/config.js, so the monorepo root is three levels up. All
 * services (gateway, planner, coder) resolve the SAME data/store.json and
 * public/ regardless of which service process loads this shared config — the
 * store is the single shared source of truth, never copied per service. Both
 * roots are env-overridable for containerized deployments.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = process.env.AI_FLEET_DATA_DIR || path.join(REPO_ROOT, 'data');
const PUBLIC_DIR = process.env.AI_FLEET_PUBLIC_DIR || path.join(REPO_ROOT, 'public');

/**
 * Isolated agent-service topology. The gateway is the only browser-facing
 * origin (it also owns OAuth via CONFIG.PORT above); it proxies /api/agent to
 * the planner service and /api/coder to the coder service. Ports and internal
 * base URLs are env-overridable so the services can move hosts/containers
 * without a code change.
 */
const PLANNER_PORT = Number(process.env.PLANNER_PORT) || 4010;
const CODER_SERVICE_PORT = Number(process.env.CODER_SERVICE_PORT) || 4020;
const ORG_SERVICE_PORT = Number(process.env.ORG_SERVICE_PORT) || 8000;
const SERVICES = Object.freeze({
  gatewayPort: PORT,
  plannerPort: PLANNER_PORT,
  coderPort: CODER_SERVICE_PORT,
  plannerUrl: process.env.PLANNER_URL || `http://localhost:${PLANNER_PORT}`,
  coderUrl: process.env.CODER_URL || `http://localhost:${CODER_SERVICE_PORT}`,
  // Organization service (Python/FastAPI, Firestore). The gateway proxies
  // /api/org/* -> orgUrl/api/v1/* (see services/gateway/src/index.js). Empty
  // when unset so the gateway can 501 the org routes rather than crash.
  orgUrl: process.env.ORG_URL || (process.env.NODE_ENV === 'production' ? '' : `http://localhost:${ORG_SERVICE_PORT}`),
});

/**
 * GCP / Cloud Run deployment knobs. All optional and INERT for local dev — the
 * defaults keep the file store, in-process request delivery, and in-memory event
 * bus, so `npm start` needs no Google Cloud. See docs/GCP_DEPLOY (deployment plan).
 *   STORE_BACKEND   'file' (local JSON) | 'firestore' (Cloud Run shared state)
 *   MESSAGING_MODE  'direct' (in-process HTTP) | 'pubsub' (Cloud Pub/Sub)
 *   EVENTS_BACKEND  'memory' (EventEmitter) | 'firestore' (onSnapshot SSE relay)
 */
const STORE_BACKEND = String(process.env.STORE_BACKEND || 'file').trim().toLowerCase();
const MESSAGING_MODE = String(process.env.MESSAGING_MODE || 'direct').trim().toLowerCase();
const EVENTS_BACKEND = String(process.env.EVENTS_BACKEND || 'memory').trim().toLowerCase();
// Cross-process event sink for local multi-process dev: worker services (planner
// /coder) POST events here and the gateway ingests them into its in-process bus,
// which its SSE endpoint reads. Unset on the gateway itself. Ignored when
// EVENTS_BACKEND=firestore (the cloud path fans out via onSnapshot instead).
const EVENTS_SINK_URL = String(process.env.EVENTS_SINK_URL || '').trim();
const GCP = Object.freeze({
  projectId: process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '',
  region: process.env.GCP_REGION || 'us-central1',
  plannerTopic: process.env.PUBSUB_PLANNER_TOPIC || 'planner-requests',
  coderTopic: process.env.PUBSUB_CODER_TOPIC || 'coder-requests',
  // Cloud Run Job launched (by coder-control) to run one coder ticket to completion.
  coderJobName: process.env.CODER_JOB_NAME || 'coder-worker',
  // Pub/Sub push OIDC verification (enforced only when MESSAGING_MODE=pubsub):
  //   pushAudience        expected `aud` of the push token (the push endpoint URL)
  //   pushServiceAccount  the SA email Pub/Sub is configured to sign push tokens as
  pushAudience: String(process.env.PUBSUB_PUSH_AUDIENCE || '').trim(),
  pushServiceAccount: String(process.env.PUBSUB_PUSH_SA || '').trim(),
  // Allowlist of browser origins permitted via CORS (the SPA's GCS/website
  // origin). Empty in local dev (same-origin — no CORS needed).
  spaOrigins: String(process.env.SPA_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean),
  // Absolute base URL of the gateway API, injected into the SPA at deploy time.
  apiBaseUrl: String(process.env.API_BASE_URL || '').trim(),
});

/**
 * Agent skills source resolution.
 *
 * Locally (SKILLS_ROOT unset) the framework installs its skills from the
 * vendored directory packages/shared/src/agent/skills — the EXISTING behavior,
 * unchanged. In the cloud a versioned skills bundle is published to a GCS bucket
 * and mounted read-only on the planner/coder Cloud Run services via gcsfuse at
 * SKILLS_ROOT (e.g. /skills), laid out as `<version>/<skill>/SKILL.md`. The
 * runtime PINS a version with SKILLS_VERSION so multiple published versions can
 * coexist and an older pinned version keeps working (backward-compat).
 *
 *   SKILLS_ROOT     gcsfuse mount root of the versioned bundles.
 *                   Empty ('') = the vendored default (local/dev).
 *   SKILLS_VERSION  the version subdirectory to pin under SKILLS_ROOT.
 *                   Empty ('') = read the mount root directly.
 *
 * SKILLS_ROOT / SKILLS_VERSION are TRUSTED server-side config (env from
 * Terraform), not request input. SKILLS_VERSION still forms a filesystem path,
 * so it is validated to a single safe path segment (defense-in-depth).
 */
const SKILLS_VENDORED_SRC = path.join(__dirname, 'agent', 'skills');

function assertSafeSkillsVersion(version) {
  if (version === '') return version;
  if (version === '.' || version === '..' || !/^[A-Za-z0-9._-]+$/.test(version)) {
    throw new Error(`SKILLS_VERSION must be a single path segment (got: ${version})`);
  }
  return version;
}

/**
 * Resolve the directory installSkills copies skills FROM, given an environment.
 * Kept as a pure function (env injectable) so it honors runtime env and is unit
 * testable. Returns the vendored default when SKILLS_ROOT is unset.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path to the skills source directory
 */
function resolveSkillsSrc(env = process.env) {
  const root = String(env.SKILLS_ROOT || '').trim();
  if (!root) return SKILLS_VENDORED_SRC;
  const version = assertSafeSkillsVersion(String(env.SKILLS_VERSION || '').trim());
  return version ? path.join(root, version) : root;
}

const SKILLS = Object.freeze({
  root: String(process.env.SKILLS_ROOT || '').trim(),
  version: String(process.env.SKILLS_VERSION || '').trim(),
  vendoredSrc: SKILLS_VENDORED_SRC,
  src: resolveSkillsSrc(),
});

/** Server configuration and shared constants. */
const CONFIG = Object.freeze({
  PORT,
  LINEAR_API_URL: 'https://api.linear.app/graphql',
  DATA_DIR,
  STORE_FILE: path.join(DATA_DIR, 'store.json'),
  LOG_FILE: path.join(DATA_DIR, 'app.log'),
  PUBLIC_DIR,
  SERVICES,
  STORE_BACKEND,
  MESSAGING_MODE,
  EVENTS_BACKEND,
  EVENTS_SINK_URL,
  GCP,
  // Number of records to request from Linear in list queries.
  PAGE_SIZE: 100,
  ISSUE_PAGE_SIZE: 250,
  // Allowed scheduler cadences (minutes).
  INTERVAL_OPTIONS: [5, 10, 15],
  // Deep-agent LLM providers.
  LLM_PROVIDERS: ['ollama', 'lmstudio', 'omlx', 'codex', 'claude', 'huggingface', 'antigravity'],
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
  OMLX_JSON_MODES: ['text', 'json_object', 'json_schema'],
  // How the LM Studio provider keeps the deep-agent prompt within the loaded window
  // (only acts when the prompt exceeds it): summarize old turns, trim (drop) them,
  // or none (send as-is — may overflow). 'summarize' preserves the most context.
  LMSTUDIO_CONTEXT_MODES: ['summarize', 'trim', 'none'],
  OMLX_CONTEXT_MODES: ['summarize', 'trim', 'none'],
  // Codex reuses the same prompt-budget strategy as the local providers. Default
  // is 'trim' (no extra hosted call); 'summarize' condenses old turns via one
  // extra Codex call, 'none' sends the history as-is.
  CODEX_CONTEXT_MODES: ['summarize', 'trim', 'none'],
  // Retry an LLM stream once, by default, on a transient/in-stream error (an
  // OpenAI stream `error` event, a 5xx/429, or a dropped connection). These
  // arrive AFTER a 200 so the OpenAI SDK's own maxRetries never covers them.
  // Applies to every provider; operator-overridable per install via the
  // `llmStreamRetries` setting. 0 disables retrying.
  LLM_STREAM_RETRIES: Number.isFinite(Number(process.env.LLM_STREAM_RETRIES)) ? Number(process.env.LLM_STREAM_RETRIES) : 1,
  OAUTH,
  CLAUDE,
  LMSTUDIO,
  OMLX,
  HUGGINGFACE,
  ANTIGRAVITY,
  CODER,
  MCP,
  TOOLS,
  AUTH,
  SKILLS,
});

module.exports = { CONFIG, buildFirebaseAuthConfig, resolveSkillsSrc };
