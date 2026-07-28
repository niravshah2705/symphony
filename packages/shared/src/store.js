'use strict';

const fs = require('fs');
const { randomUUID } = require('node:crypto');
const { CONFIG } = require('./config');
const {
  getPreset,
  presetForModel,
  settingsPatchForPreset,
  publicCatalog,
  modelMatchesPreset,
  MODEL_ROLES,
} = require('./agent/model-presets');

const PRESET_CATALOG = publicCatalog();
const DEFAULT_LOCAL_PRESET = getPreset(PRESET_CATALOG.defaults.local);
const DEFAULT_HOSTED_PRESET = getPreset(PRESET_CATALOG.defaults.hosted);

function recommendedPreset(provider) {
  return PRESET_CATALOG.presets.find((preset) => preset.provider === provider && preset.recommended)
    || PRESET_CATALOG.presets.find((preset) => preset.provider === provider);
}

function configuredModel(provider) {
  if (provider === 'codex') {
    return CONFIG.OAUTH.backend === 'chatgpt' ? CONFIG.OAUTH.chatgptModel : CONFIG.OAUTH.defaultModel;
  }
  if (provider === 'claude') return CONFIG.CLAUDE.defaultModel;
  return recommendedPreset(provider).model;
}

function applyLegacyHostedReasoningDefaults(settings, storedSettings) {
  for (const provider of ['codex', 'claude']) {
    const effortKey = `${provider}ReasoningEffort`;
    const adapterKey = `${provider}ReasoningAdapter`;
    const missingReasoning = !Object.prototype.hasOwnProperty.call(storedSettings, effortKey) &&
      !Object.prototype.hasOwnProperty.call(storedSettings, adapterKey);
    const model = storedSettings[`${provider}Model`] || configuredModel(provider);
    const preset = missingReasoning ? presetForModel(provider, model) : null;
    if (preset) {
      settings[effortKey] = preset.parameters.reasoning.effort;
      settings[adapterKey] = preset.capabilities.reasoningAdapter;
    }
  }
  return settings;
}

/** Keep model-specific adapters only when an environment model matches the preset. */
function settingsForConfiguredModel(preset, model = configuredModel(preset.provider)) {
  const patch = settingsPatchForPreset(preset, { model });
  if (modelMatchesPreset(preset, model)) return patch;
  if (preset.provider === 'codex') {
    return {
      ...patch,
      codexModel: model,
      codexContextWindow: 128000,
      codexMaxTokens: 4096,
      codexTemperature: null,
      codexReasoningEffort: 'none',
      codexReasoningAdapter: 'none',
    };
  }
  return {
    ...patch,
    claudeModel: model,
    claudeContextWindow: 200000,
    claudeMaxTokens: 4096,
    claudeTemperature: null,
    claudeReasoningEffort: 'none',
    claudeReasoningAdapter: 'none',
    // Stream Claude responses. Must stay on for large max output — a non-streaming
    // request with a big maxTokens trips the Anthropic SDK's 10-minute guard.
    // Editable from Settings (default on); see createClaudeModel in agent/llm.js.
    claudeStreaming: true,
  };
}

const DEFAULT_OLLAMA_SETTINGS = settingsPatchForPreset(recommendedPreset('ollama'));
const DEFAULT_LMSTUDIO_SETTINGS = settingsPatchForPreset(recommendedPreset('lmstudio'));
const DEFAULT_OMLX_SETTINGS = settingsPatchForPreset(recommendedPreset('omlx'));
const DEFAULT_CODEX_SETTINGS = settingsForConfiguredModel(recommendedPreset('codex'));
const DEFAULT_CLAUDE_SETTINGS = settingsForConfiguredModel(recommendedPreset('claude'));
// The exact catalog defaults win over a same-provider recommended preset. This
// keeps changing `defaults.local/hosted` in JSON sufficient to change new installs.
const DEFAULT_ACTIVE_LOCAL_SETTINGS = settingsPatchForPreset(DEFAULT_LOCAL_PRESET);
const DEFAULT_ACTIVE_HOSTED_SETTINGS = settingsForConfiguredModel(DEFAULT_HOSTED_PRESET);
const DEFAULT_HOSTED_MODEL = configuredModel(DEFAULT_HOSTED_PRESET.provider);
// The preset id a fresh hosted slot resolves to (or 'custom' when the configured
// model diverges from the catalog default). Purpose roles seed from this too.
const DEFAULT_HOSTED_PRESET_ID = modelMatchesPreset(DEFAULT_HOSTED_PRESET, DEFAULT_HOSTED_MODEL)
  ? DEFAULT_HOSTED_PRESET.id
  : 'custom';

/**
 * Tiny JSON-file backed store for local settings, the business -> project
 * mapping, the currently assumed role, agent configuration, and enrichment
 * jobs. All updates return a new object (no in-place mutation).
 *
 * Secrets (API keys) live only in this server-side file. They are never
 * returned raw to the browser — routes mask them.
 */

const DEFAULT_AGENT_CONFIG = Object.freeze({
  parallelProcessing: 2, // concurrent projects per scheduler tick
  // Max coding tasks the board monitor runs at once (across and within projects).
  // Seeds from CODER_MAX_CONCURRENT for back-compat; editable from the UI.
  maxConcurrentCoders: Number(process.env.CODER_MAX_CONCURRENT) || 3,
  scheduleEnabled: true, // run the 5-minute scheduler
  autoAssignLead: true, // assign the assumed role as project lead on enrich
  autoLabelNewProjects: true, // attach the enrichLabels to a project created for a new business
  createIssues: true, // create issues per milestone
  addDependencies: true, // create issue dependencies via LLM decisions
  maxProjectsPerRun: 5, // hard cap of projects processed per tick
  maxMilestones: 6, // cap milestones the LLM may create per project
  maxIssuesPerMilestone: 5, // cap issues per milestone
  enrichLabels: ['AI'], // open projects with ANY of these labels are auto-enriched
  intervalMinutes: 5, // scheduler cadence (5 | 10 | 15)
});

const DEFAULT_STORE = Object.freeze({
  settings: {
    linearApiKey: '',
    // External work-management and source-control connectors. The selected
    // providers are public UI preferences; every credential remains in this
    // server-side store and is only exposed through masked status fields.
    planningProvider: 'linear',
    jiraBaseUrl: '',
    jiraEmail: '',
    jiraApiToken: '',
    asanaWorkspaceId: '',
    asanaAccessToken: '',
    repositoryProvider: 'github',
    repositoryUrl: '',
    gitlabToken: '',
    // Deep-agent LLM providers. Two role slots choose a local provider
    // ('ollama' / 'lmstudio' / 'omlx') or hosted provider ('codex' / 'claude'):
    //   llmProvider      — GLOBAL (hosted) slot: used by the planner and by the
    //                      coder for hosted-labeled (and unlabeled) issues.
    //   localLlmProvider — LOCAL slot: used by the coder for "local"-labeled (XS)
    //                      issues only.
    // New installs start with one useful local preset and one hosted preset. An
    // existing store is migrated to "custom" below so its hand-tuned values are
    // never silently replaced by a catalog recommendation.
    llmProvider: DEFAULT_HOSTED_PRESET.provider,
    localLlmProvider: DEFAULT_LOCAL_PRESET.provider,
    hostedLlmPresetId: DEFAULT_HOSTED_PRESET_ID,
    localLlmPresetId: DEFAULT_LOCAL_PRESET.id,
    // Purpose-based model roles ("models as tasks"). Each names one of the four
    // providers and reuses that provider's shared config block below. New
    // installs point every role at the hosted slot; an operator can independently
    // repoint any role (including at a local provider). Consumers:
    //   thinking  → the planner, execution → the coder, testing → reserved.
    thinkingLlmProvider: DEFAULT_HOSTED_PRESET.provider,
    thinkingLlmPresetId: DEFAULT_HOSTED_PRESET_ID,
    executionLlmProvider: DEFAULT_HOSTED_PRESET.provider,
    executionLlmPresetId: DEFAULT_HOSTED_PRESET_ID,
    testingLlmProvider: DEFAULT_HOSTED_PRESET.provider,
    testingLlmPresetId: DEFAULT_HOSTED_PRESET_ID,
    ollamaHost: 'http://localhost:11434',
    ...DEFAULT_OLLAMA_SETTINGS,
    // LM Studio (local, OpenAI-compatible API) — an alternative local provider for
    // models not available in Ollama. No credentials; the browser chooses host + model.
    lmstudioHost: 'http://localhost:1234',
    // The context length the model is loaded with in LM Studio (n_ctx). LM Studio
    // fixes this at load time and does not accept it per-request, so the operator
    // sets it here to MATCH the loaded context. It bounds max_tokens (below) so we
    // never request more output than the window holds; the deep-agent prompt is
    // large (~10k tokens), so load the model with a generous context (>= 16384).
    // max_tokens (output budget). The plan JSON is large and reasoning models
    // spend additional tokens thinking, so small generic defaults can truncate it.
    // The selected preset supplies this value; it is capped against the declared
    // LM Studio context at save and request time.
    // JSON constraint: 'text' (prompt-driven; most compatible) | 'json_object' | 'json_schema'.
    // Some engines (e.g. the ornith runtime) reject 'json_object', so 'text' is the safe default.
    // Context-window management for long coder runs (the deep agent re-sends its
    // whole growing history each turn; a fixed window eventually overflows). Only
    // acts when the prompt exceeds the window. 'summarize' condenses old turns into
    // a note and keeps recent turns verbatim; 'trim' drops old turns; 'none' sends
    // as-is. 'summarize' preserves the most context (at the cost of extra LLM calls).
    ...DEFAULT_LMSTUDIO_SETTINGS,
    // oMLX (local Apple-Silicon inference, OpenAI-compatible API). Authentication
    // is optional; when present the key remains server-side and is only exposed
    // through masked status fields.
    omlxHost: CONFIG.OMLX.defaultHost,
    omlxApiKey: '',
    ...DEFAULT_OMLX_SETTINGS,
    // Codex (OpenAI) provider — endpoints/client come from CONFIG.OAUTH (trusted),
    // the browser only chooses the model. Tokens live server-side only.
    ...DEFAULT_CODEX_SETTINGS,
    codexTokens: null, // OAuth token set { accessToken, refreshToken, ... } — never sent to the browser
    // Claude (Anthropic) provider — "Sign in with Claude" OAuth. Endpoints/client
    // come from CONFIG.CLAUDE (trusted); the browser only chooses the model.
    // Output token budget. The business-plan JSON is large (milestones + issues +
    // per-item criteria), so the selected preset supplies enough headroom while
    // the model still stops naturally at end_turn.
    ...DEFAULT_CLAUDE_SETTINGS,
    ...DEFAULT_ACTIVE_LOCAL_SETTINGS,
    ...DEFAULT_ACTIVE_HOSTED_SETTINGS,
    claudeTokens: null, // OAuth token set — never sent to the browser
    // GitHub token (fine-grained PAT) for the code-writer's git clone/push against
    // the configured repo. Stored server-side only; masked in responses, never logged.
    githubToken: '',
    langsmithApiKey: '', // LangSmith tracing key
    langsmithProject: 'linear-manager',
    langsmithEndpoint: 'https://api.smith.langchain.com',
    langsmithTracing: true,
    // Provider-neutral execution engine and bounded orchestration pattern.
    // Existing installations inherit these values through the store merge.
    agentRuntime: 'deepagent',
    workflowPattern: 'sequential',
  },
  businesses: [
    {
      id: 'ota',
      name: 'OTA',
      description: 'Online Travel Agency — initial business.',
      projectId: null,
      repoProvider: 'github',
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  assumedRole: null, // { id, name, email } — the member currently assumed
  agentConfig: DEFAULT_AGENT_CONFIG,
  jobs: [], // enrichment jobs (see routes/agent.js)
  memories: [], // typed workspace memory records (see agent/memory.js)
  conversations: [], // agent workspace conversation threads (see agent/conversations.js)
});

function ensureDataDir() {
  if (!fs.existsSync(CONFIG.DATA_DIR)) {
    fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  }
}

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_STORE));
}

/**
 * Back-compat for business repositories created before provider identity was
 * persisted. Those references were explicitly GitHub-only, so pin them to
 * GitHub instead of interpreting them through the current global connector.
 */
function migrateBusinessRepositories(businesses) {
  return businesses.map((business) => {
    if (!business || typeof business !== 'object' || business.repoProvider !== undefined) return business;
    return { ...business, repoProvider: 'github' };
  });
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG.STORE_FILE)) {
    const seed = cloneDefault();
    writeStore(seed);
    return seed;
  }
  try {
    const raw = fs.readFileSync(CONFIG.STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const base = cloneDefault();
    const storedSettings = parsed.settings || {};
    const settings = { ...base.settings, ...storedSettings };
    // Preset ids did not exist before catalog v1. Treat legacy settings as
    // customized instead of claiming they match (and possibly later reapplying)
    // a new default preset.
    if (!Object.prototype.hasOwnProperty.call(storedSettings, 'localLlmPresetId')) {
      settings.localLlmPresetId = 'custom';
    }
    if (!Object.prototype.hasOwnProperty.call(storedSettings, 'hostedLlmPresetId')) {
      settings.hostedLlmPresetId = 'custom';
    }
    // Purpose-based model roles did not exist before this migration. Seed each
    // absent role from the operator's effective hosted slot so an existing
    // install keeps its current planner/coder model (previously always the
    // hosted slot) instead of jumping to a catalog default. The `local`/`global`
    // slots are preserved untouched for localization and diagnostics.
    for (const role of MODEL_ROLES) {
      const providerKey = `${role}LlmProvider`;
      const presetKey = `${role}LlmPresetId`;
      if (!Object.prototype.hasOwnProperty.call(storedSettings, providerKey)) {
        settings[providerKey] = settings.llmProvider;
        settings[presetKey] = settings.hostedLlmPresetId;
      }
    }
    // Preserve explicitly configured legacy request shapes. When both hosted
    // reasoning fields are absent, however, activate the reviewed default for
    // the effective known model. This keeps the visible model-aware default and
    // the actual runtime request in sync without overwriting an explicit Off.
    for (const prefix of ['ollama', 'lmstudio', 'codex', 'claude']) {
      const effortKey = `${prefix}ReasoningEffort`;
      const adapterKey = `${prefix}ReasoningAdapter`;
      if (!Object.prototype.hasOwnProperty.call(storedSettings, effortKey)) settings[effortKey] = null;
      if (!Object.prototype.hasOwnProperty.call(storedSettings, adapterKey)) settings[adapterKey] = 'none';
    }
    applyLegacyHostedReasoningDefaults(settings, storedSettings);
    // Sampling fields were previously hard-coded in the provider factory. Keep
    // those request shapes for legacy custom settings until a preset is chosen.
    if (!Object.prototype.hasOwnProperty.call(storedSettings, 'ollamaTemperature')) settings.ollamaTemperature = 0;
    if (!Object.prototype.hasOwnProperty.call(storedSettings, 'lmstudioTemperature')) settings.lmstudioTemperature = 0;
    if (!Object.prototype.hasOwnProperty.call(storedSettings, 'codexTemperature')) settings.codexTemperature = 0;
    for (const prefix of ['ollama', 'lmstudio']) {
      for (const suffix of ['TopP', 'TopK', 'RepeatPenalty']) {
        const key = `${prefix}${suffix}`;
        if (!Object.prototype.hasOwnProperty.call(storedSettings, key)) settings[key] = null;
      }
    }
    return {
      ...base,
      ...parsed,
      settings,
      businesses: migrateBusinessRepositories(Array.isArray(parsed.businesses) ? parsed.businesses : base.businesses),
      assumedRole: parsed.assumedRole || null,
      agentConfig: migrateAgentConfig({ ...base.agentConfig, ...(parsed.agentConfig || {}) }),
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      memories: Array.isArray(parsed.memories) ? parsed.memories : [],
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
    };
  } catch (err) {
    return cloneDefault();
  }
}

function writeStore(store) {
  ensureDataDir();
  fs.writeFileSync(CONFIG.STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
  return store;
}

/** Back-compat: convert legacy single `enrichLabel` into `enrichLabels[]`. */
function migrateAgentConfig(config) {
  const next = { ...config };
  if (!Array.isArray(next.enrichLabels)) {
    next.enrichLabels = next.enrichLabel ? [next.enrichLabel] : ['AI'];
  }
  delete next.enrichLabel;
  if (!next.intervalMinutes) next.intervalMinutes = 5;
  const coders = Number(next.maxConcurrentCoders);
  next.maxConcurrentCoders = Number.isFinite(coders) && coders >= 1
    ? Math.min(8, Math.floor(coders))
    : DEFAULT_AGENT_CONFIG.maxConcurrentCoders;
  // Legacy Anthropic-era fields — LLM config now lives in settings.
  delete next.model;
  delete next.maxTokens;
  return next;
}

/* --------------------------- Settings / secrets ------------------------- */

function getApiKey() {
  return readStore().settings.linearApiKey || '';
}

function setApiKey(linearApiKey) {
  const current = readStore();
  return writeStore({ ...current, settings: { ...current.settings, linearApiKey } });
}

function getSettings() {
  return readStore().settings;
}

/** Merge a partial settings patch (used for LLM / LangSmith keys). */
function patchSettings(patch) {
  const current = readStore();
  return writeStore({ ...current, settings: { ...current.settings, ...patch } });
}

/** Find a business by its linked Linear project id (for repo resolution). */
function getBusinessByProjectId(projectId) {
  if (!projectId) return null;
  return readStore().businesses.find((b) => b.projectId === projectId) || null;
}

/** Server-side GitHub token (never returned raw to the browser). */
function getGithubToken() {
  return readStore().settings.githubToken || '';
}

function setGithubToken(githubToken) {
  return patchSettings({ githubToken: String(githubToken || '') });
}

/** Selected repository connector, including the matching private token. */
function getRepositoryConfig() {
  const settings = readStore().settings;
  const provider = settings.repositoryProvider === 'gitlab' ? 'gitlab' : 'github';
  return {
    provider,
    url: String(settings.repositoryUrl || ''),
    token: provider === 'gitlab' ? String(settings.gitlabToken || '') : String(settings.githubToken || ''),
  };
}

function getRepositoryToken(provider) {
  if (provider === undefined) return getRepositoryConfig().token;
  const settings = readStore().settings;
  if (provider === 'github') return String(settings.githubToken || '');
  if (provider === 'gitlab') return String(settings.gitlabToken || '');
  return '';
}

/** Selected planning connector. Credentials are intentionally returned only server-side. */
function getPlanningConfig() {
  const settings = readStore().settings;
  const provider = ['linear', 'jira', 'asana'].includes(settings.planningProvider)
    ? settings.planningProvider
    : 'linear';
  if (provider === 'jira') {
    return {
      provider,
      baseUrl: String(settings.jiraBaseUrl || ''),
      email: String(settings.jiraEmail || ''),
      token: String(settings.jiraApiToken || ''),
    };
  }
  if (provider === 'asana') {
    return {
      provider,
      workspaceId: String(settings.asanaWorkspaceId || ''),
      token: String(settings.asanaAccessToken || ''),
    };
  }
  return { provider, token: String(settings.linearApiKey || '') };
}

/* --------------------------- Codex OAuth tokens ------------------------- */

/** Server-side Codex OAuth token set (never returned raw to the browser). */
function getCodexTokens() {
  return readStore().settings.codexTokens || null;
}

function setCodexTokens(tokens) {
  return patchSettings({ codexTokens: tokens || null });
}

function clearCodexTokens() {
  return patchSettings({ codexTokens: null });
}

/* --------------------------- Claude OAuth tokens ------------------------ */

/** Server-side Claude OAuth token set (never returned raw to the browser). */
function getClaudeTokens() {
  return readStore().settings.claudeTokens || null;
}

function setClaudeTokens(tokens) {
  return patchSettings({ claudeTokens: tokens || null });
}

function clearClaudeTokens() {
  return patchSettings({ claudeTokens: null });
}

/* --------------------------- Assumed role ------------------------------- */

function getAssumedRole() {
  return readStore().assumedRole;
}

function setAssumedRole(role) {
  const current = readStore();
  return writeStore({ ...current, assumedRole: role || null });
}

/* --------------------------- Agent config ------------------------------- */

function getAgentConfig() {
  return readStore().agentConfig;
}

function setAgentConfig(patch) {
  const current = readStore();
  return writeStore({ ...current, agentConfig: { ...current.agentConfig, ...patch } });
}

/* --------------------------- Jobs --------------------------------------- */

/**
 * All jobs, or — when `kind` is given — only jobs of that kind. Legacy jobs
 * without a `kind` are treated as 'enrichment' (the original job type).
 */
function listJobs(kind) {
  const jobs = readStore().jobs;
  if (!kind) return jobs;
  return jobs.filter((j) => (j.kind || 'enrichment') === kind);
}

function addJob(job) {
  const current = readStore();
  return writeStore({ ...current, jobs: [job, ...current.jobs] });
}

/** Immutably update a job by id, returning the updated job (or null). */
function updateJob(id, patch) {
  const current = readStore();
  let updated = null;
  const jobs = current.jobs.map((job) => {
    if (job.id !== id) return job;
    updated = { ...job, ...patch, updatedAt: new Date().toISOString() };
    return updated;
  });
  writeStore({ ...current, jobs });
  return updated;
}

const MAX_STEPS_PER_JOB = 100;

/** Append a trace step ({ ts, level, message }) to a job, capped in length. */
function appendJobStep(id, step) {
  const current = readStore();
  const jobs = current.jobs.map((job) => {
    if (job.id !== id) return job;
    const steps = [...(job.steps || []), step].slice(-MAX_STEPS_PER_JOB);
    return { ...job, steps, updatedAt: new Date().toISOString() };
  });
  writeStore({ ...current, jobs });
}

/** On boot, mark any jobs left 'running' (from a crash/restart) as interrupted. */
function reconcileRunningJobs() {
  const current = readStore();
  let count = 0;
  const jobs = current.jobs.map((job) => {
    if (job.status !== 'running') return job;
    count += 1;
    const step = { ts: new Date().toISOString(), level: 'error', message: 'Interrupted by server restart.' };
    return {
      ...job,
      status: 'error',
      error: 'Interrupted by server restart.',
      finishedAt: new Date().toISOString(),
      steps: [...(job.steps || []), step],
    };
  });
  if (count) writeStore({ ...current, jobs });
  return count;
}

function removeJob(id) {
  const current = readStore();
  const jobs = current.jobs.filter((j) => j.id !== id);
  const removed = jobs.length !== current.jobs.length;
  if (removed) writeStore({ ...current, jobs });
  return removed;
}

/** Remove finished jobs (done + error). Returns remaining jobs. */
function clearFinishedJobs() {
  const current = readStore();
  const jobs = current.jobs.filter((j) => j.status === 'pending' || j.status === 'running');
  writeStore({ ...current, jobs });
  return jobs;
}

function pruneJobs(keep = 100) {
  const current = readStore();
  if (current.jobs.length <= keep) return current.jobs;
  const jobs = current.jobs.slice(0, keep);
  writeStore({ ...current, jobs });
  return jobs;
}

/* --------------------------- Memories ----------------------------------- */

const MAX_MEMORIES = 1000;

/** All memories, newest first — optionally filtered by scope and/or refId. */
function listMemories(filter = {}) {
  const { scope, refId } = filter || {};
  let memories = readStore().memories;
  if (scope) memories = memories.filter((m) => m.scope === scope);
  if (refId) memories = memories.filter((m) => m.refId === refId);
  return memories;
}

/**
 * Prepend a memory (newest first) with a generated id + timestamps, capping the
 * total count (oldest dropped). The caller supplies already-validated fields
 * (see agent/memory.js normalizeMemory); id/createdAt/updatedAt are authoritative.
 */
function addMemory(memory) {
  const current = readStore();
  const now = new Date().toISOString();
  const record = { ...memory, id: `mem_${randomUUID()}`, createdAt: now, updatedAt: now };
  const memories = [record, ...current.memories].slice(0, MAX_MEMORIES);
  writeStore({ ...current, memories });
  return record;
}

function removeMemory(id) {
  const current = readStore();
  const memories = current.memories.filter((m) => m.id !== id);
  const removed = memories.length !== current.memories.length;
  if (removed) writeStore({ ...current, memories });
  return removed;
}

/** Keep only the newest `keep` memories. Returns the remaining list. */
function pruneMemories(keep = MAX_MEMORIES) {
  const current = readStore();
  if (current.memories.length <= keep) return current.memories;
  const memories = current.memories.slice(0, keep);
  writeStore({ ...current, memories });
  return memories;
}

/* --------------------------- Conversations ------------------------------ */

const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_PER_CONVERSATION = 200;

/** All conversation threads, newest-first by updatedAt. */
function listConversations() {
  return [...readStore().conversations].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function getConversation(id) {
  return readStore().conversations.find((conversation) => conversation.id === id) || null;
}

/** Create a thread with a generated id + timestamps; cap total count (oldest dropped). */
function addConversation(conversation = {}) {
  const current = readStore();
  const now = new Date().toISOString();
  const record = {
    id: `conv_${randomUUID()}`,
    title: conversation.title || 'New conversation',
    createdAt: now,
    updatedAt: now,
    messages: Array.isArray(conversation.messages) ? conversation.messages.slice(0, MAX_MESSAGES_PER_CONVERSATION) : [],
  };
  const conversations = [record, ...current.conversations].slice(0, MAX_CONVERSATIONS);
  writeStore({ ...current, conversations });
  return record;
}

/**
 * Append already-validated messages (each stamped with a generated id + ts) to a
 * thread, capped to the newest MAX_MESSAGES_PER_CONVERSATION. Returns the updated
 * record or null when the id is unknown.
 */
function appendConversationMessages(id, messages) {
  const current = readStore();
  const now = new Date().toISOString();
  const stamped = (Array.isArray(messages) ? messages : []).map((message) => ({ ...message, id: `msg_${randomUUID()}`, ts: now }));
  let updated = null;
  const conversations = current.conversations.map((conversation) => {
    if (conversation.id !== id) return conversation;
    const nextMessages = [...(conversation.messages || []), ...stamped].slice(-MAX_MESSAGES_PER_CONVERSATION);
    updated = { ...conversation, messages: nextMessages, updatedAt: now };
    return updated;
  });
  if (updated) writeStore({ ...current, conversations });
  return updated;
}

/** Immutably patch a thread (e.g. rename); the id is never overwritten. */
function updateConversation(id, patch) {
  const current = readStore();
  let updated = null;
  const conversations = current.conversations.map((conversation) => {
    if (conversation.id !== id) return conversation;
    updated = { ...conversation, ...patch, id: conversation.id, updatedAt: new Date().toISOString() };
    return updated;
  });
  if (updated) writeStore({ ...current, conversations });
  return updated;
}

function removeConversation(id) {
  const current = readStore();
  const conversations = current.conversations.filter((conversation) => conversation.id !== id);
  const removed = conversations.length !== current.conversations.length;
  if (removed) writeStore({ ...current, conversations });
  return removed;
}

/** Keep only the newest `keep` threads. Returns the remaining list. */
function pruneConversations(keep = MAX_CONVERSATIONS) {
  const current = readStore();
  if (current.conversations.length <= keep) return current.conversations;
  const conversations = current.conversations.slice(0, keep);
  writeStore({ ...current, conversations });
  return conversations;
}

module.exports = {
  DEFAULT_STORE,
  DEFAULT_AGENT_CONFIG,
  migrateBusinessRepositories,
  settingsForConfiguredModel,
  applyLegacyHostedReasoningDefaults,
  readStore,
  writeStore,
  getApiKey,
  setApiKey,
  getSettings,
  patchSettings,
  getGithubToken,
  setGithubToken,
  getRepositoryConfig,
  getRepositoryToken,
  getPlanningConfig,
  getBusinessByProjectId,
  getCodexTokens,
  setCodexTokens,
  clearCodexTokens,
  getClaudeTokens,
  setClaudeTokens,
  clearClaudeTokens,
  getAssumedRole,
  setAssumedRole,
  getAgentConfig,
  setAgentConfig,
  listJobs,
  addJob,
  updateJob,
  appendJobStep,
  reconcileRunningJobs,
  removeJob,
  clearFinishedJobs,
  pruneJobs,
  MAX_MEMORIES,
  listMemories,
  addMemory,
  removeMemory,
  pruneMemories,
  MAX_CONVERSATIONS,
  MAX_MESSAGES_PER_CONVERSATION,
  listConversations,
  getConversation,
  addConversation,
  appendConversationMessages,
  updateConversation,
  removeConversation,
  pruneConversations,
};
