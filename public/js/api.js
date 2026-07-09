// Thin fetch wrapper around the backend API.

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    /* empty body */
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  // Settings
  getSettings: () => request('/settings'),
  saveKey: (linearApiKey) =>
    request('/settings', { method: 'PUT', body: JSON.stringify({ linearApiKey }) }),
  validate: () => request('/settings/validate'),
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
  saveLlm: (payload) => request('/settings/llm', { method: 'PUT', body: JSON.stringify(payload) }),
  saveLmstudio: (payload) => request('/settings/lmstudio', { method: 'PUT', body: JSON.stringify(payload) }),
  saveLangsmith: (payload) =>
    request('/settings/langsmith', { method: 'PUT', body: JSON.stringify(payload) }),
  saveGithubToken: (githubToken) =>
    request('/settings/github', { method: 'PUT', body: JSON.stringify({ githubToken }) }),
  getOllamaModels: () => request('/agent/ollama-models'),
  getLmstudioModels: () => request('/agent/lmstudio-models'),

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
  runAgentNow: () => request('/agent/run-now', { method: 'POST' }),
  clearFinishedJobs: () => request('/agent/jobs', { method: 'DELETE' }),
  deleteJob: (id) => request(`/agent/jobs/${id}`, { method: 'DELETE' }),
};
