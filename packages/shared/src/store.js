'use strict';

const fs = require('fs');
const { CONFIG } = require('./config');
const {
  getPreset,
  presetForModel,
  settingsPatchForPreset,
  publicCatalog,
  modelMatchesPreset,
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
  };
}

const DEFAULT_OLLAMA_SETTINGS = settingsPatchForPreset(recommendedPreset('ollama'));
const DEFAULT_LMSTUDIO_SETTINGS = settingsPatchForPreset(recommendedPreset('lmstudio'));
const DEFAULT_CODEX_SETTINGS = settingsForConfiguredModel(recommendedPreset('codex'));
const DEFAULT_CLAUDE_SETTINGS = settingsForConfiguredModel(recommendedPreset('claude'));
// The exact catalog defaults win over a same-provider recommended preset. This
// keeps changing `defaults.local/hosted` in JSON sufficient to change new installs.
const DEFAULT_ACTIVE_LOCAL_SETTINGS = settingsPatchForPreset(DEFAULT_LOCAL_PRESET);
const DEFAULT_ACTIVE_HOSTED_SETTINGS = settingsForConfiguredModel(DEFAULT_HOSTED_PRESET);
const DEFAULT_HOSTED_MODEL = configuredModel(DEFAULT_HOSTED_PRESET.provider);

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
    // Deep-agent LLM providers. Two role slots, each choosing one of the four
    // providers ('ollama' / 'lmstudio' (local) or 'codex' / 'claude' (OAuth)):
    //   llmProvider      — GLOBAL (hosted) slot: used by the planner and by the
    //                      coder for hosted-labeled (and unlabeled) issues.
    //   localLlmProvider — LOCAL slot: used by the coder for "local"-labeled (XS)
    //                      issues only.
    // New installs start with one useful local preset and one hosted preset. An
    // existing store is migrated to "custom" below so its hand-tuned values are
    // never silently replaced by a catalog recommendation.
    llmProvider: DEFAULT_HOSTED_PRESET.provider,
    localLlmProvider: DEFAULT_LOCAL_PRESET.provider,
    hostedLlmPresetId: modelMatchesPreset(DEFAULT_HOSTED_PRESET, DEFAULT_HOSTED_MODEL) ? DEFAULT_HOSTED_PRESET.id : 'custom',
    localLlmPresetId: DEFAULT_LOCAL_PRESET.id,
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
  },
  businesses: [
    {
      id: 'ota',
      name: 'OTA',
      description: 'Online Travel Agency — initial business.',
      projectId: null,
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  assumedRole: null, // { id, name, email } — the member currently assumed
  agentConfig: DEFAULT_AGENT_CONFIG,
  jobs: [], // enrichment jobs (see routes/agent.js)
});

function ensureDataDir() {
  if (!fs.existsSync(CONFIG.DATA_DIR)) {
    fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  }
}

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_STORE));
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
      businesses: Array.isArray(parsed.businesses) ? parsed.businesses : base.businesses,
      assumedRole: parsed.assumedRole || null,
      agentConfig: migrateAgentConfig({ ...base.agentConfig, ...(parsed.agentConfig || {}) }),
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
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

module.exports = {
  DEFAULT_STORE,
  DEFAULT_AGENT_CONFIG,
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
};
