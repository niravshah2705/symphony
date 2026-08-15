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
 * `auth`:
 *   'apiKey'         → static key from the vault/managed source (uses secretKey)
 *   'claude'         → Claude OAuth bearer (+ anthropic-beta), refreshed by proxy
 *   'codex-chatgpt'  → Codex OAuth bearer (+ chatgpt-account-id), refreshed by proxy
 *   'codex-api'      → Codex OAuth bearer against the metered API
 *   'git'            → git smart-HTTP basic (x-access-token:<PAT>)
 *   'llm-gateway'    → LangSmith LLM Gateway bearer + per-org policy header;
 *                      FAILS CLOSED on a missing key (billing gateway — never
 *                      forward unauthenticated)
 */

// Sentinel the agent sends in place of a real credential so SDKs that require a
// non-empty apiKey/authToken don't throw before the request reaches the proxy.
// The proxy STRIPS all inbound auth and injects the real credential, so this
// value is never sent upstream and carries no privilege.
const SENTINEL_TOKEN = 'egress-proxy-sentinel';

// Header the proxy stamps on LangSmith LLM Gateway calls so per-org spend/rate
// policies can key on the tenant (configured as the customer-identifier header
// in the LangSmith policy UI).
const LLM_GATEWAY_ORG_HEADER = 'x-fleet-org-id';

/**
 * LangSmith LLM Gateway upstream base. The one env-read exception in this module
 * (config.js requires this file, so the override cannot live there): the hosted
 * gateway by default, or the BYOC/self-hosted data plane via LANGSMITH_GATEWAY_URL.
 */
function llmGatewayUpstream(env = process.env) {
  return normalizeProxyBase(env.LANGSMITH_GATEWAY_URL) || 'https://gateway.smith.langchain.com';
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
  git: Object.freeze({ prefix: '/git/github', upstream: 'https://github.com', auth: 'git', secretKey: 'githubToken' }),
  langsmith: Object.freeze({ prefix: '/langsmith', upstream: 'https://api.smith.langchain.com', auth: 'apiKey', scheme: 'x-api-key', secretKey: 'langsmithApiKey' }),
  // LangSmith LLM Gateway (feature-flagged per request, browser header
  // X-AI-Fleet-Llm-Gateway). One prefix serves all three surfaces —
  // /v1/chat/completions, /v1/messages, /v1/responses. The secret is the
  // gateway WORKSPACE key, deliberately distinct from the tracing key above.
  llmGateway: Object.freeze({ prefix: '/llmgw', upstream: llmGatewayUpstream(), auth: 'llm-gateway', secretKey: 'langsmithGatewayApiKey' }),
});

/** All vault secret keys any static-key route can request (dedup, stable order). */
const EGRESS_SECRET_KEYS = Object.freeze([
  ...new Set(Object.values(EGRESS_ROUTES).map((r) => r.secretKey).filter(Boolean)),
]);

/** Normalize a proxy base: strip a single trailing slash. */
function normalizeProxyBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * Client-side base URL for a route: `${proxyBase}<prefix>` when a proxy base is
 * set, else the caller's `fallback` (the true upstream / operator override).
 */
function egressUrl({ proxyBase, prefix, explicit, fallback }) {
  if (explicit) return explicit; // operator override always wins
  const base = normalizeProxyBase(proxyBase);
  if (base) return `${base}${prefix}`;
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
    if (path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`)) {
      if (!best || route.prefix.length > best.route.prefix.length) {
        best = { route, rest: path.slice(p.length) || '/' };
      }
    }
  }
  return best;
}

module.exports = {
  SENTINEL_TOKEN,
  EGRESS_ROUTES,
  EGRESS_SECRET_KEYS,
  LLM_GATEWAY_ORG_HEADER,
  normalizeProxyBase,
  egressUrl,
  llmGatewayUpstream,
  matchRoute,
};
