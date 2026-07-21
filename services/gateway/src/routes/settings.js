'use strict';

const express = require('express');
const { getApiKey, setApiKey, getSettings, patchSettings } = require('@ai-fleet/shared/store');
const { getViewer } = require('@ai-fleet/shared/linear');
const { asyncHandler, maskKey } = require('@ai-fleet/shared/util');
const { CONFIG } = require('@ai-fleet/shared/config');
const { repoParts } = require('@ai-fleet/shared/agent/workspace');
const {
  publicCatalog,
  presetForRole,
  settingsPatchForPreset,
  settingsPatchForReasoning,
  customPresetForSettings,
  modelMatchesPreset,
  presetForModel,
  sanitizeModelId,
  runtimePresetForProfile,
  neutralLocalPreset,
  isPurposeRole,
} = require('@ai-fleet/shared/agent/model-presets');
const {
  normalizeAgentRuntime,
  normalizeWorkflowPattern,
} = require('@ai-fleet/shared/agent/runtimes');

const router = express.Router();

// Settings keys backing each LLM role. Deployment slots ('local'/'global') stay
// deployment-pinned; purpose roles (thinking/execution/testing) are provider-
// flexible and reuse whichever provider block they name.
const ROLE_KEYS = Object.freeze({
  global: { provider: 'llmProvider', preset: 'hostedLlmPresetId' },
  local: { provider: 'localLlmProvider', preset: 'localLlmPresetId' },
  thinking: { provider: 'thinkingLlmProvider', preset: 'thinkingLlmPresetId' },
  execution: { provider: 'executionLlmProvider', preset: 'executionLlmPresetId' },
  testing: { provider: 'testingLlmProvider', preset: 'testingLlmPresetId' },
});
const LOCAL_PROVIDERS = Object.freeze(['ollama', 'lmstudio', 'omlx']);
const HOSTED_PROVIDERS = Object.freeze(['codex', 'claude']);

/** Canonicalize a request's role, or null when unrecognized. */
function parseRole(value) {
  if (value === 'local') return 'local';
  if (value === 'global' || value === 'hosted') return 'global';
  if (isPurposeRole(value)) return value;
  return null;
}

/** Providers a role may select — purpose roles accept both local and hosted. */
function providersForRole(role) {
  if (role === 'local') return LOCAL_PROVIDERS;
  if (role === 'global') return HOSTED_PROVIDERS;
  return [...LOCAL_PROVIDERS, ...HOSTED_PROVIDERS];
}

/** Public settings view — secrets are masked, never returned raw. */
function publicSettings() {
  const s = getSettings();
  const planningProvider = ['linear', 'jira', 'asana'].includes(s.planningProvider) ? s.planningProvider : 'linear';
  const repositoryProvider = s.repositoryProvider === 'gitlab' ? 'gitlab' : 'github';
  return {
    hasKey: Boolean(s.linearApiKey),
    maskedKey: maskKey(s.linearApiKey),
    planningProvider,
    planningConfigured:
      planningProvider === 'linear'
        ? Boolean(s.linearApiKey)
        : planningProvider === 'jira'
          ? Boolean(s.jiraBaseUrl && s.jiraEmail && s.jiraApiToken)
          : Boolean(s.asanaWorkspaceId && s.asanaAccessToken),
    jiraBaseUrl: s.jiraBaseUrl || '',
    jiraEmail: s.jiraEmail || '',
    hasJiraToken: Boolean(s.jiraApiToken),
    maskedJiraToken: maskKey(s.jiraApiToken),
    asanaWorkspaceId: s.asanaWorkspaceId || '',
    hasAsanaToken: Boolean(s.asanaAccessToken),
    maskedAsanaToken: maskKey(s.asanaAccessToken),
    repositoryProvider,
    repositoryUrl: s.repositoryUrl || '',
    repositoryConfigured: Boolean(s.repositoryUrl && (repositoryProvider === 'gitlab' ? s.gitlabToken : s.githubToken)),
    // Deep-agent provider slots. `llmProvider` = GLOBAL (hosted) slot (planner +
    // coder's hosted/unlabeled route); `localLlmProvider` = LOCAL slot (coder's
    // "local"/XS route). Local providers are Ollama, LM Studio, or oMLX;
    // hosted providers are OpenAI/Codex or Anthropic/Claude.
    llmProvider: s.llmProvider || 'ollama',
    localLlmProvider: s.localLlmProvider || 'lmstudio',
    hostedLlmPresetId: s.hostedLlmPresetId || 'custom',
    localLlmPresetId: s.localLlmPresetId || 'custom',
    // Purpose-based model roles ("models as tasks"). Each names a provider and
    // reuses that provider's block below. thinking → planner, execution →
    // coder, testing → reserved (tool calling; not wired to a consumer yet).
    thinkingLlmProvider: s.thinkingLlmProvider || s.llmProvider || 'ollama',
    thinkingLlmPresetId: s.thinkingLlmPresetId || 'custom',
    executionLlmProvider: s.executionLlmProvider || s.llmProvider || 'ollama',
    executionLlmPresetId: s.executionLlmPresetId || 'custom',
    testingLlmProvider: s.testingLlmProvider || s.llmProvider || 'ollama',
    testingLlmPresetId: s.testingLlmPresetId || 'custom',
    ollamaHost: s.ollamaHost,
    ollamaModel: s.ollamaModel,
    ollamaContextWindow: s.ollamaContextWindow,
    ollamaNumTokens: s.ollamaNumTokens,
    ollamaTemperature: s.ollamaTemperature ?? null,
    ollamaTopP: s.ollamaTopP ?? null,
    ollamaTopK: s.ollamaTopK ?? null,
    ollamaRepeatPenalty: s.ollamaRepeatPenalty ?? null,
    ollamaReasoningEffort: s.ollamaReasoningEffort || 'none',
    ollamaReasoningAdapter: s.ollamaReasoningAdapter || 'none',
    ollamaJsonMode: s.ollamaJsonMode || 'json',
    // LM Studio (local, OpenAI-compatible) — an alternative local provider.
    lmstudioHost: s.lmstudioHost,
    lmstudioModel: s.lmstudioModel,
    lmstudioContextWindow: s.lmstudioContextWindow,
    lmstudioNumTokens: s.lmstudioNumTokens,
    lmstudioTemperature: s.lmstudioTemperature ?? null,
    lmstudioTopP: s.lmstudioTopP ?? null,
    lmstudioTopK: s.lmstudioTopK ?? null,
    lmstudioRepeatPenalty: s.lmstudioRepeatPenalty ?? null,
    lmstudioReasoningEffort: s.lmstudioReasoningEffort || 'none',
    lmstudioReasoningAdapter: s.lmstudioReasoningAdapter || 'none',
    lmstudioJsonMode: s.lmstudioJsonMode || 'text',
    lmstudioContextMode: s.lmstudioContextMode || 'summarize',
    // oMLX (local, OpenAI-compatible). The optional API key is never returned.
    omlxHost: s.omlxHost,
    omlxModel: s.omlxModel,
    omlxContextWindow: s.omlxContextWindow,
    omlxNumTokens: s.omlxNumTokens,
    omlxTemperature: s.omlxTemperature ?? null,
    omlxTopP: s.omlxTopP ?? null,
    omlxTopK: s.omlxTopK ?? null,
    omlxRepeatPenalty: s.omlxRepeatPenalty ?? null,
    omlxReasoningEffort: s.omlxReasoningEffort || 'none',
    omlxReasoningAdapter: s.omlxReasoningAdapter || 'none',
    omlxJsonMode: s.omlxJsonMode || 'text',
    omlxContextMode: s.omlxContextMode || 'summarize',
    hasOmlxApiKey: Boolean(s.omlxApiKey),
    maskedOmlxApiKey: maskKey(s.omlxApiKey),
    // Hosted model values are not secrets; OAuth tokens remain masked in their
    // dedicated status endpoints.
    codexModel: s.codexModel,
    codexContextWindow: s.codexContextWindow,
    codexMaxTokens: s.codexMaxTokens,
    codexTemperature: s.codexTemperature ?? null,
    codexReasoningEffort: s.codexReasoningEffort || 'none',
    codexReasoningAdapter: s.codexReasoningAdapter || 'none',
    claudeModel: s.claudeModel,
    claudeContextWindow: s.claudeContextWindow,
    claudeMaxTokens: s.claudeMaxTokens,
    claudeTemperature: s.claudeTemperature ?? null,
    claudeReasoningEffort: s.claudeReasoningEffort || 'none',
    claudeReasoningAdapter: s.claudeReasoningAdapter || 'none',
    hasGithubToken: Boolean(s.githubToken),
    maskedGithubToken: maskKey(s.githubToken),
    hasGitlabToken: Boolean(s.gitlabToken),
    maskedGitlabToken: maskKey(s.gitlabToken),
    hasLangsmithKey: Boolean(s.langsmithApiKey),
    maskedLangsmithKey: maskKey(s.langsmithApiKey),
    langsmithProject: s.langsmithProject,
    langsmithEndpoint: s.langsmithEndpoint,
    langsmithTracing: Boolean(s.langsmithTracing),
    agentRuntime: normalizeAgentRuntime(s.agentRuntime),
    workflowPattern: normalizeWorkflowPattern(s.workflowPattern),
  };
}

/**
 * Validate an operator-supplied local inference host. This
 * is a local single-user tool, so localhost is the intended target (unlike a
 * public SSRF sink). We only enforce a well-formed http/https URL; the host is
 * stored server-side and is never taken from a request parameter at call time.
 */
function normalizeHost(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
  } catch (_) {
    return fallback;
  }
}

/** Accept either the oMLX server origin or its documented `/v1` client URL. */
function normalizeOmlxHost(value, fallback) {
  const normalized = normalizeHost(value, fallback);
  return String(normalized || '').replace(/\/v1\/?$/i, '');
}

/** Optional connector URL. Empty is meaningful (not configured). */
function normalizeOptionalUrl(value, fallback = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
  } catch (_) {
    return fallback;
  }
}

/** Tokenless repository reference: owner/name or a GitHub/GitLab HTTPS/SSH URL. */
function sanitizeRepositoryUrl(value, fallback = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.git)?$/.test(raw)) return raw;
  if (/^https:\/\/(?:github\.com|gitlab\.com)\/[A-Za-z0-9_.\/-]+(?:\.git)?$/.test(raw)) return raw;
  if (/^git@(?:github\.com|gitlab\.com):[A-Za-z0-9_.\/-]+(?:\.git)?$/.test(raw)) return raw;
  return fallback;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Keep `value` only if it is one of `allowed`, else fall back. */
function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function discoveryProfileFrom(result, model) {
  const models = Array.isArray(result) ? result : result && Array.isArray(result.models) ? result.models : [];
  return models.find((profile) => profile && profile.id === model) || null;
}

/** Resolve only models that are either in the reviewed catalog or live discovery. */
async function selectionPreset(provider, model) {
  const preset = presetForModel(provider, model);
  // The JSON catalog describes the default ChatGPT/Codex subscription backend.
  // Metered OpenAI has different context/default-effort metadata and never accepts
  // the Codex-only `ultra` level, so resolve even known models through its
  // backend-specific discovery fallback below.
  if (preset && !(provider === 'codex' && CONFIG.OAUTH.backend === 'api')) return preset;
  if (provider === 'ollama' || provider === 'lmstudio' || provider === 'omlx') {
    return neutralLocalPreset(provider, model);
  }

  // Lazy import keeps the static catalog usable if discovery is temporarily
  // unavailable during startup or an installation upgrade.
  let discovery;
  try {
    discovery = require('@ai-fleet/shared/agent/model-discovery');
  } catch (_) {
    return null;
  }
  let profile = typeof discovery.getCachedModel === 'function'
    ? await discovery.getCachedModel(provider, model)
    : null;
  if (!profile && typeof discovery.discoverModels === 'function') {
    const result = await discovery.discoverModels(provider);
    profile = discoveryProfileFrom(result, model);
    if (!profile && typeof discovery.getCachedModel === 'function') {
      profile = await discovery.getCachedModel(provider, model);
    }
  }
  return runtimePresetForProfile(provider, profile) || preset;
}

// GET /api/settings
router.get('/', (req, res) => {
  res.json(publicSettings());
});

// GET /api/settings/llm-presets — the single server-owned catalog used by the UI.
router.get('/llm-presets', (req, res) => {
  res.json(publicCatalog());
});

// PUT /api/settings/llm-preset — atomically select a role preset and optionally
// apply safe custom overrides. A local role may only select local presets and the
// global/planner role may only select hosted presets.
router.put('/llm-preset', (req, res) => {
  const b = req.body || {};
  const role = parseRole(b.role);
  if (!role) return res.status(400).json({ error: 'Unknown LLM role.' });
  const keys = ROLE_KEYS[role];
  const current = getSettings();
  const currentProvider = current[keys.provider];
  const requestedProvider = String(b.provider || currentProvider || '').trim();
  const isCustom = b.presetId === 'custom';
  const preset = isCustom
    ? customPresetForSettings(requestedProvider, current)
    : presetForRole(b.presetId, role);
  // Deployment slots enforce the local/hosted split; purpose roles accept any
  // deployment (presetForRole already relaxes this). A migrated custom slot may
  // keep its existing provider until the operator selects a real preset.
  const deploymentOk = isPurposeRole(role) || !preset
    || preset.deployment === (role === 'local' ? 'local' : 'hosted');
  if (!preset || (!isCustom && !deploymentOk) || (isCustom && requestedProvider !== currentProvider)) {
    return res.status(400).json({ error: `Unknown or incompatible LLM preset for the ${role} role.` });
  }

  const overrides = b.overrides && typeof b.overrides === 'object' && !Array.isArray(b.overrides) ? b.overrides : {};
  if (!isCustom && Object.prototype.hasOwnProperty.call(overrides, 'model') && !modelMatchesPreset(preset, overrides.model)) {
    return res.status(400).json({
      error: `Model id is incompatible with the ${preset.label} preset. Select the matching model preset first.`,
    });
  }
  const patch = settingsPatchForPreset(preset, overrides);
  if (preset.provider === 'ollama' && overrides.host !== undefined) {
    patch.ollamaHost = normalizeHost(overrides.host, current.ollamaHost);
  }
  if (preset.provider === 'lmstudio' && overrides.host !== undefined) {
    patch.lmstudioHost = normalizeHost(overrides.host, current.lmstudioHost);
  }
  if (preset.provider === 'omlx') {
    if (overrides.host !== undefined) {
      patch.omlxHost = normalizeOmlxHost(overrides.host, current.omlxHost || CONFIG.OMLX.defaultHost);
    }
    if (overrides.clearApiKey === true) patch.omlxApiKey = '';
    else if (overrides.apiKey !== undefined && String(overrides.apiKey).trim()) {
      patch.omlxApiKey = String(overrides.apiKey).trim().slice(0, 4096);
    }
  }
  patch[keys.provider] = preset.provider;
  patch[keys.preset] = preset.id;
  patchSettings(patch);
  res.json(publicSettings());
});

// PUT /api/settings/llm-selection — model-driven settings for the two LLM
// slots. `mode:model` resets the selected model to its reviewed defaults;
// `mode:reasoning` changes only model/provider/adapter/effort so any advanced
// numeric customization remains untouched.
router.put('/llm-selection', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const role = parseRole(b.role);
  if (!role) return res.status(400).json({ error: 'Unknown LLM role.' });
  const mode = b.mode === 'model' || b.mode === 'reasoning' ? b.mode : null;
  if (!mode) return res.status(400).json({ error: 'Mode must be "model" or "reasoning".' });

  const provider = String(b.provider || '').trim();
  const allowedProviders = providersForRole(role);
  if (!allowedProviders.includes(provider)) {
    return res.status(400).json({
      error: `Provider for the ${role} role must be one of: ${allowedProviders.join(', ')}.`,
    });
  }
  const model = sanitizeModelId(b.model);
  if (!model) return res.status(400).json({ error: 'A valid model id is required.' });

  let preset;
  try {
    preset = await selectionPreset(provider, model);
  } catch (_) {
    return res.status(502).json({ error: `Could not refresh the ${provider} model list. Try again.` });
  }
  if (!preset) {
    return res.status(400).json({ error: `Model "${model}" is not available for ${provider}. Refresh the model list and try again.` });
  }

  let patch;
  if (mode === 'model') {
    patch = settingsPatchForPreset(preset, { model });
  } else {
    const reasoningEffort = String(b.reasoningEffort || '').trim();
    patch = settingsPatchForReasoning(preset, reasoningEffort, model);
    if (!patch) {
      return res.status(400).json({
        error: `Reasoning must be one of: ${preset.capabilities.reasoningEfforts.join(', ')}.`,
      });
    }
  }

  const presetId = preset.id === 'custom' || preset.id.startsWith('dynamic-') ? 'custom' : preset.id;
  const keys = ROLE_KEYS[role];
  patch[keys.provider] = provider;
  if (mode === 'model') patch[keys.preset] = presetId;
  patchSettings(patch);
  res.json(publicSettings());
}));

// PUT /api/settings — validate the Linear key against Linear, then persist.
router.put(
  '/',
  asyncHandler(async (req, res) => {
    const linearApiKey = (req.body && req.body.linearApiKey ? String(req.body.linearApiKey) : '').trim();
    if (!linearApiKey) {
      return res.status(400).json({ error: 'A Linear API key is required.' });
    }
    const { viewer, organization } = await getViewer(linearApiKey);
    setApiKey(linearApiKey);
    res.json({ ...publicSettings(), viewer, organization });
  })
);

// PUT /api/settings/llm — save the local Ollama configuration for the deep agent.
// Provider selection is separate (PUT /api/settings/provider), so saving Ollama
// settings does not silently switch an operator off the Codex provider.
router.put('/llm', (req, res) => {
  const b = req.body || {};
  const current = getSettings();
  const hasModelOverride = b.ollamaModel !== undefined;
  const model = hasModelOverride ? String(b.ollamaModel).trim() : current.ollamaModel;
  const matchedPreset = presetForModel('ollama', model);
  const currentPreset = presetForModel('ollama', current.ollamaModel);
  const modelFamilyChanged = hasModelOverride && (matchedPreset
    ? !currentPreset || currentPreset.id !== matchedPreset.id
    : model !== current.ollamaModel);
  const preservedAdapter = ['ollama-think-effort', 'ollama-think-toggle'].includes(current.ollamaReasoningAdapter)
    ? current.ollamaReasoningAdapter
    : 'none';
  const reasoningAdapter = matchedPreset
    ? matchedPreset.capabilities.reasoningAdapter
    : hasModelOverride && model !== current.ollamaModel ? 'none' : preservedAdapter;
  const reasoningEfforts = matchedPreset
    ? matchedPreset.capabilities.reasoningEfforts
    : reasoningAdapter === 'ollama-think-effort'
      ? ['low', 'medium', 'high']
      : reasoningAdapter === 'ollama-think-toggle' ? ['none', 'medium'] : ['none'];
  const defaultEffort = !modelFamilyChanged && reasoningEfforts.includes(current.ollamaReasoningEffort)
    ? current.ollamaReasoningEffort
    : matchedPreset ? matchedPreset.parameters.reasoning.effort : reasoningEfforts[0];
  const samplingDefaults = matchedPreset && modelFamilyChanged ? matchedPreset.parameters : null;
  const contextWindow = clampInt(b.ollamaContextWindow, 512, 262144, current.ollamaContextWindow);
  const maxOutputTokens = Math.min(128000, contextWindow);
  const patch = {
    ollamaHost: normalizeHost(b.ollamaHost, current.ollamaHost),
    ollamaContextWindow: contextWindow,
    ollamaNumTokens: clampInt(
      b.ollamaNumTokens,
      128,
      maxOutputTokens,
      Math.min(Number(current.ollamaNumTokens) || 8192, maxOutputTokens)
    ),
    ollamaTemperature: clampNumber(
      b.ollamaTemperature,
      0,
      2,
      samplingDefaults ? samplingDefaults.temperature : current.ollamaTemperature ?? 0
    ),
    ollamaTopP: clampNumber(
      b.ollamaTopP,
      0,
      1,
      samplingDefaults ? samplingDefaults.topP : current.ollamaTopP ?? null
    ),
    ollamaTopK: b.ollamaTopK === null ? null : clampInt(
      b.ollamaTopK,
      1,
      1000,
      samplingDefaults ? samplingDefaults.topK : current.ollamaTopK ?? null
    ),
    ollamaRepeatPenalty: clampNumber(
      b.ollamaRepeatPenalty,
      0,
      2,
      samplingDefaults ? samplingDefaults.repeatPenalty : current.ollamaRepeatPenalty ?? null
    ),
    ollamaReasoningEffort: oneOf(b.ollamaReasoningEffort, reasoningEfforts, defaultEffort),
    ollamaReasoningAdapter: reasoningAdapter,
    ollamaJsonMode: oneOf(b.ollamaJsonMode, CONFIG.OLLAMA_JSON_MODES, current.ollamaJsonMode || 'json'),
  };
  if (hasModelOverride) patch.ollamaModel = model;
  if (current.localLlmProvider === 'ollama') patch.localLlmPresetId = 'custom';
  if (current.llmProvider === 'ollama') patch.hostedLlmPresetId = 'custom';
  patchSettings(patch);
  res.json(publicSettings());
});

// PUT /api/settings/lmstudio — save the local LM Studio configuration for the deep
// agent. Like Ollama, this is a local provider; provider selection stays separate
// (PUT /api/settings/provider), so saving LM Studio settings does not switch the
// active provider.
router.put('/lmstudio', (req, res) => {
  const b = req.body || {};
  const current = getSettings();
  const hasModelOverride = b.lmstudioModel !== undefined;
  const model = hasModelOverride ? String(b.lmstudioModel).trim() : current.lmstudioModel;
  const matchedPreset = presetForModel('lmstudio', model);
  const currentPreset = presetForModel('lmstudio', current.lmstudioModel);
  const modelFamilyChanged = hasModelOverride && (matchedPreset
    ? !currentPreset || currentPreset.id !== matchedPreset.id
    : model !== current.lmstudioModel);
  const requestedAdapter = oneOf(
    b.lmstudioReasoningAdapter,
    ['none', 'openai-compatible'],
    current.lmstudioReasoningAdapter || 'none'
  );
  const reasoningAdapter = matchedPreset
    ? matchedPreset.capabilities.reasoningAdapter
    : hasModelOverride && model !== current.lmstudioModel ? 'none' : requestedAdapter;
  const reasoningEfforts = matchedPreset
    ? matchedPreset.capabilities.reasoningEfforts
    : reasoningAdapter === 'openai-compatible' ? ['none', 'low', 'medium', 'high'] : ['none'];
  const defaultEffort = !modelFamilyChanged && reasoningEfforts.includes(current.lmstudioReasoningEffort)
    ? current.lmstudioReasoningEffort
    : matchedPreset ? matchedPreset.parameters.reasoning.effort : reasoningEfforts[0];
  const samplingDefaults = matchedPreset && modelFamilyChanged ? matchedPreset.parameters : null;
  const contextWindow = clampInt(b.lmstudioContextWindow, 512, 262144, current.lmstudioContextWindow);
  const maxOutputTokens = Math.min(128000, Math.max(256, Math.floor(contextWindow / 2)));
  const patch = {
    lmstudioHost: normalizeHost(b.lmstudioHost, current.lmstudioHost),
    lmstudioContextWindow: contextWindow,
    lmstudioNumTokens: clampInt(
      b.lmstudioNumTokens,
      256,
      maxOutputTokens,
      Math.min(Number(current.lmstudioNumTokens) || 4096, maxOutputTokens)
    ),
    lmstudioTemperature: clampNumber(
      b.lmstudioTemperature,
      0,
      2,
      samplingDefaults ? samplingDefaults.temperature : current.lmstudioTemperature ?? 0
    ),
    lmstudioTopP: clampNumber(
      b.lmstudioTopP,
      0,
      1,
      samplingDefaults ? samplingDefaults.topP : current.lmstudioTopP ?? null
    ),
    lmstudioTopK: b.lmstudioTopK === null ? null : clampInt(
      b.lmstudioTopK,
      1,
      1000,
      samplingDefaults ? samplingDefaults.topK : current.lmstudioTopK ?? null
    ),
    lmstudioRepeatPenalty: clampNumber(
      b.lmstudioRepeatPenalty,
      0,
      2,
      samplingDefaults ? samplingDefaults.repeatPenalty : current.lmstudioRepeatPenalty ?? null
    ),
    lmstudioReasoningEffort: oneOf(
      b.lmstudioReasoningEffort,
      reasoningEfforts,
      defaultEffort
    ),
    lmstudioReasoningAdapter: reasoningAdapter,
    lmstudioJsonMode: oneOf(b.lmstudioJsonMode, CONFIG.LMSTUDIO_JSON_MODES, current.lmstudioJsonMode || 'text'),
    lmstudioContextMode: oneOf(b.lmstudioContextMode, CONFIG.LMSTUDIO_CONTEXT_MODES, current.lmstudioContextMode || 'summarize'),
  };
  if (hasModelOverride) patch.lmstudioModel = model;
  if (current.localLlmProvider === 'lmstudio') patch.localLlmPresetId = 'custom';
  if (current.llmProvider === 'lmstudio') patch.hostedLlmPresetId = 'custom';
  patchSettings(patch);
  res.json(publicSettings());
});

// PUT /api/settings/provider — choose a deep-agent LLM provider for a role.
// Body: { llmProvider|provider: <name>, role?: 'global'|'local'|'thinking'|
// 'execution'|'testing' }. Defaults to the global (hosted) slot. Purpose roles
// accept any provider; deployment slots stay pinned to their deployment.
router.put('/provider', (req, res) => {
  const b = req.body || {};
  const role = parseRole(b.role) || 'global';
  const requested = String(b.llmProvider || b.provider || '').trim();
  const allowed = providersForRole(role);
  if (!allowed.includes(requested)) {
    return res.status(400).json({ error: `Provider for the ${role} role must be one of: ${allowed.join(', ')}.` });
  }
  const keys = ROLE_KEYS[role];
  patchSettings({ [keys.provider]: requested, [keys.preset]: 'custom' });
  res.json(publicSettings());
});

// PUT /api/settings/github — save the GitHub token for the code-writer's git ops.
// Stored server-side only; never returned raw or logged. Empty string clears it.
router.put('/github', (req, res) => {
  const b = req.body || {};
  if (b.githubToken !== undefined) {
    patchSettings({ githubToken: String(b.githubToken).trim() });
  }
  res.json(publicSettings());
});

// PUT /api/settings/integrations — configure the work-management and source
// repository connectors in one atomic, server-owned settings update. Blank
// credential fields are ignored so editing a URL never erases a saved secret;
// explicit `clear*Token` flags are used for removal.
router.put('/integrations', (req, res) => {
  const b = req.body || {};
  const current = getSettings();
  const patch = {};

  if (b.planningProvider !== undefined) {
    const planningProvider = String(b.planningProvider).toLowerCase();
    if (!['linear', 'jira', 'asana'].includes(planningProvider)) {
      return res.status(400).json({ error: 'Planning provider must be Linear, Jira, or Asana.' });
    }
    patch.planningProvider = planningProvider;
  }
  if (b.repositoryProvider !== undefined) {
    const repositoryProvider = String(b.repositoryProvider).toLowerCase();
    if (!['github', 'gitlab'].includes(repositoryProvider)) {
      return res.status(400).json({ error: 'Repository provider must be GitHub or GitLab.' });
    }
    patch.repositoryProvider = repositoryProvider;
  }
  if (b.repositoryUrl !== undefined) {
    const repositoryUrl = sanitizeRepositoryUrl(b.repositoryUrl, '');
    if (String(b.repositoryUrl || '').trim() && !repositoryUrl) {
      return res.status(400).json({ error: 'Repository must be owner/name or a github.com/gitlab.com Git URL.' });
    }
    patch.repositoryUrl = repositoryUrl;
  }

  // Validate the effective pair, including provider-only API updates. This keeps
  // a saved GitHub URL from becoming an invalid GitLab configuration (or vice
  // versa) when a non-UI client changes only the provider field.
  const effectiveRepositoryProvider = patch.repositoryProvider || current.repositoryProvider || 'github';
  const effectiveRepositoryUrl = patch.repositoryUrl !== undefined ? patch.repositoryUrl : current.repositoryUrl;
  if (effectiveRepositoryUrl && !repoParts(effectiveRepositoryUrl, effectiveRepositoryProvider)) {
    return res.status(400).json({
      error: `Repository URL must match the selected ${effectiveRepositoryProvider === 'gitlab' ? 'GitLab' : 'GitHub'} host.`,
    });
  }

  if (b.jiraBaseUrl !== undefined) {
    const jiraBaseUrl = normalizeOptionalUrl(b.jiraBaseUrl, '');
    if (String(b.jiraBaseUrl || '').trim() && !jiraBaseUrl) {
      return res.status(400).json({ error: 'Jira site must be a valid http(s) URL.' });
    }
    patch.jiraBaseUrl = jiraBaseUrl;
  }
  if (b.jiraEmail !== undefined) patch.jiraEmail = String(b.jiraEmail || '').trim().slice(0, 320);
  if (b.asanaWorkspaceId !== undefined) patch.asanaWorkspaceId = String(b.asanaWorkspaceId || '').trim().slice(0, 160);

  for (const [bodyKey, settingKey, clearKey] of [
    ['githubToken', 'githubToken', 'clearGithubToken'],
    ['gitlabToken', 'gitlabToken', 'clearGitlabToken'],
    ['jiraApiToken', 'jiraApiToken', 'clearJiraToken'],
    ['asanaAccessToken', 'asanaAccessToken', 'clearAsanaToken'],
  ]) {
    if (b[clearKey] === true) patch[settingKey] = '';
    else if (b[bodyKey] !== undefined && String(b[bodyKey]).trim()) patch[settingKey] = String(b[bodyKey]).trim();
  }

  patchSettings(patch);
  res.json(publicSettings());
});

// PUT /api/settings/runtime — select the provider-neutral SDK runtime and the
// bounded workflow pattern used by new planner/coder runs. Descriptive aliases
// such as "parallel-fan-out" are accepted but persisted as canonical ids.
router.put('/runtime', (req, res) => {
  const b = req.body || {};
  const patch = {};
  try {
    if (b.agentRuntime !== undefined) {
      patch.agentRuntime = normalizeAgentRuntime(b.agentRuntime, { strict: true });
    }
    if (b.workflowPattern !== undefined) {
      patch.workflowPattern = normalizeWorkflowPattern(b.workflowPattern, { strict: true });
    }
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'agentRuntime or workflowPattern is required.' });
  }
  patchSettings(patch);
  res.json(publicSettings());
});

// PUT /api/settings/langsmith — save LangSmith tracing configuration.
router.put('/langsmith', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.langsmithApiKey !== undefined) patch.langsmithApiKey = String(b.langsmithApiKey).trim();
  if (b.langsmithProject !== undefined && String(b.langsmithProject).trim()) {
    patch.langsmithProject = String(b.langsmithProject).trim();
  }
  if (b.langsmithEndpoint !== undefined && String(b.langsmithEndpoint).trim()) {
    patch.langsmithEndpoint = String(b.langsmithEndpoint).trim();
  }
  if (b.langsmithTracing !== undefined) patch.langsmithTracing = Boolean(b.langsmithTracing);
  patchSettings(patch);
  res.json(publicSettings());
});

// GET /api/settings/validate — test the currently stored Linear key.
router.get(
  '/validate',
  asyncHandler(async (req, res) => {
    const key = getApiKey();
    if (!key) return res.status(400).json({ error: 'No API key configured.' });
    const { viewer, organization } = await getViewer(key);
    res.json({ ok: true, viewer, organization });
  })
);

// DELETE /api/settings — clear the Linear key.
router.delete('/', (req, res) => {
  setApiKey('');
  res.json(publicSettings());
});

module.exports = router;
