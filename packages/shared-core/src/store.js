'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { CONFIG, namespaceCollection } = require('./config');
const fileBackend = require('./store/file-backend');
const firestoreBackend = require('./store/firestore-backend');
const workspaceContext = require('./store/workspace-context');
const {
  currentWorkspaceContext,
  workspaceOrganizationKey,
  assertCompatibleWithPinnedOrganization,
} = workspaceContext;
const {
  getPreset,
  presetForModel,
  settingsPatchForPreset,
  publicCatalog,
  modelMatchesPreset,
  MODEL_ROLES,
} = require('./agent/model-presets');

const PRESET_CATALOG = publicCatalog();
const DEFAULT_BYOM_PRESET = getPreset(PRESET_CATALOG.defaults.byom);
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
const DEFAULT_HUGGINGFACE_SETTINGS = settingsPatchForPreset(recommendedPreset('huggingface'));
const DEFAULT_ANTIGRAVITY_SETTINGS = settingsPatchForPreset(recommendedPreset('antigravity'));
const DEFAULT_CODEX_SETTINGS = settingsForConfiguredModel(recommendedPreset('codex'));
const DEFAULT_CLAUDE_SETTINGS = settingsForConfiguredModel(recommendedPreset('claude'));
// The exact catalog defaults win over a same-provider recommended preset. This
// keeps changing `defaults.byom/hosted` in JSON sufficient to change new installs.
const DEFAULT_ACTIVE_BYOM_SETTINGS = settingsPatchForPreset(DEFAULT_BYOM_PRESET);
const DEFAULT_ACTIVE_HOSTED_SETTINGS = settingsForConfiguredModel(DEFAULT_HOSTED_PRESET);
const DEFAULT_HOSTED_MODEL = configuredModel(DEFAULT_HOSTED_PRESET.provider);
// The preset id a fresh hosted slot resolves to (or 'custom' when the configured
// model diverges from the catalog default). Purpose roles seed from this too.
const DEFAULT_HOSTED_PRESET_ID = modelMatchesPreset(DEFAULT_HOSTED_PRESET, DEFAULT_HOSTED_MODEL)
  ? DEFAULT_HOSTED_PRESET.id
  : 'custom';

// Legacy "Local Models" settings key → its "BYoM" (Bring Your Own Model)
// replacement. Applied at load time (see normalizeStore) so a store written
// before the rename keeps working after upgrade.
const BYOM_KEY_MIGRATIONS = Object.freeze([
  ['localLlmProvider', 'byomProvider'],
  ['localLlmPresetId', 'byomPresetId'],
  ['localActiveModel', 'byomActiveModel'],
]);

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
  // Hold an amber/red requirement-evaluation gate this long (minutes) awaiting a
  // human before auto-approving and proceeding. See agent/approval-gate.js.
  evaluationApprovalWaitMinutes: 120,
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
    // Deep-agent LLM providers. Two role slots choose a BYoM provider
    // ('ollama' / 'lmstudio' / 'omlx' / 'huggingface') or a hosted provider
    // ('codex' / 'claude'):
    //   llmProvider  — GLOBAL (hosted) slot: used by the planner and by the
    //                  coder for hosted-labeled (and unlabeled) issues.
    //   byomProvider — BYoM slot ("Bring Your Own Model"; formerly the "local"
    //                  slot): used by the coder for "byom"-labeled (XS) issues
    //                  only. Renamed from localLlmProvider — see normalizeStore
    //                  for the load-time migration of the legacy key.
    // New installs start with one useful BYoM preset and one hosted preset. An
    // existing store is migrated to "custom" below so its hand-tuned values are
    // never silently replaced by a catalog recommendation.
    llmProvider: DEFAULT_HOSTED_PRESET.provider,
    byomProvider: DEFAULT_BYOM_PRESET.provider,
    hostedLlmPresetId: DEFAULT_HOSTED_PRESET_ID,
    byomPresetId: DEFAULT_BYOM_PRESET.id,
    // Purpose-based model roles ("models as tasks"). Each names one of the four
    // providers and reuses that provider's shared config block below. New
    // installs point every role at the hosted slot; an operator can independently
    // repoint any role (including at a local provider). Consumers:
    //   thinking → planner, execution → coder, testing → tester,
    //   deployment → deployer.
    thinkingLlmProvider: DEFAULT_HOSTED_PRESET.provider,
    thinkingLlmPresetId: DEFAULT_HOSTED_PRESET_ID,
    executionLlmProvider: DEFAULT_HOSTED_PRESET.provider,
    executionLlmPresetId: DEFAULT_HOSTED_PRESET_ID,
    testingLlmProvider: DEFAULT_HOSTED_PRESET.provider,
    testingLlmPresetId: DEFAULT_HOSTED_PRESET_ID,
    deploymentLlmProvider: DEFAULT_HOSTED_PRESET.provider,
    deploymentLlmPresetId: DEFAULT_HOSTED_PRESET_ID,
    // Complexity tier last applied via the settings slider (see
    // model-presets.js complexityTiers + settingsPatchForTier). 'custom' means
    // the roles above were set individually and match no tier. Metadata only —
    // resolveLlm reads the per-role keys, not this field.
    complexityTier: 'custom',
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
    // Hugging Face (hosted, OpenAI-compatible router). The access token is
    // REQUIRED; it lives server-side only and is exposed solely via masked
    // status fields. Endpoint host comes from CONFIG.HUGGINGFACE (trusted).
    huggingfaceHost: CONFIG.HUGGINGFACE.defaultHost,
    huggingfaceApiKey: '',
    ...DEFAULT_HUGGINGFACE_SETTINGS,
    // Antigravity (Google) — backed by the Gemini API via @google/genai. The
    // Gemini API key is REQUIRED; it lives server-side only and is exposed solely
    // via masked status fields (read from GEMINI_API_KEY in the cloud). The called
    // target (model / preview agent id) comes from CONFIG.ANTIGRAVITY (trusted).
    antigravityApiKey: '',
    antigravityAgentId: '',
    ...DEFAULT_ANTIGRAVITY_SETTINGS,
    // Codex (OpenAI) provider — endpoints/client come from CONFIG.OAUTH (trusted),
    // the browser only chooses the model. Tokens live server-side only.
    ...DEFAULT_CODEX_SETTINGS,
    // How Codex keeps the deep-agent prompt within its context window on long
    // runs (only acts when the prompt overflows codexContextWindow): 'trim' drops
    // old turns, 'summarize' condenses them via one extra Codex call, 'none'
    // sends as-is. 'trim' by default — the same strategy LM Studio uses, but
    // without an extra hosted request. Not part of the preset patch, so it is
    // preserved across model/preset changes.
    codexContextMode: 'trim',
    codexTokens: null, // OAuth token set { accessToken, refreshToken, ... } — never sent to the browser
    // Claude (Anthropic) provider — "Sign in with Claude" OAuth. Endpoints/client
    // come from CONFIG.CLAUDE (trusted); the browser only chooses the model.
    // Output token budget. The business-plan JSON is large (milestones + issues +
    // per-item criteria), so the selected preset supplies enough headroom while
    // the model still stops naturally at end_turn.
    ...DEFAULT_CLAUDE_SETTINGS,
    ...DEFAULT_ACTIVE_BYOM_SETTINGS,
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
    // How many times to retry an LLM stream on a transient/in-stream error
    // (a stream `error` event, a 5xx/429, or a dropped connection) — these
    // surface after a 200 so the provider SDK's own retries never cover them.
    // Applies to every provider. 0 disables retrying. Existing installs inherit
    // this default through the store merge.
    llmStreamRetries: CONFIG.LLM_STREAM_RETRIES,
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
  approvals: [], // requirement-evaluation approval gates (see agent/approval-gate.js)
  stackLinks: [], // open stacked-PR links awaiting blocker merge (see agent/stack-reconcile.js)
  settingsHistory: [], // append-only model/tier selection + indicative cost records for tuning

  // Billing / cost metering (see packages/shared/src/billing/*). All amounts are
  // integer paise. usageRecords are granular per-run events (pruned after a
  // retention window); ledgerEntries are the append-only money source of truth;
  // billingAccounts hold per-org config + a derived balance snapshot (id = orgId).
  usageRecords: [],
  ledgerEntries: [],
  billingAccounts: [],
  billing: { lastAggregatedAt: null }, // sweep watermark (see billing/sweep.js)

  // End User License Agreement acceptance, keyed at two scopes. `users[key]` and
  // `orgs[orgId]` each hold { status:'accepted'|'rejected', version, via, at }.
  // Org membership itself implies acceptance (see services/gateway eula gate), so
  // `orgs` is the explicit organisation-level record when one is written.
  eula: { users: {}, orgs: {} },
});

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

/**
 * Merge + migrate a raw parsed store into a full, current-schema store. This is
 * PURE (no I/O), so the file and Firestore backends share the exact same
 * normalization. Previously this logic lived inline in the file-only readStore.
 */
function normalizeStore(parsed) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const base = cloneDefault();
  const storedSettings = source.settings || {};
  const settings = { ...base.settings, ...storedSettings };
  // Rename migration: the "Local Models" slot became "BYoM" (Bring Your Own
  // Model). Copy any legacy localLlm*/localActiveModel value into its byom*
  // replacement when the new key is absent, then drop the stale key so a
  // migrated store carries only the current schema. Existing data keeps working.
  for (const [legacyKey, byomKey] of BYOM_KEY_MIGRATIONS) {
    if (Object.prototype.hasOwnProperty.call(storedSettings, legacyKey)
      && !Object.prototype.hasOwnProperty.call(storedSettings, byomKey)) {
      settings[byomKey] = storedSettings[legacyKey];
    }
    delete settings[legacyKey];
  }
  // Preset ids did not exist before catalog v1. Treat legacy settings as
  // customized instead of claiming they match (and possibly later reapplying)
  // a new default preset. A pre-rename store carries localLlmPresetId (already
  // migrated to byomPresetId above), so only a store missing BOTH keys is legacy.
  if (!Object.prototype.hasOwnProperty.call(storedSettings, 'byomPresetId')
    && !Object.prototype.hasOwnProperty.call(storedSettings, 'localLlmPresetId')) {
    settings.byomPresetId = 'custom';
  }
  if (!Object.prototype.hasOwnProperty.call(storedSettings, 'hostedLlmPresetId')) {
    settings.hostedLlmPresetId = 'custom';
  }
  // Purpose-based model roles did not exist before this migration. Seed each
  // absent role from the operator's effective hosted slot so an existing
  // install keeps its current planner/coder model (previously always the
  // hosted slot) instead of jumping to a catalog default. The `byom`/`global`
  // slots are preserved untouched for localization and diagnostics.
  for (const role of MODEL_ROLES) {
    const providerKey = `${role}LlmProvider`;
    const presetKey = `${role}LlmPresetId`;
    if (!Object.prototype.hasOwnProperty.call(storedSettings, providerKey)) {
      settings[providerKey] = settings.llmProvider;
      settings[presetKey] = settings.hostedLlmPresetId;
    }
  }
  // The complexity tier is a slider convenience that did not exist before. A
  // legacy store's roles were configured individually, so it is 'custom' until
  // the operator moves the slider (base merge already defaults this; the guard
  // documents intent, consistent with the preset-id migration above).
  if (!Object.prototype.hasOwnProperty.call(storedSettings, 'complexityTier')) {
    settings.complexityTier = 'custom';
  }
  // Preserve explicitly configured legacy request shapes. When both hosted
  // reasoning fields are absent, however, activate the reviewed default for
  // the effective known model. This keeps the visible model-aware default and
  // the actual runtime request in sync without overwriting an explicit Off.
  for (const prefix of ['ollama', 'lmstudio', 'codex', 'claude', 'huggingface', 'antigravity']) {
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
    ...source,
    settings,
    businesses: migrateBusinessRepositories(Array.isArray(source.businesses) ? source.businesses : base.businesses),
    assumedRole: source.assumedRole || null,
    agentConfig: migrateAgentConfig({ ...base.agentConfig, ...(source.agentConfig || {}) }),
    jobs: Array.isArray(source.jobs) ? source.jobs : [],
    memories: Array.isArray(source.memories) ? source.memories : [],
    conversations: Array.isArray(source.conversations) ? source.conversations : [],
    approvals: Array.isArray(source.approvals) ? source.approvals : [],
    stackLinks: Array.isArray(source.stackLinks) ? source.stackLinks : [],
    settingsHistory: Array.isArray(source.settingsHistory) ? source.settingsHistory : [],
    usageRecords: Array.isArray(source.usageRecords) ? source.usageRecords : [],
    ledgerEntries: Array.isArray(source.ledgerEntries) ? source.ledgerEntries : [],
    billingAccounts: Array.isArray(source.billingAccounts) ? source.billingAccounts : [],
    billing: normalizeBilling(source.billing),
    eula: normalizeEula(source.eula),
  };
}

/** Coerce a raw `billing` blob into the current { lastAggregatedAt } shape. */
function normalizeBilling(source) {
  const billing = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return { lastAggregatedAt: typeof billing.lastAggregatedAt === 'string' ? billing.lastAggregatedAt : null };
}

/** Coerce a raw `eula` blob into the current { users:{}, orgs:{} } shape. */
function normalizeEula(source) {
  const eula = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const asMap = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {});
  return { users: asMap(eula.users), orgs: asMap(eula.orgs) };
}

function seedStore() {
  return cloneDefault();
}

// Top-level keys kept together in one Firestore document (small, singleton) vs.
// the growing arrays that each become a per-record sub-collection so no single
// document approaches Firestore's 1 MB limit.
const STORE_MAIN_KEYS = ['settings', 'businesses', 'assumedRole', 'agentConfig', 'eula', 'billing'];
const STORE_COLLECTION_KEYS = [
  'jobs', 'memories', 'conversations', 'approvals', 'stackLinks', 'settingsHistory',
  // Billing: append-heavy records — each becomes one Firestore sub-collection doc
  // keyed by `id`, so no single document approaches the 1 MB limit and concurrent
  // appends never clobber one another (the ledger is the money source of truth).
  'usageRecords', 'ledgerEntries', 'billingAccounts',
];

const LEGACY_BACKEND_KEY = 'legacy';

/**
 * Build one physical backend. The legacy entry retains the exact historical
 * file/Firestore location. Shared deployments create additional hashed org
 * entries; raw organization ids never enter a path or Firestore collection.
 */
function createBackendEntry(key) {
  const legacy = key === LEGACY_BACKEND_KEY;
  const backend = CONFIG.STORE_BACKEND === 'firestore'
    ? firestoreBackend.create({
        rootCollection: legacy ? namespaceCollection('aifleet') : `aifleet_workspace_${key}`,
        mainKeys: STORE_MAIN_KEYS,
        collectionKeys: STORE_COLLECTION_KEYS,
        normalize: normalizeStore,
        seed: seedStore,
      })
    : fileBackend.create({
        file: legacy
          ? CONFIG.STORE_FILE
          : path.join(CONFIG.DATA_DIR, 'workspaces', `${key}.json`),
        dataDir: legacy ? CONFIG.DATA_DIR : path.join(CONFIG.DATA_DIR, 'workspaces'),
        normalize: normalizeStore,
        seed: seedStore,
      });
  return {
    key,
    backend,
    initialized: CONFIG.STORE_BACKEND !== 'firestore',
    initPromise: null,
  };
}

// Registry entries own independent Firestore mirrors. AsyncLocalStorage picks
// an entry per request/job, so concurrent org A/B work cannot switch a mutable
// global backend out from underneath another async chain.
const backendRegistry = new Map();
const legacyBackendEntry = createBackendEntry(LEGACY_BACKEND_KEY);
backendRegistry.set(LEGACY_BACKEND_KEY, legacyBackendEntry);

function activeBackendKey() {
  const context = assertCompatibleWithPinnedOrganization(currentWorkspaceContext());
  // STORE_NAMESPACE is the physical marker for a dedicated deployment. A
  // FLEET_ORG_ID can also be attached to an ephemeral job in the shared stack;
  // it still validates the selected org above, but must not redirect that job
  // to the shared legacy backend. Only an existing namespace retains the old
  // physical location byte-for-byte.
  if (CONFIG.STORE_NAMESPACE || !context.organizationId) {
    return LEGACY_BACKEND_KEY;
  }
  return workspaceOrganizationKey(context);
}

function backendEntryForKey(key) {
  let entry = backendRegistry.get(key);
  if (!entry) {
    entry = createBackendEntry(key);
    backendRegistry.set(key, entry);
  }
  return entry;
}

function activeBackendEntry() {
  return backendEntryForKey(activeBackendKey());
}

function assertInitialized(entry) {
  if (CONFIG.STORE_BACKEND === 'firestore' && !entry.initialized) {
    const error = new Error('Store backend is not initialized for this workspace; await initStore() inside its context.');
    error.code = 'workspace_store_not_initialized';
    throw error;
  }
}

async function initializeBackendEntry(entry) {
  if (entry.initialized) return;
  if (entry.initPromise) return entry.initPromise;
  entry.initPromise = Promise.resolve()
    .then(() => (typeof entry.backend.init === 'function' ? entry.backend.init() : undefined))
    .then(() => {
      entry.initialized = true;
    })
    .catch((error) => {
      // A transient initialization failure may be retried. All concurrent
      // callers share the same in-flight promise, preventing duplicate hydrate
      // and onSnapshot registration races.
      entry.initPromise = null;
      throw error;
    });
  return entry.initPromise;
}

/** Read the current store. Synchronous for both backends. */
function readStore() {
  const entry = activeBackendEntry();
  assertInitialized(entry);
  return entry.backend.read();
}

/** Persist a new store and return it. */
function writeStore(store) {
  const entry = activeBackendEntry();
  assertInitialized(entry);
  return entry.backend.write(store);
}

/** Global metadata APIs use this explicitly instead of the selected workspace. */
function readLegacyStore() {
  assertInitialized(legacyBackendEntry);
  return legacyBackendEntry.backend.read();
}

function writeLegacyStore(store) {
  assertInitialized(legacyBackendEntry);
  return legacyBackendEntry.backend.write(store);
}

/**
 * Hydrate the store backend before serving traffic. A no-op for the file
 * backend; the Firestore backend loads its in-memory mirror and starts live
 * listeners. Services should `await initStore()` on boot.
 */
async function initStore() {
  // Billing/EULA are intentionally global, so ensure their legacy backend is
  // hydrated even when this call occurs inside an organization context.
  await initializeBackendEntry(legacyBackendEntry);
  const entry = activeBackendEntry();
  if (entry !== legacyBackendEntry) await initializeBackendEntry(entry);
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
  if (!next.evaluationApprovalWaitMinutes) next.evaluationApprovalWaitMinutes = DEFAULT_AGENT_CONFIG.evaluationApprovalWaitMinutes;
  // Legacy Anthropic-era fields — LLM config now lives in settings.
  delete next.model;
  delete next.maxTokens;
  return next;
}

/* --------------------------- Settings / secrets ------------------------- */

/**
 * This is the MANAGED-key path: env-sourced secrets (Cloud Run injects Secret
 * Manager values as env vars) take precedence over anything persisted in the
 * store, exactly as the per-org vault treats a "managed" selection as the
 * platform key. It keeps long-lived credentials out of Firestore/the JSON file
 * in the cloud while local dev (no env) uses the Settings-UI (customer) values.
 * Rotating OAuth token SETS (codexTokens/claudeTokens) stay in the IAM-protected
 * store because they are rewritten on refresh.
 *
 * Consumers: the gateway (not proxied) and local dev read managed keys here. The
 * planner/coder agent runtimes DON'T — in egress-proxy mode they hold no key and
 * the proxy resolves managed vs customer through the settings service (the single
 * managed-key source; see services/settings secrets_service.MANAGED_ENV, which
 * this map mirrors). Keep the two maps aligned when adding a provider key.
 */
const SECRET_ENV = Object.freeze({
  linearApiKey: 'LINEAR_API_KEY',
  githubToken: 'GITHUB_TOKEN',
  gitlabToken: 'GITLAB_TOKEN',
  langsmithApiKey: 'LANGSMITH_API_KEY',
  // LangSmith LLM Gateway workspace key (managed-only, distinct from the tracing
  // key above) — the non-proxied gateway service + local dev read it here.
  langsmithGatewayApiKey: 'LANGSMITH_GATEWAY_API_KEY',
  jiraApiToken: 'JIRA_API_TOKEN',
  asanaAccessToken: 'ASANA_ACCESS_TOKEN',
  omlxApiKey: 'OMLX_API_KEY',
  huggingfaceApiKey: 'HUGGINGFACE_API_KEY',
  antigravityApiKey: 'GEMINI_API_KEY',
  // Managed LLM API keys (alternative to OAuth), matching the vault's managed set.
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  openaiApiKey: 'OPENAI_API_KEY',
});

function secretOverlay() {
  const patch = {};
  for (const [key, envName] of Object.entries(SECRET_ENV)) {
    const value = process.env[envName];
    if (value) patch[key] = value;
  }
  return patch;
}

function getApiKey() {
  return getSettings().linearApiKey || '';
}

function setApiKey(linearApiKey) {
  const current = readStore();
  return writeStore({ ...current, settings: { ...current.settings, linearApiKey } });
}

/** Effective settings: stored values with any environment secrets overlaid. */
function getSettings() {
  return { ...readStore().settings, ...secretOverlay() };
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
  return getSettings().githubToken || '';
}

function setGithubToken(githubToken) {
  return patchSettings({ githubToken: String(githubToken || '') });
}

/** Selected repository connector, including the matching private token. */
function getRepositoryConfig() {
  const settings = getSettings();
  const provider = settings.repositoryProvider === 'gitlab' ? 'gitlab' : 'github';
  return {
    provider,
    url: String(settings.repositoryUrl || ''),
    token: provider === 'gitlab' ? String(settings.gitlabToken || '') : String(settings.githubToken || ''),
  };
}

function getRepositoryToken(provider) {
  if (provider === undefined) return getRepositoryConfig().token;
  const settings = getSettings();
  if (provider === 'github') return String(settings.githubToken || '');
  if (provider === 'gitlab') return String(settings.gitlabToken || '');
  return '';
}

/** Selected planning connector. Credentials are intentionally returned only server-side. */
function getPlanningConfig() {
  const settings = getSettings();
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

/* --------------------------- EULA acceptance ---------------------------- */

/** The per-user EULA acceptance record for `key`, or null if none. */
function getEulaUser(key) {
  const eula = readLegacyStore().eula || { users: {}, orgs: {} };
  return eula.users[key] || null;
}

/** The organisation-level EULA acceptance record for `orgId`, or null if none. */
function getEulaOrg(orgId) {
  const eula = readLegacyStore().eula || { users: {}, orgs: {} };
  return eula.orgs[orgId] || null;
}

/**
 * Record a EULA decision at user scope. `record` is { status, version, via? };
 * the timestamp is authoritative. Returns the stored entry. Immutable write.
 */
function recordEulaDecision(key, record = {}) {
  const current = readLegacyStore();
  const eula = current.eula || { users: {}, orgs: {} };
  const entry = { status: record.status, version: record.version || null, via: record.via || 'user', at: new Date().toISOString() };
  writeLegacyStore({ ...current, eula: { ...eula, users: { ...eula.users, [key]: entry } } });
  return entry;
}

/** Record a EULA decision at organisation scope (the org-level flag). */
function recordEulaOrgDecision(orgId, record = {}) {
  const current = readLegacyStore();
  const eula = current.eula || { users: {}, orgs: {} };
  const entry = { status: record.status, version: record.version || null, via: record.via || 'org', at: new Date().toISOString() };
  writeLegacyStore({ ...current, eula: { ...eula, orgs: { ...eula.orgs, [orgId]: entry } } });
  return entry;
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

/* --------------------------- Stack links -------------------------------- */

/**
 * Open stacked-PR links: a dependent task's PR that was stacked onto an
 * unmerged blocker branch and is waiting for the blocker to merge so it can be
 * retargeted to the default base. Legacy stores without the field read as [].
 */
function listStackLinks() {
  return readStore().stackLinks || [];
}

/** Append a stack link (newest first) with a generated id + createdAt. */
function addStackLink(link) {
  const current = readStore();
  const record = { ...link, id: `stk_${randomUUID()}`, createdAt: new Date().toISOString(), resolvedAt: null };
  const stackLinks = [record, ...(current.stackLinks || [])];
  writeStore({ ...current, stackLinks });
  return record;
}

/** Immutably update a stack link by id, returning the updated link (or null). */
function updateStackLink(id, patch) {
  const current = readStore();
  let updated = null;
  const stackLinks = (current.stackLinks || []).map((link) => {
    if (link.id !== id) return link;
    updated = { ...link, ...patch };
    return updated;
  });
  writeStore({ ...current, stackLinks });
  return updated;
}

/** Remove a stack link by id. Returns true when one was removed. */
function removeStackLink(id) {
  const current = readStore();
  const stackLinks = (current.stackLinks || []).filter((link) => link.id !== id);
  const removed = stackLinks.length !== (current.stackLinks || []).length;
  if (removed) writeStore({ ...current, stackLinks });
  return removed;
}

/* --------------------------- Billing ------------------------------------ */

// All amounts are INTEGER paise. The ledger (ledgerEntries) is append-only and
// is the money source of truth; a per-org account (id = orgId) caches a derived
// balance snapshot for the frequent runner gate. usageRecords are granular
// per-run events feeding the cost page's per-project / per-user / per-task
// drill-down; they are pruned after a retention window (the ledger persists).
// See packages/shared/src/billing/* for the logic that uses these primitives.

const MAX_USAGE_RECORDS = 20000;

/** The sweep watermark ({ lastAggregatedAt }). */
function getBillingState() {
  return readLegacyStore().billing || { lastAggregatedAt: null };
}

/** Merge a partial patch into the billing watermark state. */
function setBillingState(patch) {
  const current = readLegacyStore();
  const billing = { ...(current.billing || { lastAggregatedAt: null }), ...patch };
  writeLegacyStore({ ...current, billing });
  return billing;
}

/** Append a granular usage record (newest first), capped to bound growth. */
function addUsageRecord(record) {
  const current = readLegacyStore();
  const now = new Date().toISOString();
  const entry = { ...record, id: `use_${randomUUID()}`, createdAt: record.createdAt || now };
  const usageRecords = [entry, ...current.usageRecords].slice(0, MAX_USAGE_RECORDS);
  writeLegacyStore({ ...current, usageRecords });
  return entry;
}

/** All usage records, newest first — optionally filtered by orgId. */
function listUsageRecords(filter = {}) {
  const { orgId } = filter || {};
  const records = readLegacyStore().usageRecords;
  return orgId ? records.filter((r) => r.orgId === orgId) : records;
}

/** Remove usage records created strictly before `beforeIso`. Returns count removed. */
function pruneUsageRecords(beforeIso) {
  if (!beforeIso) return 0;
  const current = readLegacyStore();
  const usageRecords = current.usageRecords.filter((r) => String(r.createdAt || '') >= beforeIso);
  const removed = current.usageRecords.length - usageRecords.length;
  if (removed) writeLegacyStore({ ...current, usageRecords });
  return removed;
}

/** Append a ledger entry (newest first) with a generated id + createdAt. */
function addLedgerEntry(entry) {
  const current = readLegacyStore();
  const now = new Date().toISOString();
  const record = { ...entry, id: `led_${randomUUID()}`, createdAt: entry.createdAt || now };
  writeLegacyStore({ ...current, ledgerEntries: [record, ...current.ledgerEntries] });
  return record;
}

/** All ledger entries, newest first — optionally filtered by orgId. */
function listLedgerEntries(filter = {}) {
  const { orgId } = filter || {};
  const entries = readLegacyStore().ledgerEntries;
  return orgId ? entries.filter((e) => e.orgId === orgId) : entries;
}

/** The billing account for an org (id = orgId), or null. */
function getBillingAccount(orgId) {
  if (!orgId) return null;
  return readLegacyStore().billingAccounts.find((a) => a.id === orgId) || null;
}

function listBillingAccounts() {
  return readLegacyStore().billingAccounts;
}

/**
 * Create or update a billing account keyed by orgId (its `id`). Immutable: a
 * partial `patch` merges over any existing record; `id`/`orgId` are always
 * authoritative and `updatedAt` is bumped. Returns the stored account.
 */
function upsertBillingAccount(orgId, patch = {}) {
  if (!orgId) throw new Error('upsertBillingAccount requires an orgId');
  const current = readLegacyStore();
  const now = new Date().toISOString();
  const existing = current.billingAccounts.find((a) => a.id === orgId) || null;
  const merged = existing
    ? { ...existing, ...patch, id: orgId, orgId, updatedAt: now }
    : { createdAt: now, updatedAt: now, ...patch, id: orgId, orgId };
  const billingAccounts = existing
    ? current.billingAccounts.map((a) => (a.id === orgId ? merged : a))
    : [merged, ...current.billingAccounts];
  writeLegacyStore({ ...current, billingAccounts });
  return merged;
}

/* ------------------------- Settings history ----------------------------- */

// Append-only trail of model/tier selections + indicative cost, kept for future
// reference and tuning. Capped so the sub-collection stays bounded. Records must
// never contain secrets — only provider/preset/model ids, the tier, and cost.
const MAX_SETTINGS_HISTORY = 500;

/** Selection history, newest first. Legacy stores without the field read as []. */
function listSettingsHistory() {
  return readStore().settingsHistory || [];
}

/** Append a settings-selection record (newest first) with a generated id + ts. */
function addSettingsHistory(record) {
  const current = readStore();
  const entry = { ...record, id: `sh_${randomUUID()}`, ts: new Date().toISOString() };
  const settingsHistory = [entry, ...(current.settingsHistory || [])].slice(0, MAX_SETTINGS_HISTORY);
  writeStore({ ...current, settingsHistory });
  return entry;
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
    ...(conversation.orgId ? { orgId: String(conversation.orgId) } : {}),
    ...(conversation.nativeProjectId ? { nativeProjectId: String(conversation.nativeProjectId) } : {}),
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

/* --------------------- Requirement approval gates ----------------------- */

const MAX_APPROVAL_GATES = 200;

/** Approval gates, newest-first by createdAt; optional {status, businessId} filter. */
function listApprovalGates(filter = {}) {
  const all = [...readStore().approvals].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return all.filter((gate) => {
    if (filter.status && gate.status !== filter.status) return false;
    if (filter.businessId && gate.businessId !== filter.businessId) return false;
    return true;
  });
}

function getApprovalGate(id) {
  return readStore().approvals.find((gate) => gate.id === id) || null;
}

/** Persist a new gate with a generated id + timestamps; cap total (oldest dropped). */
function addApprovalGate(gate = {}) {
  const current = readStore();
  const now = new Date().toISOString();
  const record = { ...gate, id: `gate_${randomUUID()}`, createdAt: now, updatedAt: now };
  const approvals = [record, ...current.approvals].slice(0, MAX_APPROVAL_GATES);
  writeStore({ ...current, approvals });
  return record;
}

/** Immutably patch a gate; the id/createdAt are never overwritten. */
function updateApprovalGate(id, patch) {
  const current = readStore();
  let updated = null;
  const approvals = current.approvals.map((gate) => {
    if (gate.id !== id) return gate;
    updated = { ...gate, ...patch, id: gate.id, createdAt: gate.createdAt, updatedAt: new Date().toISOString() };
    return updated;
  });
  if (updated) writeStore({ ...current, approvals });
  return updated;
}

function removeApprovalGate(id) {
  const current = readStore();
  const approvals = current.approvals.filter((gate) => gate.id !== id);
  const removed = approvals.length !== current.approvals.length;
  if (removed) writeStore({ ...current, approvals });
  return removed;
}

/** Keep only the newest `keep` gates. Returns the remaining list. */
function pruneApprovalGates(keep = MAX_APPROVAL_GATES) {
  const current = readStore();
  if (current.approvals.length <= keep) return current.approvals;
  const approvals = [...current.approvals]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, keep);
  writeStore({ ...current, approvals });
  return approvals;
}

module.exports = {
  DEFAULT_STORE,
  DEFAULT_AGENT_CONFIG,
  migrateBusinessRepositories,
  settingsForConfiguredModel,
  applyLegacyHostedReasoningDefaults,
  normalizeStore,
  readStore,
  writeStore,
  initStore,
  normalizeWorkspaceContext: workspaceContext.normalizeWorkspaceContext,
  runWithWorkspaceContext: workspaceContext.runWithWorkspaceContext,
  currentWorkspaceContext: workspaceContext.currentWorkspaceContext,
  workspaceOrganizationKey: workspaceContext.workspaceOrganizationKey,
  workspaceProjectKey: workspaceContext.workspaceProjectKey,
  workspaceCacheKey: workspaceContext.workspaceCacheKey,
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
  getEulaUser,
  getEulaOrg,
  recordEulaDecision,
  recordEulaOrgDecision,
  listJobs,
  addJob,
  updateJob,
  appendJobStep,
  reconcileRunningJobs,
  removeJob,
  clearFinishedJobs,
  pruneJobs,
  listStackLinks,
  addStackLink,
  updateStackLink,
  removeStackLink,
  getBillingState,
  setBillingState,
  addUsageRecord,
  listUsageRecords,
  pruneUsageRecords,
  addLedgerEntry,
  listLedgerEntries,
  getBillingAccount,
  listBillingAccounts,
  upsertBillingAccount,
  MAX_SETTINGS_HISTORY,
  listSettingsHistory,
  addSettingsHistory,
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
  MAX_APPROVAL_GATES,
  listApprovalGates,
  getApprovalGate,
  addApprovalGate,
  updateApprovalGate,
  removeApprovalGate,
  pruneApprovalGates,
};
