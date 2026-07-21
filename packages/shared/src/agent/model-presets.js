'use strict';

const catalog = require('./llm-presets.json');

const PROVIDER_DEPLOYMENT = Object.freeze({
  ollama: 'local',
  lmstudio: 'local',
  omlx: 'local',
  codex: 'hosted',
  claude: 'hosted',
});
const ROLE_DEPLOYMENT = Object.freeze({ local: 'local', global: 'hosted' });

/**
 * Purpose-based model roles ("models as tasks"). Unlike the deployment-scoped
 * `local`/`global` slots (which pin a role to a single deployment), a purpose
 * role may select ANY provider — local or hosted:
 *   thinking  — task-planning models (used by the planner),
 *   execution — coder models (used by the code-writer),
 *   testing   — tool-calling models (reserved; not wired to a consumer yet).
 * Each purpose role names one of the four providers and reuses that provider's
 * shared settings block, so two roles pointing at the same provider share that
 * provider's model/params (last write wins).
 */
const MODEL_ROLES = Object.freeze(['thinking', 'execution', 'testing']);
const MODEL_ROLE_META = Object.freeze({
  thinking: { label: 'Thinking', description: 'Task planning models (used by the planner).' },
  execution: { label: 'Execution', description: 'Coder models (used by the code-writer).' },
  testing: { label: 'Testing', description: 'Tool-calling models (reserved; not used yet).' },
});
const isPurposeRole = (role) => MODEL_ROLES.includes(role);
const REASONING_ADAPTERS = new Set([
  'none',
  'ollama-think-toggle',
  'ollama-think-effort',
  'openai-compatible',
  'omlx-template-effort',
  'openai',
  'anthropic-adaptive',
  'anthropic-effort',
]);
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const JSON_MODES = Object.freeze({
  ollama: new Set(['json', 'text']),
  lmstudio: new Set(['text', 'json_object', 'json_schema']),
  omlx: new Set(['text', 'json_object', 'json_schema']),
});
const CONTEXT_MODES = new Set(['summarize', 'trim', 'none']);

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid LLM preset catalog: ${message}`);
}

function validateCatalog(value) {
  assert(value && Number.isInteger(value.version) && value.version > 0, 'version must be a positive integer');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value.updatedAt || ''), 'updatedAt must be YYYY-MM-DD');
  assert(value.defaults && typeof value.defaults === 'object', 'defaults are required');
  assert(value.reasoningEfforts && typeof value.reasoningEfforts === 'object', 'reasoning effort definitions are required');
  for (const effort of REASONING_EFFORTS) {
    const definition = value.reasoningEfforts[effort];
    assert(definition && typeof definition.label === 'string' && definition.label.trim(), `${effort}: reasoning label is required`);
    assert(typeof definition.description === 'string' && definition.description.trim(), `${effort}: reasoning description is required`);
  }
  assert(Array.isArray(value.presets) && value.presets.length > 0, 'presets must be a non-empty array');

  const ids = new Set();
  for (const preset of value.presets) {
    assert(preset && typeof preset === 'object', 'each preset must be an object');
    assert(/^[a-z0-9][a-z0-9-]{2,80}$/.test(preset.id || ''), `invalid id "${preset.id || ''}"`);
    assert(!ids.has(preset.id), `duplicate id "${preset.id}"`);
    ids.add(preset.id);
    assert(typeof preset.label === 'string' && preset.label.trim(), `${preset.id}: label is required`);
    assert(PROVIDER_DEPLOYMENT[preset.provider], `${preset.id}: unsupported provider`);
    assert(preset.deployment === PROVIDER_DEPLOYMENT[preset.provider], `${preset.id}: provider/deployment mismatch`);
    assert(typeof preset.model === 'string' && preset.model.trim(), `${preset.id}: model is required`);
    assert(/^https:\/\//.test(preset.sourceUrl || ''), `${preset.id}: sourceUrl must be HTTPS`);
    assert(Array.isArray(preset.modelPatterns), `${preset.id}: modelPatterns must be an array`);
    assert(preset.modelPatterns.every((pattern) => typeof pattern === 'string' && pattern.trim()), `${preset.id}: invalid model pattern`);
    assert(typeof preset.recommended === 'boolean', `${preset.id}: recommended must be boolean`);
    assert(typeof preset.description === 'string' && preset.description.trim(), `${preset.id}: description is required`);
    assert(typeof preset.requirements === 'string' && preset.requirements.trim(), `${preset.id}: requirements are required`);

    const limits = preset.limits || {};
    const requestLimits = preset.requestLimits || {};
    const params = preset.parameters || {};
    const caps = preset.capabilities || {};
    assert(Number.isInteger(limits.contextWindow) && limits.contextWindow >= 512, `${preset.id}: invalid context limit`);
    assert(Number.isInteger(limits.maxOutputTokens) && limits.maxOutputTokens >= 128, `${preset.id}: invalid output limit`);
    assert(limits.maxOutputTokens <= limits.contextWindow, `${preset.id}: output limit exceeds context limit`);
    const outputFraction = requestLimits.maxOutputContextFraction;
    assert(outputFraction === null || (Number.isFinite(outputFraction) && outputFraction > 0 && outputFraction <= 1), `${preset.id}: invalid output/context fraction`);
    assert(preset.deployment === 'local' ? outputFraction !== null : outputFraction === null, `${preset.id}: output/context fraction must match deployment`);
    assert(Number.isInteger(params.contextWindow) && params.contextWindow >= 512, `${preset.id}: invalid context default`);
    assert(params.contextWindow <= limits.contextWindow, `${preset.id}: context default exceeds limit`);
    assert(Number.isInteger(params.maxOutputTokens) && params.maxOutputTokens >= 128, `${preset.id}: invalid output default`);
    assert(params.maxOutputTokens <= limits.maxOutputTokens, `${preset.id}: output default exceeds limit`);
    assert(params.maxOutputTokens <= params.contextWindow, `${preset.id}: output default exceeds context default`);
    if (Number.isFinite(outputFraction)) {
      assert(params.maxOutputTokens <= Math.floor(params.contextWindow * outputFraction), `${preset.id}: output default exceeds effective context rule`);
    }
    assert(params.temperature === null || (Number.isFinite(params.temperature) && params.temperature >= 0 && params.temperature <= 2), `${preset.id}: invalid temperature`);
    assert(params.topP === null || (Number.isFinite(params.topP) && params.topP >= 0 && params.topP <= 1), `${preset.id}: invalid topP`);
    assert(params.topK === null || (Number.isInteger(params.topK) && params.topK >= 1 && params.topK <= 1000), `${preset.id}: invalid topK`);
    assert(params.repeatPenalty === null || (Number.isFinite(params.repeatPenalty) && params.repeatPenalty >= 0 && params.repeatPenalty <= 2), `${preset.id}: invalid repeatPenalty`);
    assert(caps.temperature || params.temperature === null, `${preset.id}: unsupported temperature must be null`);
    for (const capability of ['toolCalling', 'structuredOutput', 'temperature', 'contextWindowConfigurable']) {
      assert(typeof caps[capability] === 'boolean', `${preset.id}: ${capability} must be boolean`);
    }
    assert(REASONING_ADAPTERS.has(caps.reasoningAdapter), `${preset.id}: invalid reasoning adapter`);
    assert(Array.isArray(caps.reasoningEfforts) && caps.reasoningEfforts.length > 0, `${preset.id}: reasoning efforts required`);
    for (const effort of caps.reasoningEfforts) assert(REASONING_EFFORTS.has(effort), `${preset.id}: invalid reasoning effort`);
    const effort = params.reasoning && params.reasoning.effort;
    assert(caps.reasoningEfforts.includes(effort), `${preset.id}: default reasoning effort is unsupported`);
    if (caps.reasoningAdapter === 'none') {
      assert(caps.reasoningEfforts.length === 1 && effort === 'none', `${preset.id}: no-adapter reasoning must be disabled`);
      assert(params.reasoning.parameter === null, `${preset.id}: no-adapter reasoning parameter must be null`);
    } else {
      assert(typeof params.reasoning.parameter === 'string' && params.reasoning.parameter, `${preset.id}: reasoning parameter is required`);
    }
    if (preset.deployment === 'local') {
      assert(JSON_MODES[preset.provider].has(params.jsonMode), `${preset.id}: invalid JSON mode`);
    } else {
      assert(params.jsonMode === null, `${preset.id}: hosted JSON mode must be null`);
    }
    if (preset.provider === 'lmstudio' || preset.provider === 'omlx') {
      assert(CONTEXT_MODES.has(params.contextMode), `${preset.id}: invalid context mode`);
    } else {
      assert(params.contextMode === null, `${preset.id}: context mode only applies to OpenAI-compatible local providers`);
    }
  }

  for (const deployment of ['local', 'hosted']) {
    const preset = value.presets.find((item) => item.id === value.defaults[deployment]);
    assert(preset && preset.deployment === deployment, `default ${deployment} preset is missing or mismatched`);
  }
  for (const provider of Object.keys(PROVIDER_DEPLOYMENT)) {
    const providerPresets = value.presets.filter((preset) => preset.provider === provider);
    assert(providerPresets.length > 0, `provider ${provider} has no presets`);
    assert(providerPresets.filter((preset) => preset.recommended).length === 1, `provider ${provider} needs one recommended preset`);
  }
  return value;
}

validateCatalog(catalog);

const byId = new Map(catalog.presets.map((preset) => [preset.id, preset]));

function getPreset(id) {
  return byId.get(String(id || '')) || null;
}

function presetsForRole(role) {
  // Purpose roles are provider-flexible: any preset (local or hosted) is valid.
  if (isPurposeRole(role)) return catalog.presets;
  const deployment = ROLE_DEPLOYMENT[role];
  return deployment ? catalog.presets.filter((preset) => preset.deployment === deployment) : [];
}

function presetForRole(id, role) {
  const preset = getPreset(id);
  if (!preset) return null;
  if (isPurposeRole(role)) return preset;
  return preset.deployment === ROLE_DEPLOYMENT[role] ? preset : null;
}

function presetForModel(provider, model) {
  return catalog.presets.find((preset) => preset.provider === provider && modelMatchesPreset(preset, model)) || null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampTemperature(value, fallback) {
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(2, Math.max(0, n));
}

function cleanModel(value, fallback) {
  if (value === undefined) return fallback;
  const model = String(value || '').trim();
  if (!/^[\w.:\-/]{1,200}$/.test(model) || model.includes('//')) return fallback;
  return model;
}

function normalizedModel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** A named preset may only target its model family; adapters are model-specific. */
function modelMatchesPreset(preset, value) {
  const model = cleanModel(value, '');
  if (!model) return false;
  if (preset.id === 'custom') return true;
  const actual = normalizedModel(model);
  const patterns = [preset.model, ...(preset.modelPatterns || [])].map(normalizedModel).filter(Boolean);
  return preset.deployment === 'hosted'
    ? patterns.includes(actual)
    : patterns.some((pattern) => actual.includes(pattern));
}

function normalizeParameters(preset, overrides = {}) {
  const defaults = preset.parameters;
  const caps = preset.capabilities;
  const limits = preset.limits;
  const effort = caps.reasoningEfforts.includes(overrides.reasoningEffort)
    ? overrides.reasoningEffort
    : defaults.reasoning.effort;
  const temperature = caps.temperature
    ? clampTemperature(overrides.temperature, defaults.temperature)
    : null;
  const contextWindow = caps.contextWindowConfigurable
    ? clampInt(overrides.contextWindow, 512, limits.contextWindow, defaults.contextWindow)
    : defaults.contextWindow;
  const outputMinimum = preset.provider === 'lmstudio' || preset.provider === 'omlx' ? 256 : 128;
  let outputLimit = limits.maxOutputTokens;
  // The catalog carries the effective request rule separately from the model's
  // absolute output capability. LM Studio reserves half the loaded context;
  // Ollama only requires output not to exceed its request context.
  const outputFraction = preset.requestLimits && preset.requestLimits.maxOutputContextFraction;
  if (Number.isFinite(outputFraction)) {
    outputLimit = Math.min(outputLimit, Math.max(outputMinimum, Math.floor(contextWindow * outputFraction)));
  }
  const maxOutputTokens = clampInt(
    overrides.maxOutputTokens,
    outputMinimum,
    outputLimit,
    Math.min(defaults.maxOutputTokens, outputLimit)
  );
  const topP = defaults.topP === null ? null : clampNumber(overrides.topP, 0, 1, defaults.topP);
  const topK = defaults.topK === null ? null : clampInt(overrides.topK, 1, 1000, defaults.topK);
  const repeatPenalty = defaults.repeatPenalty === null
    ? null
    : clampNumber(overrides.repeatPenalty, 0, 2, defaults.repeatPenalty);
  const allowedJson = JSON_MODES[preset.provider];
  const jsonMode = allowedJson && allowedJson.has(overrides.jsonMode) ? overrides.jsonMode : defaults.jsonMode;
  const contextMode =
    (preset.provider === 'lmstudio' || preset.provider === 'omlx') && CONTEXT_MODES.has(overrides.contextMode)
      ? overrides.contextMode
      : defaults.contextMode;

  return {
    model: (() => {
      const requested = cleanModel(overrides.model, preset.model);
      return preset.id === 'custom' || modelMatchesPreset(preset, requested) ? requested : preset.model;
    })(),
    contextWindow,
    maxOutputTokens,
    temperature,
    topP,
    topK,
    repeatPenalty,
    reasoningEffort: effort,
    reasoningAdapter: caps.reasoningAdapter,
    jsonMode,
    contextMode,
  };
}

/** Materialize a normalized preset into the existing flat settings schema. */
function settingsPatchForPreset(preset, overrides = {}) {
  const params = normalizeParameters(preset, overrides);
  if (preset.provider === 'ollama') {
    return {
      ollamaModel: params.model,
      ollamaContextWindow: params.contextWindow,
      ollamaNumTokens: params.maxOutputTokens,
      ollamaTemperature: params.temperature,
      ollamaTopP: params.topP,
      ollamaTopK: params.topK,
      ollamaRepeatPenalty: params.repeatPenalty,
      ollamaReasoningEffort: params.reasoningEffort,
      ollamaReasoningAdapter: params.reasoningAdapter,
      ollamaJsonMode: params.jsonMode,
    };
  }
  if (preset.provider === 'lmstudio') {
    return {
      lmstudioModel: params.model,
      lmstudioContextWindow: params.contextWindow,
      lmstudioNumTokens: params.maxOutputTokens,
      lmstudioTemperature: params.temperature,
      lmstudioTopP: params.topP,
      lmstudioTopK: params.topK,
      lmstudioRepeatPenalty: params.repeatPenalty,
      lmstudioReasoningEffort: params.reasoningEffort,
      lmstudioReasoningAdapter: params.reasoningAdapter,
      lmstudioJsonMode: params.jsonMode,
      lmstudioContextMode: params.contextMode,
    };
  }
  if (preset.provider === 'omlx') {
    return {
      omlxModel: params.model,
      omlxContextWindow: params.contextWindow,
      omlxNumTokens: params.maxOutputTokens,
      omlxTemperature: params.temperature,
      omlxTopP: params.topP,
      omlxTopK: params.topK,
      omlxRepeatPenalty: params.repeatPenalty,
      omlxReasoningEffort: params.reasoningEffort,
      omlxReasoningAdapter: params.reasoningAdapter,
      omlxJsonMode: params.jsonMode,
      omlxContextMode: params.contextMode,
    };
  }
  if (preset.provider === 'codex') {
    return {
      codexModel: params.model,
      codexContextWindow: params.contextWindow,
      codexMaxTokens: params.maxOutputTokens,
      codexTemperature: params.temperature,
      codexReasoningEffort: params.reasoningEffort,
      codexReasoningAdapter: params.reasoningAdapter,
    };
  }
  return {
    claudeModel: params.model,
    claudeContextWindow: params.contextWindow,
    claudeMaxTokens: params.maxOutputTokens,
    claudeTemperature: params.temperature,
    claudeReasoningEffort: params.reasoningEffort,
    claudeReasoningAdapter: params.reasoningAdapter,
  };
}

/** Return a request-safe model id, or an empty string for malformed input. */
function sanitizeModelId(value) {
  return cleanModel(value, '');
}

function effortValuesFromProfile(profile) {
  if (!profile || !Array.isArray(profile.reasoningEfforts)) return [];
  const values = profile.reasoningEfforts
    .map((entry) => typeof entry === 'string' ? entry : entry && entry.value)
    .filter((value) => REASONING_EFFORTS.has(value));
  return [...new Set(values)];
}

/**
 * Convert a model-discovery profile into the same closed preset shape used by
 * the settings materializer. Discovery data is never copied through directly:
 * ids, limits, adapters, and effort values are independently allowlisted.
 */
function runtimePresetForProfile(provider, profile) {
  if (!['codex', 'claude'].includes(provider) || !profile || typeof profile !== 'object') return null;
  const model = sanitizeModelId(profile.id);
  if (!model) return null;

  const allowedAdapters = provider === 'codex'
    ? ['openai']
    : ['anthropic-adaptive', 'anthropic-effort'];
  let adapter = allowedAdapters.includes(profile.reasoningAdapter) ? profile.reasoningAdapter : 'none';
  let efforts = effortValuesFromProfile(profile);
  if (provider === 'claude') efforts = efforts.filter((effort) => effort !== 'ultra');
  if (adapter === 'none' || !efforts.some((effort) => effort !== 'none')) {
    adapter = 'none';
    efforts = ['none'];
  }
  const preferredEffort = String(profile.defaultReasoningEffort || '');
  const defaultEffort = efforts.includes(preferredEffort)
    ? preferredEffort
    : efforts.includes('high') ? 'high' : efforts[0];
  const contextWindow = clampInt(profile.contextWindow, 512, 4000000, provider === 'codex' ? 272000 : 200000);
  const maxOutputLimit = Math.min(contextWindow, 1000000);
  const maxOutputTokens = clampInt(profile.maxOutputTokens, 128, maxOutputLimit, Math.min(65536, maxOutputLimit));
  const suffix = normalizedModel(model).slice(0, 54) || 'model';

  return {
    id: `dynamic-${provider}-${suffix}`.slice(0, 80),
    label: String(profile.label || model).trim().slice(0, 120) || model,
    deployment: 'hosted',
    provider,
    model,
    sourceUrl: provider === 'codex'
      ? 'https://developers.openai.com/api/docs/models'
      : 'https://platform.claude.com/docs/en/about-claude/models/overview',
    modelPatterns: [model],
    recommended: false,
    description: String(profile.description || `Discovered ${provider} model.`).trim().slice(0, 500),
    requirements: `Sign in with ${provider === 'codex' ? 'ChatGPT' : 'Claude'}.`,
    limits: { contextWindow, maxOutputTokens },
    requestLimits: { maxOutputContextFraction: null },
    capabilities: {
      toolCalling: true,
      structuredOutput: provider === 'codex',
      temperature: false,
      contextWindowConfigurable: false,
      reasoningAdapter: adapter,
      reasoningEfforts: efforts,
    },
    parameters: {
      contextWindow,
      maxOutputTokens: Math.min(65536, maxOutputTokens),
      temperature: null,
      topP: null,
      topK: null,
      repeatPenalty: null,
      reasoning: {
        effort: defaultEffort,
        parameter: adapter === 'openai'
          ? 'reasoning.effort'
          : adapter === 'anthropic-adaptive'
            ? 'thinking.type=adaptive + output_config.effort'
            : adapter === 'anthropic-effort' ? 'output_config.effort' : null,
      },
      jsonMode: null,
      contextMode: null,
    },
  };
}

/**
 * Unknown local model names are valid, but their capabilities are unknowable.
 * Start them from a deliberately neutral profile instead of inheriting a
 * model-specific reasoning adapter from the previously selected model.
 */
function neutralLocalPreset(provider, value) {
  if (!['ollama', 'lmstudio', 'omlx'].includes(provider)) return null;
  const model = sanitizeModelId(value);
  if (!model) return null;
  const openAiCompatible = provider === 'lmstudio' || provider === 'omlx';
  return {
    id: 'custom',
    label: model,
    deployment: 'local',
    provider,
    model,
    limits: { contextWindow: 262144, maxOutputTokens: 128000 },
    requestLimits: { maxOutputContextFraction: openAiCompatible ? 0.5 : 1 },
    capabilities: {
      toolCalling: true,
      structuredOutput: true,
      temperature: true,
      contextWindowConfigurable: true,
      reasoningAdapter: 'none',
      reasoningEfforts: ['none'],
    },
    parameters: {
      contextWindow: 8192,
      maxOutputTokens: 4096,
      temperature: 0,
      topP: null,
      topK: null,
      repeatPenalty: null,
      reasoning: { effort: 'none', parameter: null },
      jsonMode: openAiCompatible ? 'text' : 'json',
      contextMode: openAiCompatible ? 'summarize' : null,
    },
  };
}

/** Materialize only fields that a reasoning dropdown is allowed to change. */
function settingsPatchForReasoning(preset, reasoningEffort, model = preset && preset.model) {
  if (!preset || !preset.capabilities.reasoningEfforts.includes(reasoningEffort)) return null;
  const params = normalizeParameters(preset, { model, reasoningEffort });
  const prefix = preset.provider === 'ollama'
    ? 'ollama'
    : preset.provider === 'lmstudio' ? 'lmstudio' : preset.provider;
  return {
    [`${prefix}Model`]: params.model,
    [`${prefix}ReasoningEffort`]: params.reasoningEffort,
    [`${prefix}ReasoningAdapter`]: params.reasoningAdapter,
  };
}

/** Build a safe editable profile for settings created before preset catalog v1. */
function customPresetForSettings(provider, settings) {
  if (!PROVIDER_DEPLOYMENT[provider]) return null;
  if (provider === 'ollama') {
    const adapter = ['ollama-think-effort', 'ollama-think-toggle'].includes(settings.ollamaReasoningAdapter)
      ? settings.ollamaReasoningAdapter
      : 'none';
    const efforts = adapter === 'ollama-think-effort'
      ? ['low', 'medium', 'high']
      : adapter === 'ollama-think-toggle' ? ['none', 'medium'] : ['none'];
    return {
      id: 'custom', provider, deployment: 'local', model: settings.ollamaModel || 'custom-model',
      limits: { contextWindow: 262144, maxOutputTokens: 128000 },
      requestLimits: { maxOutputContextFraction: 1 },
      capabilities: {
        temperature: true, contextWindowConfigurable: true,
        reasoningAdapter: adapter, reasoningEfforts: efforts,
      },
      parameters: {
        contextWindow: settings.ollamaContextWindow || 8192,
        maxOutputTokens: settings.ollamaNumTokens || 8192,
        temperature: settings.ollamaTemperature ?? 0,
        topP: settings.ollamaTopP ?? null,
        topK: settings.ollamaTopK ?? null,
        repeatPenalty: settings.ollamaRepeatPenalty ?? null,
        reasoning: { effort: efforts.includes(settings.ollamaReasoningEffort) ? settings.ollamaReasoningEffort : efforts[0], parameter: adapter === 'none' ? null : 'think' },
        jsonMode: settings.ollamaJsonMode || 'json', contextMode: null,
      },
    };
  }
  if (provider === 'lmstudio') {
    const adapter = settings.lmstudioReasoningAdapter === 'openai-compatible' ? 'openai-compatible' : 'none';
    return {
      id: 'custom', provider, deployment: 'local', model: settings.lmstudioModel || 'custom-model',
      limits: { contextWindow: 262144, maxOutputTokens: 128000 },
      requestLimits: { maxOutputContextFraction: 0.5 },
      capabilities: {
        temperature: true, contextWindowConfigurable: true, reasoningAdapter: adapter,
        reasoningEfforts: adapter === 'openai-compatible' ? ['none', 'low', 'medium', 'high'] : ['none'],
      },
      parameters: {
        contextWindow: settings.lmstudioContextWindow || 8192,
        maxOutputTokens: settings.lmstudioNumTokens || 16000,
        temperature: settings.lmstudioTemperature ?? 0,
        topP: settings.lmstudioTopP ?? null,
        topK: settings.lmstudioTopK ?? null,
        repeatPenalty: settings.lmstudioRepeatPenalty ?? null,
        reasoning: { effort: settings.lmstudioReasoningEffort || 'none', parameter: adapter === 'openai-compatible' ? 'reasoning_effort' : null },
        jsonMode: settings.lmstudioJsonMode || 'text', contextMode: settings.lmstudioContextMode || 'summarize',
      },
    };
  }
  if (provider === 'omlx') {
    const adapter = settings.omlxReasoningAdapter === 'omlx-template-effort' ? 'omlx-template-effort' : 'none';
    const efforts = adapter === 'omlx-template-effort' ? ['low', 'medium', 'high'] : ['none'];
    const defaultEffort = efforts.includes(settings.omlxReasoningEffort) ? settings.omlxReasoningEffort : efforts[0];
    return {
      id: 'custom', provider, deployment: 'local', model: settings.omlxModel || 'custom-model',
      limits: { contextWindow: 262144, maxOutputTokens: 128000 },
      requestLimits: { maxOutputContextFraction: 0.5 },
      capabilities: {
        temperature: true, contextWindowConfigurable: true, reasoningAdapter: adapter,
        reasoningEfforts: efforts,
      },
      parameters: {
        contextWindow: settings.omlxContextWindow || 8192,
        maxOutputTokens: settings.omlxNumTokens || 4096,
        temperature: settings.omlxTemperature ?? 0,
        topP: settings.omlxTopP ?? null,
        topK: settings.omlxTopK ?? null,
        repeatPenalty: settings.omlxRepeatPenalty ?? null,
        reasoning: {
          effort: defaultEffort,
          parameter: adapter === 'omlx-template-effort' ? 'chat_template_kwargs.reasoning_effort' : null,
        },
        jsonMode: settings.omlxJsonMode || 'text',
        contextMode: settings.omlxContextMode || 'summarize',
      },
    };
  }
  if (provider === 'codex') {
    const adapter = settings.codexReasoningAdapter === 'openai' ? 'openai' : 'none';
    const knownPreset = presetForModel('codex', settings.codexModel);
    const efforts = adapter === 'openai'
      ? knownPreset
        ? knownPreset.capabilities.reasoningEfforts
        : ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
      : ['none'];
    const defaultEffort = efforts.includes(settings.codexReasoningEffort)
      ? settings.codexReasoningEffort
      : knownPreset ? knownPreset.parameters.reasoning.effort : efforts[0];
    return {
      id: 'custom', provider, deployment: 'hosted', model: settings.codexModel || 'gpt-5.6-sol',
      limits: { contextWindow: 1050000, maxOutputTokens: 128000 },
      requestLimits: { maxOutputContextFraction: null },
      capabilities: {
        temperature: adapter === 'none', contextWindowConfigurable: false, reasoningAdapter: adapter,
        reasoningEfforts: efforts,
      },
      parameters: {
        contextWindow: settings.codexContextWindow || 1000000,
        maxOutputTokens: settings.codexMaxTokens || 4096,
        temperature: adapter === 'none' ? settings.codexTemperature ?? 0 : null,
        topP: null, topK: null, repeatPenalty: null,
        reasoning: { effort: defaultEffort, parameter: adapter === 'openai' ? 'reasoning.effort' : null },
        jsonMode: null, contextMode: null,
      },
    };
  }
  const adapter = ['anthropic-adaptive', 'anthropic-effort'].includes(settings.claudeReasoningAdapter)
    ? settings.claudeReasoningAdapter
    : 'none';
  const knownPreset = presetForModel('claude', settings.claudeModel);
  const efforts = adapter === 'anthropic-adaptive' || adapter === 'anthropic-effort'
    ? knownPreset
      ? knownPreset.capabilities.reasoningEfforts
      : ['none', 'low', 'medium', 'high', 'xhigh', 'max']
    : ['none'];
  const defaultEffort = efforts.includes(settings.claudeReasoningEffort)
    ? settings.claudeReasoningEffort
    : knownPreset ? knownPreset.parameters.reasoning.effort : efforts[0];
  return {
    id: 'custom', provider, deployment: 'hosted', model: settings.claudeModel || 'claude-opus-4-8',
    limits: { contextWindow: 1000000, maxOutputTokens: 128000 },
    requestLimits: { maxOutputContextFraction: null },
    capabilities: {
      temperature: false, contextWindowConfigurable: false, reasoningAdapter: adapter,
      reasoningEfforts: efforts,
    },
    parameters: {
      contextWindow: settings.claudeContextWindow || 1000000,
      maxOutputTokens: settings.claudeMaxTokens || 16000,
      temperature: null,
      topP: null, topK: null, repeatPenalty: null,
      reasoning: {
        effort: defaultEffort,
        parameter: adapter === 'anthropic-adaptive'
          ? 'thinking.type=adaptive + output_config.effort'
          : adapter === 'anthropic-effort' ? 'output_config.effort' : null,
      },
      jsonMode: null, contextMode: null,
    },
  };
}

function publicCatalog() {
  return catalog;
}

module.exports = {
  PROVIDER_DEPLOYMENT,
  ROLE_DEPLOYMENT,
  MODEL_ROLES,
  MODEL_ROLE_META,
  isPurposeRole,
  validateCatalog,
  getPreset,
  presetForRole,
  presetForModel,
  presetsForRole,
  normalizeParameters,
  modelMatchesPreset,
  sanitizeModelId,
  settingsPatchForPreset,
  settingsPatchForReasoning,
  customPresetForSettings,
  runtimePresetForProfile,
  neutralLocalPreset,
  publicCatalog,
};
