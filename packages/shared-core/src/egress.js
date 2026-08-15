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
 */

// Sentinel the agent sends in place of a real credential so SDKs that require a
// non-empty apiKey/authToken don't throw before the request reaches the proxy.
// The proxy STRIPS all inbound auth and injects the real credential, so this
// value is never sent upstream and carries no privilege.
const SENTINEL_TOKEN = 'egress-proxy-sentinel';
const PROJECT_CONTEXT_HEADER = 'X-AI-Fleet-Project-ID';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  langsmith: Object.freeze({ prefix: '/langsmith', upstream: 'https://api.smith.langchain.com', auth: 'apiKey', scheme: 'x-api-key', secretKey: 'langsmithApiKey' }),
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
  // OpenSWE is a separate LangGraph server. Its real origin is trusted
  // sidecar-only deployment config; the coder sees only this fixed route.
  openSwe: Object.freeze({ prefix: '/openswe', target: 'openswe', auth: 'none' }),
});

/** All vault secret keys any static-key route can request (dedup, stable order). */
const EGRESS_SECRET_KEYS = Object.freeze([
  ...new Set(Object.values(EGRESS_ROUTES).map((r) => r.secretKey).filter(Boolean)),
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
  normalizeProxyBase,
  projectEgressHeaders,
  egressUrl,
  matchRoute,
};
