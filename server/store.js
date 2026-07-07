'use strict';

const fs = require('fs');
const { CONFIG } = require('./config');

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
    // Deep agent LLM provider: 'ollama' / 'lmstudio' (local) or 'codex' / 'claude' (OAuth).
    llmProvider: 'ollama',
    ollamaHost: 'http://localhost:11434',
    ollamaModel: '', // e.g. "llama3.1" — must support tool-calling; user selects
    ollamaContextWindow: 8192, // num_ctx
    ollamaNumTokens: 8192, // num_predict (output budget; the software-design plan JSON is large)
    ollamaJsonMode: 'json', // JSON constraint: 'json' (format:'json') | 'text' (prompt-driven)
    // LM Studio (local, OpenAI-compatible API) — an alternative local provider for
    // models not available in Ollama. No credentials; the browser chooses host + model.
    lmstudioHost: 'http://localhost:1234',
    lmstudioModel: '', // e.g. "qwen2.5-7b-instruct" — must support tool-calling; user selects
    // max_tokens (output budget). The plan JSON is large and REASONING models (e.g.
    // ornith) spend extra tokens thinking, so 4096 truncates it -> "length limit
    // reached". 16000 matches the Claude ceiling. Configurable in Settings → LLM;
    // context length itself is set when loading the model in LM Studio.
    lmstudioNumTokens: 16000,
    // JSON constraint: 'text' (prompt-driven; most compatible) | 'json_object' | 'json_schema'.
    // Some engines (e.g. the ornith runtime) reject 'json_object', so 'text' is the safe default.
    lmstudioJsonMode: 'text',
    // Codex (OpenAI) provider — endpoints/client come from CONFIG.OAUTH (trusted),
    // the browser only chooses the model. Tokens live server-side only.
    codexModel: '', // e.g. "gpt-5-codex"; falls back to CONFIG.OAUTH.defaultModel
    codexMaxTokens: 4096, // output token budget for the OpenAI call
    codexTokens: null, // OAuth token set { accessToken, refreshToken, ... } — never sent to the browser
    // Claude (Anthropic) provider — "Sign in with Claude" OAuth. Endpoints/client
    // come from CONFIG.CLAUDE (trusted); the browser only chooses the model.
    claudeModel: '', // e.g. "claude-opus-4-8"; falls back to CONFIG.CLAUDE.defaultModel
    // Output token budget. The business-plan JSON is large (milestones + issues +
    // per-item criteria); 4096 truncates it mid-array. 16000 is the non-streaming
    // safe ceiling (the model stops at end_turn when done, so headroom is free).
    claudeMaxTokens: 16000,
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
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
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
