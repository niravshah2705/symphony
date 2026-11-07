'use strict';

/**
 * Egress reverse-proxy contract — the SINGLE source of truth shared by:
 *   - the agent-side config (packages/shared/src/config.js), which points every
 *     SDK/fetch base URL at `${EGRESS_PROXY_URL}<prefix>` when proxy mode is on, and
 *   - the proxy service (services/proxy), which maps each `<prefix>` back to its
 *     true upstream and injects the real credential.
 *
 * WHY a reverse proxy (not a transparent HTTP_PROXY/MITM): the codebase already
 * threads a configurable base URL into every LLM SDK, and Node's fetch/SDKs do
 * not honor HTTP_PROXY transparently. The agent talks plaintext HTTP to the
 * sidecar over loopback (never leaves the pod); the sidecar re-originates TLS to
 * the real upstream after swapping in the credential. So the agent container
 * holds NO raw provider secret — only the proxy does.
 *
 * Pure constants + helpers — this module MUST NOT require ./config (config
 * requires this; a cycle would break both).
 *
 * `scheme` (for static-key routes): how the key is presented upstream.
 *   'bearer'   → Authorization: Bearer <key>
 *   'raw'      → Authorization: <key>            (Linear personal API keys)
 *   'x-api-key'→ x-api-key: <key>                (LangSmith)
 *   'private-token' → PRIVATE-TOKEN: <key>        (GitLab REST)
 * `auth`:
 *   'apiKey'         → static key from the vault/managed source (uses secretKey)
 *   'claude'         → Claude OAuth bearer (+ anthropic-beta), refreshed by proxy
 *   'codex-chatgpt'  → Codex OAuth bearer (+ chatgpt-account-id), refreshed by proxy
 *   'codex-api'      → Codex OAuth bearer against the metered API
 *   'git'            → git smart-HTTP basic (x-access-token:<PAT>)
 *   'basic-pair'     → HTTP basic of TWO vault-resolved halves (<usernameKey>:<secretKey>).
 *                      Langfuse authenticates as Basic base64(pk-lf-…:sk-lf-…), so the
 *                      username is itself a stored key rather than a constant.
 *   'llm-gateway'    → LangSmith LLM Gateway bearer + per-org policy header;
 *                      FAILS CLOSED on a missing key (billing gateway — never
 *                      forward unauthenticated)
 */

// Sentinel the agent sends in place of a real credential so SDKs that require a
// non-empty apiKey/authToken don't throw before the request reaches the proxy.
// The proxy STRIPS all inbound auth and injects the real credential, so this
// value is never sent upstream and carries no privilege.
const SENTINEL_TOKEN = 'egress-proxy-sentinel';
const PROJECT_CONTEXT_HEADER = 'X-AI-Fleet-Project-ID';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Header the proxy stamps on LangSmith LLM Gateway calls so per-org spend/rate
// policies can key on the tenant (configured as the customer-identifier header
// in the LangSmith policy UI).
const LLM_GATEWAY_ORG_HEADER = 'x-fleet-org-id';

/**
 * LangSmith LLM Gateway upstream base. The hosted gateway by default, or the
 * BYOC/self-hosted data plane via LANGSMITH_GATEWAY_URL.
 */
function llmGatewayUpstream(env = process.env) {
  return normalizeProxyBase(env.LANGSMITH_GATEWAY_URL) || 'https://gateway.smith.langchain.com';
}

/**
 * Langfuse upstream base. The EU cloud project by default; LANGFUSE_BASE_URL selects
 * another data region (us/jp/hipaa.cloud.langfuse.com) or a self-hosted instance.
 * These two routes are the module's env-read exceptions (config.js requires this file,
 * so an override cannot live there). The base URL is not a secret — only the key pair is.
 */
function langfuseUpstream(env = process.env) {
  return normalizeProxyBase(env.LANGFUSE_BASE_URL) || 'https://cloud.langfuse.com';
}

// Order matters only for readability; matching is longest-prefix (see matchRoute).
const EGRESS_ROUTES = Object.freeze({
  anthropic: Object.freeze({ prefix: '/anthropic', upstream: 'https://api.anthropic.com', auth: 'claude' }),
  codex: Object.freeze({ prefix: '/codex', upstream: 'https://chatgpt.com/backend-api/codex', auth: 'codex-chatgpt' }),
  openai: Object.freeze({ prefix: '/openai', upstream: 'https://api.openai.com/v1', auth: 'codex-api' }),
  gemini: Object.freeze({ prefix: '/gemini', upstream: 'https://generativelanguage.googleapis.com/v1beta/openai', auth: 'apiKey', scheme: 'bearer', secretKey: 'geminiApiKey' }),
  geminiNative: Object.freeze({ prefix: '/gemini-native', upstream: 'https://generativelanguage.googleapis.com', auth: 'apiKey', scheme: 'x-goog-api-key', secretKey: 'geminiApiKey' }),
  hf: Object.freeze({ prefix: '/hf', upstream: 'https://router.huggingface.co', auth: 'apiKey', scheme: 'bearer', secretKey: 'huggingfaceApiKey' }),
  linearMcp: Object.freeze({ prefix: '/linear-mcp', upstream: 'https://mcp.linear.app/mcp', auth: 'apiKey', scheme: 'bearer', secretKey: 'linearApiKey' }),
  linear: Object.freeze({ prefix: '/linear', upstream: 'https://api.linear.app/graphql', auth: 'apiKey', scheme: 'raw', secretKey: 'linearApiKey' }),
  githubApi: Object.freeze({ prefix: '/github-api', upstream: 'https://api.github.com', auth: 'apiKey', scheme: 'bearer', secretKey: 'githubToken' }),
  githubMcp: Object.freeze({ prefix: '/github-mcp', upstream: 'https://api.githubcopilot.com/mcp/', auth: 'apiKey', scheme: 'bearer', secretKey: 'githubToken' }),
  git: Object.freeze({ prefix: '/git/github', upstream: 'https://github.com', auth: 'git', username: 'x-access-token', secretKey: 'githubToken' }),
  gitlabApi: Object.freeze({ prefix: '/gitlab-api', upstream: 'https://gitlab.com/api/v4', auth: 'apiKey', scheme: 'private-token', secretKey: 'gitlabToken' }),
  gitlabGit: Object.freeze({ prefix: '/git/gitlab', upstream: 'https://gitlab.com', auth: 'git', username: 'oauth2', secretKey: 'gitlabToken' }),
  asanaApi: Object.freeze({ prefix: '/asana-api', upstream: 'https://app.asana.com/api/1.0', auth: 'apiKey', scheme: 'bearer', secretKey: 'asanaAccessToken' }),
  // Jira's tenant origin and account email are non-secret organization config,
  // resolved S2S by the proxy. The token still comes from the encrypted vault.
  jiraApi: Object.freeze({ prefix: '/jira-api', target: 'jira', auth: 'jira', secretKey: 'jiraApiToken' }),
  // oMLX may live on a private deployment network. Its upstream is accepted
  // only from the proxy's trusted OMLX_PROXY_UPSTREAM environment variable.
  omlx: Object.freeze({ prefix: '/omlx', target: 'omlx', auth: 'apiKey', scheme: 'bearer', secretKey: 'omlxApiKey', optionalCredential: true }),
  // A Slack webhook URL is itself a credential. The caller gets one fixed path
  // and cannot append a path/query that would select another target.
  slackWebhook: Object.freeze({ prefix: '/slack-webhook', target: 'slack-webhook', auth: 'url-secret', secretKey: 'slackWebhookUrl', exact: true }),
  // Dormant since Langfuse became the trace sink: no agent posts here any more,
  // but the route and its vault key stay so a deployed stack does not have to
  // destroy a managed secret to drop it.
  langsmith: Object.freeze({ prefix: '/langsmith', upstream: 'https://api.smith.langchain.com', auth: 'apiKey', scheme: 'x-api-key', secretKey: 'langsmithApiKey' }),
  // Agent-side tracing exports OTLP to `${baseUrl}/api/public/otel/v1/traces`, so the
  // upstream stays a bare origin: the SDK appends the whole API path itself and
  // buildUpstreamUrl forwards the remainder verbatim.
  langfuse: Object.freeze({ prefix: '/langfuse', upstream: langfuseUpstream(), auth: 'basic-pair', usernameKey: 'langfusePublicKey', secretKey: 'langfuseSecretKey' }),
  // One feature-flagged prefix serves the OpenAI, Anthropic, and Responses API
  // surfaces. Its workspace key is deliberately separate from the tracing key.
  llmGateway: Object.freeze({ prefix: '/llmgw', upstream: llmGatewayUpstream(), auth: 'llm-gateway', secretKey: 'langsmithGatewayApiKey' }),
  // Anonymous providers still use fixed routes so agent activity cannot bypass
  // the sidecar's target allowlist, header stripping, or redirect rejection.
  duckDuckGoHtml: Object.freeze({ prefix: '/duckduckgo-html', upstream: 'https://html.duckduckgo.com', auth: 'none' }),
  ipwho: Object.freeze({ prefix: '/ipwho', upstream: 'https://ipwho.is', auth: 'none' }),
  codexOauthToken: Object.freeze({ prefix: '/codex-oauth-token', upstream: 'https://auth.openai.com/oauth/token', auth: 'none', exact: true }),
  claudeOauthToken: Object.freeze({ prefix: '/claude-oauth-token', upstream: 'https://console.anthropic.com/v1/oauth/token', auth: 'none', exact: true }),
  // Local inference origins are trusted deployment configuration on the proxy,
  // never browser/settings-selected targets while proxy mode is active.
  ollama: Object.freeze({ prefix: '/ollama', target: 'ollama', auth: 'none' }),
  lmstudio: Object.freeze({ prefix: '/lmstudio', target: 'lmstudio', auth: 'none' }),
  // LiteLLM proxy (self-hosted LLM gateway + request tracing). A `target` route
  // rather than a static `upstream` so its origin is trusted deployment config
  // read through normalizeTrustedUpstream on the proxy (same idiom as ollama /
  // lmstudio / openswe) — that validation is what keeps this from becoming an
  // SSRF pivot, since LiteLLM itself fans out to the internet. The bearer key is
  // a per-org LiteLLM virtual key: `apiKey` resolves it from the org's vault via
  // fetchOrgSecrets(PROXY_ORG_ID) and fails closed when absent, so spend on the
  // gateway attributes to the tenant that caused it.
  litellm: Object.freeze({ prefix: '/litellm', target: 'litellm', auth: 'apiKey', scheme: 'bearer', secretKey: 'litellmApiKey' }),
  // agentgateway — an L7 front for LLM, MCP and A2A traffic, deployed in-cluster.
  // One prefix is enough for all three because MCP and A2A ride the same target as
  // sub-paths. A `target` route for the same reason LiteLLM is one: the gateway
  // fans out to the internet and holds a real provider key, so a caller-selected
  // origin would be an SSRF pivot with a credential attached to it.
  //
  // There is no enable flag. With AGENTGATEWAY_PROXY_UPSTREAM unset, resolveUpstream
  // fails closed 502 — which is the dark state, enforced by deployment config
  // instead of a second knob that can disagree with the first. A `litellm` run is
  // unaffected: this deployment puts the gateway *in front of* LiteLLM, so the
  // physical target of LITELLM_PROXY_UPSTREAM moves and no route or mode does.
  agentgateway: Object.freeze({ prefix: '/agentgw', target: 'agentgateway', auth: 'apiKey', scheme: 'bearer', secretKey: 'fleetGatewayApiKey' }),
  // OpenSWE is a separate LangGraph server. Its real origin is trusted
  // sidecar-only deployment config; the coder sees only this fixed route.
  openSwe: Object.freeze({ prefix: '/openswe', target: 'openswe', auth: 'none' }),
  openrouter: Object.freeze({ prefix: '/openrouter', upstream: 'https://openrouter.ai/api/v1', auth: 'apiKey', scheme: 'bearer', secretKey: 'openrouterApiKey' }),
});

/**
 * All vault secret keys any static-key route can request (dedup, stable order).
 * A `basic-pair` route authenticates with TWO stored keys, so its `usernameKey`
 * is collected alongside `secretKey`.
 */
const EGRESS_SECRET_KEYS = Object.freeze([
  ...new Set(
    Object.values(EGRESS_ROUTES)
      .flatMap((r) => [r.secretKey, r.usernameKey])
      .filter(Boolean),
  ),
]);

/** Normalize a proxy base: strip a single trailing slash. */
function normalizeProxyBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** Project-vault selection header. Non-UUID legacy ids are deliberately omitted. */
function projectEgressHeaders(context) {
  const raw = typeof context === 'string'
    ? context
    : context && (context.projectId || context.nativeProjectId);
  const projectId = String(raw || '').trim().toLowerCase();
  return UUID_RE.test(projectId) ? { [PROJECT_CONTEXT_HEADER]: projectId } : {};
}

/**
 * Client-side base URL for a route. Once proxy mode is enabled it is mandatory:
 * provider-specific overrides cannot bypass the sidecar. Outside proxy mode an
 * explicit trusted operator override still wins over the normal fallback.
 */
function egressUrl({ proxyBase, prefix, explicit, fallback }) {
  const base = normalizeProxyBase(proxyBase);
  if (base) return `${base}${prefix}`;
  if (explicit) return explicit;
  return fallback;
}

/**
 * Longest-prefix match of an inbound proxy request path to a route. Returns
 * `{ route, rest }` where `rest` is the path remainder after the prefix (used to
 * build the upstream URL), or null when nothing matches (proxy rejects → no open
 * relay / SSRF).
 */
function matchRoute(pathname, routes = EGRESS_ROUTES) {
  const path = String(pathname || '');
  let best = null;
  for (const route of Object.values(routes)) {
    const p = route.prefix;
    const matches = route.exact
      ? path === p
      : path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`);
    if (matches) {
      if (!best || route.prefix.length > best.route.prefix.length) {
        best = { route, rest: path.slice(p.length) || '/' };
      }
    }
  }
  return best;
}

module.exports = {
  SENTINEL_TOKEN,
  PROJECT_CONTEXT_HEADER,
  EGRESS_ROUTES,
  EGRESS_SECRET_KEYS,
  LLM_GATEWAY_ORG_HEADER,
  normalizeProxyBase,
  projectEgressHeaders,
  egressUrl,
  llmGatewayUpstream,
  langfuseUpstream,
  matchRoute,
};
