// Thin fetch wrapper around the backend API.

let accessTokenProvider = null;

export function setAccessTokenProvider(provider) {
  accessTokenProvider = typeof provider === 'function' ? provider : null;
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
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
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

  const res = await fetch(`${getApiBase()}/api${path}`, {
    ...options,
    headers,
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    /* empty body */
  }
  if (!res.ok) {
    // The gateway returns { error: "msg", code }; the org service returns a
    // nested envelope { error: { code, message } }. Support both shapes.
    const nested = data.error && typeof data.error === 'object' ? data.error : null;
    const message = nested ? nested.message : data.error;
    const error = new Error(message || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = data.code || (nested && nested.code) || '';
    // Connected tools can also return 401. Lock the whole workspace only when
    // the gateway identified an application-auth failure (or while confirming
    // the current application identity), not for an unrelated provider key.
    if (res.status === 401 && (error.code === 'authentication_required' || path === '/auth/me')) {
      notifyAuthenticationRequired(error);
    }
    throw error;
  }
  return data;
}

export const api = {
  // Authentication
  getCurrentUser: () => request('/auth/me'),

  // Per-org deployment resolver. Returns { authenticated, status, gatewayUrl,
  // orgName } — which front-facing gateway this session should use. Always
  // fetched from the SHARED gateway (the bootstrap base) before any re-point.
  getRuntimeConfig: () => request('/config'),

  // End User License Agreement acceptance (gates "actual work" — see agent view).
  getEulaStatus: () => request('/eula'),
  recordEulaDecision: (decision, via = 'user') =>
    request('/eula', { method: 'POST', body: JSON.stringify({ decision, via }) }),

  // Settings
  getSettings: (options = {}) => request('/settings', options),
  saveKey: (linearApiKey) =>
    request('/settings', { method: 'PUT', body: JSON.stringify({ linearApiKey }) }),
  validate: (options = {}) => request('/settings/validate', options),
  clearKey: () => request('/settings', { method: 'DELETE' }),

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
  saveGithubToken: (githubToken) =>
    request('/settings/github', { method: 'PUT', body: JSON.stringify({ githubToken }) }),
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
  startCodexLogin: () => request('/settings/codex/login'),
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
  getAgentStatus: () => request('/agent/status'),
  getAgentModels: () => request('/agent/models'),
  getAgentLabels: () => request('/agent/labels'),
  getAgentCandidates: () => request('/agent/candidates'),
  getJobs: () => request('/agent/jobs'),
  getCoderStatus: () => request('/coder'),
  runAgentNow: () => request('/agent/run-now', { method: 'POST' }),
  enqueueProject: (payload) => request('/agent/enqueue', { method: 'POST', body: JSON.stringify(payload) }),
  // Short-lived token authorizing an EventSource (which cannot send a bearer header).
  getStreamToken: (conversationId) =>
    request(`/agent/stream-token?conversationId=${encodeURIComponent(conversationId)}`),
  // Open an SSE stream of a conversation's intermittent agent responses. Returns
  // the EventSource so callers can close() it; onEvent receives each parsed event.
  openAgentStream: async (conversationId, onEvent, onError) => {
    let token = '';
    try {
      ({ token } = await api.getStreamToken(conversationId));
    } catch (_) {
      /* auth disabled locally → the stream token is optional */
    }
    const url = `${getApiBase()}/api/agent/stream?conversationId=${encodeURIComponent(conversationId)}&t=${encodeURIComponent(token || '')}`;
    const source = new EventSource(url);
    source.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data));
      } catch (_) {
        /* comments/keepalives are not JSON */
      }
    };
    if (typeof onError === 'function') source.onerror = onError;
    return source;
  },
  // Short-lived token authorizing the GLOBAL workspace EventSource. workspace:read,
  // so the public read-only home can subscribe.
  getWorkspaceStreamToken: () => request('/agent/workspace-stream-token'),
  // Open the workspace SSE stream — typed status/jobs/coder/gate snapshots that
  // replace the old 5s polling loops. Returns the EventSource so callers can
  // close() it; onEvent receives each parsed event.
  openWorkspaceStream: async (onEvent, onError) => {
    let token = '';
    try {
      ({ token } = await api.getWorkspaceStreamToken());
    } catch (_) {
      /* auth disabled locally → the stream token is optional */
    }
    const url = `${getApiBase()}/api/agent/workspace-stream?t=${encodeURIComponent(token || '')}`;
    const source = new EventSource(url);
    source.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data));
      } catch (_) {
        /* comments/keepalives are not JSON */
      }
    };
    if (typeof onError === 'function') source.onerror = onError;
    return source;
  },
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
  listConversations: () => request('/agent/conversations'),
  createConversation: (payload = {}) =>
    request('/agent/conversations', { method: 'POST', body: JSON.stringify(payload) }),
  getConversation: (id) => request(`/agent/conversations/${id}`),
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
  getLocaleSuggestions: (languages = []) => {
    const query = new URLSearchParams({ languages: languages.join(',') });
    return request(`/locale/suggestions?${query}`);
  },
  translateUi: (payload) =>
    request('/locale/translate', { method: 'POST', body: JSON.stringify(payload) }),

  // Operational views backed by bounded LangSmith and local health queries.
  getAnalytics: () => request('/observability/analytics'),
  getTroubleshooting: () => request('/observability/troubleshooting'),

  // Organization service (services/org via /api/org/*). The `me` surface is
  // available to any signed-in user (personal projects + create-org); the org
  // tenant surface needs an org role and the org service enforces per-org RBAC.
  org: {
    // Personal workspace (org-less friendly) — /api/org/me/*
    getMe: () => request('/org/me'),
    createOrganization: (payload) =>
      request('/org/me/organization', { method: 'POST', body: JSON.stringify(payload) }),
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
    createOrgUser: (payload) =>
      request('/org/users', { method: 'POST', body: JSON.stringify(payload) }),
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

    // Config VALUES (provider API keys, e.g. geminiApiKey). Write-only: the PUT
    // takes plaintext and reads back only `values.<key>.set` (never the secret).
    // Sent alone (no `domains`), so the scope's include/exclude policy is
    // preserved. An empty string clears a stored key.
    setOrgConfig: (values) =>
      request('/settings-policy/settings/org', { method: 'PUT', body: JSON.stringify({ values }) }),
    setProjectConfig: (projectId, values) =>
      request(`/settings-policy/settings/project/${projectId}`, { method: 'PUT', body: JSON.stringify({ values }) }),
    setMyConfig: (values) =>
      request('/settings-policy/me/settings', { method: 'PUT', body: JSON.stringify({ values }) }),

    // Per-org KMS-encrypted secret VAULT (org admin). This is the credential
    // source proxied agents read (via the settings service S2S resolver), with a
    // per-key managed-vs-customer selection. Write-only: GET masks each key to
    // `{set, source}`; PUT takes plaintext (empty string clears); selection sets
    // managed|customer. Reached via the same /api/settings-policy proxy.
    getOrgSecrets: () => request('/settings-policy/settings/org/secrets'),
    setOrgSecrets: (values) =>
      request('/settings-policy/settings/org/secrets', { method: 'PUT', body: JSON.stringify({ values }) }),
    setOrgSecretSelection: (selection) =>
      request('/settings-policy/settings/org/secrets/selection', { method: 'PUT', body: JSON.stringify({ selection }) }),
  },
};
