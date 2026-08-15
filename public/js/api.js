// Runtime deployment configuration is a module dependency, so it executes
// before this client reads the API base without blocking the HTML parser.
import '/config.js';
import {
  shouldNotifyAuthenticationRequired,
  shouldRetryAuth,
  createSingleFlight,
} from './auth-retry.mjs';
import { mintedStreamContextQuerySuffix } from './stream-context.mjs';

// Thin fetch wrapper around the backend API.

let accessTokenProvider = null;
let requestContext = Object.freeze({ organizationId: '', projectId: '' });

export function setAccessTokenProvider(provider) {
  accessTokenProvider = typeof provider === 'function' ? provider : null;
}

function contextId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(id) ? id : '';
}

/** Set the validated native AI Fleet org/project context applied to API calls. */
export function setRequestContext(value) {
  requestContext = Object.freeze({
    organizationId: contextId(value && value.organizationId),
    projectId: contextId(value && value.projectId),
  });
}

export function getRequestContext() {
  return requestContext;
}

/** EventSource cannot send custom headers, so its short-lived token-bound context
 * is repeated in the URL. Normal fetch requests use the headers below. */
export function requestContextQuerySuffix() {
  const query = new URLSearchParams();
  if (requestContext.organizationId) query.set('organizationId', requestContext.organizationId);
  if (requestContext.projectId) query.set('projectId', requestContext.projectId);
  const value = query.toString();
  return value ? `&${value}` : '';
}

// A rejected app-auth 401 forces exactly one Firebase token refresh; a parallel
// batch of failing calls coalesces onto that single refresh (see auth-retry).
const runTokenRefresh = createSingleFlight();
function refreshAccessToken() {
  if (!accessTokenProvider) return Promise.resolve(null);
  return runTokenRefresh(() => accessTokenProvider(true));
}

async function readJson(res) {
  try {
    return await res.json();
  } catch (_) {
    return {}; /* empty body */
  }
}

// The gateway returns { error: "msg", code }; the org service returns a nested
// envelope { error: { code, message } }. Read the error code from either shape.
function errorCode(data) {
  const nested = data && data.error && typeof data.error === 'object' ? data.error : null;
  return (data && data.code) || (nested && nested.code) || '';
}

/**
 * Absolute base URL of the gateway API. Empty = same-origin (local dev, where
 * the gateway also serves the SPA). When the SPA is hosted on GCS, deploy-time
 * config.js sets window.__API_BASE__ to the gateway's Cloud Run URL so the
 * cross-origin calls (and SSE) target the API.
 */
export function getApiBase() {
  const base = (typeof window !== 'undefined' && window.__API_BASE__) ? String(window.__API_BASE__) : '';
  return base.replace(/\/+$/, '');
}

/**
 * Re-point the API base at runtime. The SPA bootstraps against the shared
 * gateway (window.__API_BASE__ from config.js), then — after sign-in — resolves
 * its per-org deployment via GET /api/config. When the caller's org has a
 * dedicated per-tenant gateway, auth.js calls setApiBase() with that URL so ALL
 * subsequent calls (REST + SSE, which read getApiBase()) target the tenant
 * gateway. A falsy value keeps same-origin. This is reset on every page load
 * (config.js reruns), so the per-org base is re-derived per session.
 */
export function setApiBase(url) {
  if (typeof window === 'undefined') return;
  window.__API_BASE__ = url ? String(url).replace(/\/+$/, '') : '';
}

function notifyAuthenticationRequired(error) {
  window.dispatchEvent(new CustomEvent('ai-fleet:auth-required', {
    detail: { message: error?.message || 'Authentication required' },
  }));
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  // Context headers are application-owned. Replace rather than merge any
  // caller-supplied values so every request carries the final validated choice.
  headers.delete('X-AI-Fleet-Organization-Id');
  headers.delete('X-AI-Fleet-Project-Id');
  if (requestContext.organizationId) {
    headers.set('X-AI-Fleet-Organization-Id', requestContext.organizationId);
  }
  if (requestContext.projectId) {
    headers.set('X-AI-Fleet-Project-Id', requestContext.projectId);
  }
  // `application/json` is not a CORS-safelisted request header. Adding it to a
  // bodyless anonymous GET forces an otherwise unnecessary OPTIONS preflight.
  // Mutations that actually carry our JSON payload still advertise it.
  if (options.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessTokenProvider) {
    try {
      const token = await accessTokenProvider();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    } catch (cause) {
      const error = new Error('Your session has expired. Sign in again to continue.');
      error.code = 'authentication_required';
      error.cause = cause;
      notifyAuthenticationRequired(error);
      throw error;
    }
  }

  let res = await fetch(`${getApiBase()}/api${path}`, { ...options, headers });
  let data = await readJson(res);

  // An app-auth 401 means our Firebase token was rejected mid-session (e.g.
  // clock skew or an expiry the client had not detected). Force ONE token
  // refresh and retry the request once; a parallel batch of failing calls
  // coalesces onto the single refresh. Every other outcome — a connected-tool
  // 401, 403, 500, or a network error — falls straight through untouched.
  if (!res.ok && accessTokenProvider
      && shouldRetryAuth({ status: res.status, code: errorCode(data), path })) {
    let fresh = null;
    try {
      fresh = await refreshAccessToken();
    } catch (_) {
      fresh = null;
    }
    if (fresh) {
      const retryHeaders = new Headers(headers);
      retryHeaders.set('Authorization', `Bearer ${fresh}`);
      res = await fetch(`${getApiBase()}/api${path}`, { ...options, headers: retryHeaders });
      data = await readJson(res);
    }
  }

  if (!res.ok) {
    const nested = data.error && typeof data.error === 'object' ? data.error : null;
    const message = nested ? nested.message : data.error;
    const error = new Error(message || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = errorCode(data);
    // Connected tools can also return 401. Lock the whole workspace only when
    // the gateway identified an application-auth failure (or while confirming
    // the current application identity), not for an unrelated provider key.
    if (shouldNotifyAuthenticationRequired({
      status: res.status,
      code: error.code,
      path,
      hasAccessTokenProvider: Boolean(accessTokenProvider),
    })) {
      notifyAuthenticationRequired(error);
    }
    throw error;
  }
  return data;
}

// SSE reconnection tuning. EventSource cannot send a bearer, so a short-lived
// stream token rides in the URL (stream-token TTL ~5 min). The native reconnect
// reuses the SAME token, which expires → 401 and the stream dies silently. So we
// own reconnection: re-mint a fresh token (also self-healing a secret rotation)
// and reopen with capped exponential backoff, giving up after a bounded run of
// consecutive failures (reset once a connection opens).
const STREAM_RECONNECT_BASE_MS = 1_000;
const STREAM_RECONNECT_MAX_MS = 30_000;
const STREAM_MAX_CONSECUTIVE_FAILURES = 6;

/**
 * Open an SSE stream that owns its reconnection, and return a `{ close() }`
 * controller. `mintToken()` resolves to `{ token, organizationId, projectId }`;
 * `buildUrl(token, minted)` returns the SSE URL; `onEvent(parsed)` receives each
 * JSON message.
 */
async function openStream({ mintToken, buildUrl, onEvent }) {
  let source = null;
  let stopped = false;
  let failures = 0;
  let retryTimer = null;

  const mintFailureCanRetry = (error) => {
    if (error?.terminal || error?.code === 'authentication_required') return false;
    const status = Number(error && error.status) || 0;
    return status === 0 || status === 408 || status === 429 || status >= 500;
  };

  const scheduleReconnect = () => {
    if (stopped || failures >= STREAM_MAX_CONSECUTIVE_FAILURES) return;
    const delay = Math.min(STREAM_RECONNECT_BASE_MS * 2 ** failures, STREAM_RECONNECT_MAX_MS);
    failures += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect().catch((error) => {
        // A rejected request (auth, permission, or invalid context) will not
        // heal through retries. Transient network/server failures retain the
        // bounded backoff used for EventSource disconnects.
        if (mintFailureCanRetry(error)) scheduleReconnect();
      });
    }, delay);
  };

  async function connect() {
    if (stopped) return;
    const minted = await mintToken();
    const token = typeof minted?.token === 'string' ? minted.token.trim() : '';
    if (!token) {
      const error = new Error('Stream token is unavailable.');
      error.code = 'stream_token_missing';
      error.terminal = true;
      throw error;
    }
    if (stopped) return;
    source = new EventSource(buildUrl(token, minted));
    source.onopen = () => { failures = 0; }; // a live connection resets the backoff
    source.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data));
      } catch (_) {
        /* comments/keepalives are not JSON */
      }
    };
    source.onerror = () => {
      // The native reconnect would reuse the (soon-)expired token, so take over:
      // close and re-mint after a backoff rather than let the stream die.
      if (stopped) return;
      try { source.close(); } catch (_) { /* ignore */ }
      scheduleReconnect();
    };
  }

  try {
    await connect();
  } catch (error) {
    // Preserve best-effort recovery for a temporary minting outage without
    // ever constructing an unauthenticated EventSource. Caller/actionable 4xx
    // responses still reject immediately.
    if (!mintFailureCanRetry(error)) throw error;
    scheduleReconnect();
  }
  return {
    close() {
      stopped = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (source) { try { source.close(); } catch (_) { /* ignore */ } }
    },
  };
}

export const api = {
  // Authentication
  getCurrentUser: (options = {}) => request('/auth/me', options),

  // Per-org deployment resolver. Returns { authenticated, status, gatewayUrl,
  // orgName } — which front-facing gateway this session should use. Always
  // fetched from the SHARED gateway (the bootstrap base) before any re-point.
  getRuntimeConfig: (options = {}) => request('/config', options),

  // End User License Agreement acceptance (gates "actual work" — see agent view).
  getEulaStatus: (options = {}) => request('/eula', options),
  recordEulaDecision: (decision, via = 'user') =>
    request('/eula', { method: 'POST', body: JSON.stringify({ decision, via }) }),

  // Settings
  getSettings: (options = {}) => request('/settings', options),

  // Projects
  getProjects: () => request('/projects'),
  getTeams: () => request('/projects/teams'),
  getMilestones: (projectId) => request(`/projects/${projectId}/milestones`),

  // Issues / board
  getBoard: (projectId) => request(`/issues/board/${projectId}`),
  moveIssue: (issueId, stateId) =>
    request(`/issues/${issueId}/state`, { method: 'PATCH', body: JSON.stringify({ stateId }) }),
  createProjectTask: (payload) =>
    request('/issues', { method: 'POST', body: JSON.stringify(payload) }),

  // Businesses
  getBusinesses: () => request('/businesses'),
  createBusiness: (payload) =>
    request('/businesses', { method: 'POST', body: JSON.stringify(payload) }),
  updateBusiness: (id, payload) =>
    request(`/businesses/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteBusiness: (id) => request(`/businesses/${id}`, { method: 'DELETE' }),

  // Local/hosted LLM and LangSmith settings
  getLlmPresets: () => request('/settings/llm-presets'),
  applyLlmPreset: (payload) =>
    request('/settings/llm-preset', { method: 'PUT', body: JSON.stringify(payload) }),
  applyLlmSelection: (payload) =>
    request('/settings/llm-selection', { method: 'PUT', body: JSON.stringify(payload) }),
  // Apply a curated complexity tier to every purpose role at once (the slider).
  applyLlmTier: (tier) =>
    request('/settings/complexity', { method: 'PUT', body: JSON.stringify({ tier }) }),
  saveLlm: (payload) => request('/settings/llm', { method: 'PUT', body: JSON.stringify(payload) }),
  saveLmstudio: (payload) => request('/settings/lmstudio', { method: 'PUT', body: JSON.stringify(payload) }),
  saveLangsmith: (payload) =>
    request('/settings/langsmith', { method: 'PUT', body: JSON.stringify(payload) }),
  saveIntegrations: (payload) =>
    request('/settings/integrations', { method: 'PUT', body: JSON.stringify(payload) }),
  saveAgentRuntime: (payload) =>
    request('/settings/runtime', { method: 'PUT', body: JSON.stringify(payload) }),
  getSettingsJson: () => request('/settings/json'),
  saveSettingsJson: (settings) =>
    request('/settings/json', { method: 'PUT', body: JSON.stringify({ settings }) }),
  getOllamaModels: () => request('/agent/ollama-models'),
  getLmstudioModels: () => request('/agent/lmstudio-models'),
  getOmlxModels: () => request('/agent/omlx-models'),
  getProviderModels: (provider, refresh = false) => {
    const suffix = `?refresh=${refresh ? '1' : '0'}`;
    if (provider === 'ollama') return request(`/agent/ollama-models${suffix}`);
    if (provider === 'lmstudio') return request(`/agent/lmstudio-models${suffix}`);
    if (provider === 'omlx') return request(`/agent/omlx-models${suffix}`);
    if (provider === 'codex' || provider === 'claude') {
      return request(`/settings/${provider}/models${suffix}`);
    }
    // Hugging Face has no live model-discovery endpoint (the router hosts many
    // thousands); the catalog presets and the manual model field cover selection.
    if (provider === 'huggingface') return Promise.resolve({ models: [], reachable: true, source: 'catalog' });
    // Antigravity (Gemini) has no live model-discovery endpoint here; the catalog
    // presets and the manual model field cover selection.
    if (provider === 'antigravity') return Promise.resolve({ models: [], reachable: true, source: 'catalog' });
    return Promise.reject(new Error(`Unsupported LLM provider: ${provider}`));
  },

  // Deep-agent provider selection + Codex (OpenAI via OAuth)
  setProvider: (llmProvider, role = 'global') =>
    request('/settings/provider', { method: 'PUT', body: JSON.stringify({ llmProvider, role }) }),
  getCodexStatus: () => request('/settings/codex'),
  saveCodex: (payload) => request('/settings/codex', { method: 'POST', body: JSON.stringify(payload) }),
  logoutCodex: () => request('/settings/codex', { method: 'DELETE' }),
  testCodex: () => request('/settings/codex/test', { method: 'POST' }),

  // Claude (Anthropic via OAuth). Paste-code flow: open the URL, paste code#state back.
  getClaudeStatus: () => request('/settings/claude'),
  startClaudeLogin: () => request('/settings/claude/login'),
  exchangeClaude: (code) => request('/settings/claude/exchange', { method: 'POST', body: JSON.stringify({ code }) }),
  saveClaude: (payload) => request('/settings/claude', { method: 'POST', body: JSON.stringify(payload) }),
  logoutClaude: () => request('/settings/claude', { method: 'DELETE' }),
  testClaude: () => request('/settings/claude/test', { method: 'POST' }),

  // Roles (assume member)
  getMembers: () => request('/roles/members'),
  getAssumedRole: () => request('/roles/assumed'),
  assumeRole: (id) => request('/roles/assumed', { method: 'PUT', body: JSON.stringify({ id }) }),
  clearRole: () => request('/roles/assumed', { method: 'DELETE' }),

  // Agent
  getAgentConfig: () => request('/agent/config'),
  saveAgentConfig: (payload) =>
    request('/agent/config', { method: 'PUT', body: JSON.stringify(payload) }),
  getAgentStatus: (options = {}) => request('/agent/status', options),
  getAgentModels: () => request('/agent/models'),
  getAgentLabels: () => request('/agent/labels'),
  getAgentCandidates: () => request('/agent/candidates'),
  getJobs: (options = {}) => request('/agent/jobs', options),
  getCoderStatus: (options = {}) => request('/coder', options),
  runAgentNow: () => request('/agent/run-now', { method: 'POST' }),
  enqueueProject: (payload) => request('/agent/enqueue', { method: 'POST', body: JSON.stringify(payload) }),
  // Short-lived token authorizing an EventSource (which cannot send a bearer header).
  getStreamToken: (conversationId) =>
    request(`/agent/stream-token?conversationId=${encodeURIComponent(conversationId)}`),
  // Open an SSE stream of a conversation's intermittent agent responses. Returns
  // a { close() } controller; onEvent receives each parsed event. Reconnection
  // (with a freshly-minted token) is handled internally — see openStream. The
  // Token-bound context returned by minting is repeated in the URL. Do not
  // re-read mutable requestContext here: the user may switch projects between
  // mint and EventSource construction.
  openAgentStream: (conversationId, onEvent) => openStream({
    mintToken: () => api.getStreamToken(conversationId),
    buildUrl: (token, minted) => `${getApiBase()}/api/agent/stream?conversationId=${encodeURIComponent(conversationId)}&t=${encodeURIComponent(token)}${mintedStreamContextQuerySuffix(minted)}`,
    onEvent,
  }),
  // Short-lived token authorizing the authenticated workspace EventSource.
  getWorkspaceStreamToken: () => request('/agent/workspace-stream-token'),
  // Open the workspace SSE stream — typed status/jobs/coder/gate snapshots that
  // replace the old 5s polling loops. Returns a { close() } controller; onEvent
  // receives each parsed event. Reconnection is handled internally (openStream).
  // The authoritative token-bound context is repeated in the URL.
  openWorkspaceStream: (onEvent) => openStream({
    mintToken: () => api.getWorkspaceStreamToken(),
    buildUrl: (token, minted) => `${getApiBase()}/api/agent/workspace-stream?t=${encodeURIComponent(token)}${mintedStreamContextQuerySuffix(minted)}`,
    onEvent,
  }),
  routeAgentMessage: (payload) =>
    request('/agent/message', { method: 'POST', body: JSON.stringify(payload) }),
  searchAgentKnowledge: (payload) =>
    request('/agent/knowledge-search', { method: 'POST', body: JSON.stringify(payload) }),
  // Typed workspace memory (user | business | project | task | workspace).
  searchMemory: (payload) =>
    request('/agent/memory-search', { method: 'POST', body: JSON.stringify(payload) }),
  saveMemory: (payload) =>
    request('/agent/memory', { method: 'POST', body: JSON.stringify(payload) }),
  listMemory: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/agent/memory${query ? `?${query}` : ''}`);
  },
  deleteMemory: (id) => request(`/agent/memory/${id}`, { method: 'DELETE' }),
  // Requirement-readiness preflight — runs before the pipeline; returns a signal + criteria.
  evaluateBusiness: (payload) =>
    request('/agent/business/evaluate', { method: 'POST', body: JSON.stringify(payload) }),
  // Durable approval gates for amber/red requirements (poll, approve, refine).
  getBusinessGate: (id) => request(`/agent/business/gates/${id}`),
  approveBusinessGate: (id) =>
    request(`/agent/business/gates/${id}/approve`, { method: 'POST' }),
  reevaluateBusinessGate: (id, input) =>
    request(`/agent/business/gates/${id}/reevaluate`, { method: 'POST', body: JSON.stringify({ input }) }),
  // On-demand 6-step business pipeline (fraud, revenue, memory, spec, design, scheduler).
  prepareBusiness: (payload) =>
    request('/agent/business/prepare', { method: 'POST', body: JSON.stringify(payload) }),
  // Conversation threads (agent workspace history).
  listConversations: (options = {}) => request('/agent/conversations', options),
  createConversation: (payload = {}) =>
    request('/agent/conversations', { method: 'POST', body: JSON.stringify(payload) }),
  getConversation: (id, options = {}) => request(`/agent/conversations/${id}`, options),
  appendConversationMessages: (id, messages) =>
    request(`/agent/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ messages }) }),
  renameConversation: (id, title) =>
    request(`/agent/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteConversation: (id) => request(`/agent/conversations/${id}`, { method: 'DELETE' }),
  enrichInput: (payload) =>
    request('/agent/enrich-input', { method: 'POST', body: JSON.stringify(payload) }),
  settingsCommand: (payload) =>
    request('/agent/settings-command', { method: 'POST', body: JSON.stringify(payload) }),
  clearFinishedJobs: () => request('/agent/jobs', { method: 'DELETE' }),
  deleteJob: (id) => request(`/agent/jobs/${id}`, { method: 'DELETE' }),

  // Locale suggestions use browser language hints plus best-effort server IP
  // geolocation. Translation always runs through the configured local model.
  getLocaleSuggestions: (languages = [], options = {}) => {
    const query = new URLSearchParams({ languages: languages.join(',') });
    return request(`/locale/suggestions?${query}`, options);
  },
  translateUi: (payload) =>
    request('/locale/translate', { method: 'POST', body: JSON.stringify(payload) }),

  // Operational views backed by bounded LangSmith and local health queries.
  getAnalytics: () => request('/observability/analytics'),
  getTroubleshooting: () => request('/observability/troubleshooting'),

  // Cost monitoring + billing (services/gateway/src/routes/billing.js). The org
  // is resolved SERVER-SIDE from the caller's token — the client never sends an
  // org id. Mutations require org-admin (enforced server-side).
  billing: {
    getSummary: () => request('/billing/summary'),
    getUsage: (groupBy = 'project', period = 'week') =>
      request(`/billing/usage?groupBy=${encodeURIComponent(groupBy)}&period=${encodeURIComponent(period)}`),
    getTaskUsage: (taskId) => request(`/billing/usage/task/${encodeURIComponent(taskId)}`),
    getLedger: (limit = 50) => request(`/billing/ledger?limit=${encodeURIComponent(limit)}`),
    recharge: (amountInr) => request('/billing/recharge', { method: 'POST', body: JSON.stringify({ amountInr }) }),
    updateConfig: (payload) => request('/billing/config', { method: 'PUT', body: JSON.stringify(payload) }),
  },

  // Organization service (services/org via /api/org/*). The `me` surface is
  // available to any signed-in user (personal projects + create-org); the org
  // tenant surface needs an org role and the org service enforces per-org RBAC.
  org: {
    // Personal workspace (org-less friendly) — /api/org/me/*
    getMe: () => request('/org/me'),
    getContext: () => request('/org/me/context'),
    createOrganization: (payload) =>
      request('/org/me/organizations', { method: 'POST', body: JSON.stringify(payload) }),
    listPersonalProjects: () => request('/org/me/projects'),
    createPersonalProject: (payload) =>
      request('/org/me/projects', { method: 'POST', body: JSON.stringify(payload) }),
    getPersonalProject: (id) => request(`/org/me/projects/${id}`),
    updatePersonalProject: (id, payload) =>
      request(`/org/me/projects/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
    deletePersonalProject: (id) => request(`/org/me/projects/${id}`, { method: 'DELETE' }),

    // Organization tenant surface — /api/org/*
    getCurrentOrganization: () => request('/org/organizations/current'),
    listOrgProjects: () => request('/org/projects'),
    createOrgProject: (payload) =>
      request('/org/projects', { method: 'POST', body: JSON.stringify(payload) }),
    listOrgUsers: () => request('/org/users'),
    listInvitations: () => request('/org/invitations'),
    createInvitation: (payload) =>
      request('/org/invitations', { method: 'POST', body: JSON.stringify(payload) }),
    resendInvitation: (id) =>
      request(`/org/invitations/${encodeURIComponent(id)}/resend`, { method: 'POST' }),
    revokeInvitation: (id) =>
      request(`/org/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    acceptInvitation: (token) =>
      request('/org/invitations/accept', { method: 'POST', body: JSON.stringify({ token }) }),
    listProjectMembers: (projectId) => request(`/org/projects/${projectId}/members`),
    addProjectMember: (projectId, payload) =>
      request(`/org/projects/${projectId}/members`, { method: 'POST', body: JSON.stringify(payload) }),
    removeProjectMember: (projectId, userId) =>
      request(`/org/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),
  },

  // Settings-policy service (services/settings via /api/settings-policy/*). Stores
  // the org→project→user include/exclude cascade for harness/tools/skills/plugins.
  // The `me` surface is auth-only; org/project surfaces need an org role and the
  // service enforces per-org / per-project RBAC (cross-org → 404).
  settingsPolicy: {
    // Item universe (choices) + the caller's resolved effective policy.
    getUniverse: () => request('/settings-policy/settings/universe'),
    getEffective: (projectId) =>
      request(`/settings-policy/settings/effective${projectId ? `?project_id=${projectId}` : ''}`),
    preflight: (payload) =>
      request('/settings-policy/settings/preflight', { method: 'POST', body: JSON.stringify(payload) }),

    // Org-scope policy (org admin).
    getOrgPolicy: () => request('/settings-policy/settings/org'),
    setOrgPolicy: (payload) =>
      request('/settings-policy/settings/org', { method: 'PUT', body: JSON.stringify(payload) }),

    // Project-scope policy (project admin, org-scoped).
    getProjectPolicy: (projectId) => request(`/settings-policy/settings/project/${projectId}`),
    setProjectPolicy: (projectId, payload) =>
      request(`/settings-policy/settings/project/${projectId}`, { method: 'PUT', body: JSON.stringify(payload) }),

    // User-scope policy (any signed-in user) — /api/settings-policy/me/*
    getMyPolicy: () => request('/settings-policy/me/settings'),
    setMyPolicy: (payload) =>
      request('/settings-policy/me/settings', { method: 'PUT', body: JSON.stringify(payload) }),

    // Per-scope OPERATIONAL prefs (readable, non-secret; merge semantics). These
    // are the scope-ladder overrides for complexity/provider/runtime/tracker/
    // tracing; the effective response resolves them user > project > org.
    setOrgPrefs: (prefs) =>
      request('/settings-policy/settings/org', { method: 'PUT', body: JSON.stringify({ prefs }) }),
    setProjectPrefs: (projectId, prefs) =>
      request(`/settings-policy/settings/project/${projectId}`, { method: 'PUT', body: JSON.stringify({ prefs }) }),
    setMyPrefs: (prefs) =>
      request('/settings-policy/me/settings', { method: 'PUT', body: JSON.stringify({ prefs }) }),

    // Per-scope pref LOCKS (REPLACE semantics — the full list replaces this
    // scope's locks). A locked pref key can't be overridden by a lower scope.
    setOrgLocks: (locks) =>
      request('/settings-policy/settings/org', { method: 'PUT', body: JSON.stringify({ locks }) }),
    setProjectLocks: (projectId, locks) =>
      request(`/settings-policy/settings/project/${projectId}`, { method: 'PUT', body: JSON.stringify({ locks }) }),

    // Per-org KMS-encrypted secret VAULT (org admin). This is the credential
    // source proxied agents read (via the settings service S2S resolver), with a
    // per-key source capability. Write-only: GET returns only
    // `{set, source, allowed_sources}`. A combined values+selection PUT is atomic;
    // the dedicated selection routes remain for older clients.
    getOrgSecrets: () => request('/settings-policy/settings/org/secrets'),
    setOrgSecrets: (values, selection = undefined) =>
      request('/settings-policy/settings/org/secrets', {
        method: 'PUT',
        body: JSON.stringify({ values, ...(selection ? { selection } : {}) }),
      }),
    setOrgSecretSelection: (selection) =>
      request('/settings-policy/settings/org/secrets/selection', { method: 'PUT', body: JSON.stringify({ selection }) }),
    getProjectSecrets: (projectId) =>
      request(`/settings-policy/settings/project/${projectId}/secrets`),
    setProjectSecrets: (projectId, values, selection = undefined) =>
      request(`/settings-policy/settings/project/${projectId}/secrets`, {
        method: 'PUT',
        body: JSON.stringify({ values, ...(selection ? { selection } : {}) }),
      }),
    setProjectSecretSelection: (projectId, selection) =>
      request(`/settings-policy/settings/project/${projectId}/secrets/selection`, {
        method: 'PUT', body: JSON.stringify({ selection }),
      }),

    // Non-secret org connector routing metadata. Jira origins are validated by
    // settings service as HTTPS Atlassian Cloud origins.
    getOrgConnectors: () => request('/settings-policy/settings/org/connectors'),
    setOrgConnectors: (payload) =>
      request('/settings-policy/settings/org/connectors', { method: 'PUT', body: JSON.stringify(payload) }),
    getConnectorReadiness: (projectId) =>
      request(`/settings-policy/settings/org/connectors/readiness${projectId ? `?project_id=${projectId}` : ''}`),
  },
};
