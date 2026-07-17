// Thin fetch wrapper around the backend API.

let accessTokenProvider = null;

export function setAccessTokenProvider(provider) {
  accessTokenProvider = typeof provider === 'function' ? provider : null;
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

  const res = await fetch(`/api${path}`, {
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
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = data.code || '';
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

  // Businesses
  getBusinesses: () => request('/businesses'),
  createBusiness: (payload) =>
    request('/businesses', { method: 'POST', body: JSON.stringify(payload) }),
  updateBusiness: (id, payload) =>
    request(`/businesses/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteBusiness: (id) => request(`/businesses/${id}`, { method: 'DELETE' }),

  // LLM (Ollama / LM Studio) / LangSmith settings
  getLlmPresets: () => request('/settings/llm-presets'),
  applyLlmPreset: (payload) =>
    request('/settings/llm-preset', { method: 'PUT', body: JSON.stringify(payload) }),
  applyLlmSelection: (payload) =>
    request('/settings/llm-selection', { method: 'PUT', body: JSON.stringify(payload) }),
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
  getOllamaModels: () => request('/agent/ollama-models'),
  getLmstudioModels: () => request('/agent/lmstudio-models'),
  getProviderModels: (provider, refresh = false) => {
    const suffix = `?refresh=${refresh ? '1' : '0'}`;
    if (provider === 'ollama') return request(`/agent/ollama-models${suffix}`);
    if (provider === 'lmstudio') return request(`/agent/lmstudio-models${suffix}`);
    if (provider === 'codex' || provider === 'claude') {
      return request(`/settings/${provider}/models${suffix}`);
    }
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
  enrichInput: (payload) =>
    request('/agent/enrich-input', { method: 'POST', body: JSON.stringify(payload) }),
  analyzeTrace: (payload) =>
    request('/agent/analyze-trace', { method: 'POST', body: JSON.stringify(payload) }),
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
  getWorkflowPatterns: () => request('/observability/workflows'),
};
