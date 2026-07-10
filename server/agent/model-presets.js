'use strict';

const catalog = require('./llm-presets.json');

const PROVIDER_DEPLOYMENT = Object.freeze({
  ollama: 'local',
  lmstudio: 'local',
  codex: 'hosted',
  claude: 'hosted',
});
const ROLE_DEPLOYMENT = Object.freeze({ local: 'local', global: 'hosted' });
const REASONING_ADAPTERS = new Set([
  'none',
  'ollama-think-toggle',
  'ollama-think-effort',
  'openai-compatible',
  'openai',
  'anthropic-adaptive',
]);
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const JSON_MODES = Object.freeze({
  ollama: new Set(['json', 'text']),
  lmstudio: new Set(['text', 'json_object', 'json_schema']),
});
const CONTEXT_MODES = new Set(['summarize', 'trim', 'none']);

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid LLM preset catalog: ${message}`);
}

function validateCatalog(value) {
  assert(value && Number.isInteger(value.version) && value.version > 0, 'version must be a positive integer');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value.updatedAt || ''), 'updatedAt must be YYYY-MM-DD');
  assert(value.defaults && typeof value.defaults === 'object', 'defaults are required');
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
    if (preset.provider === 'ollama' || preset.provider === 'lmstudio') {
      assert(JSON_MODES[preset.provider].has(params.jsonMode), `${preset.id}: invalid JSON mode`);
    } else {
      assert(params.jsonMode === null, `${preset.id}: hosted JSON mode must be null`);
    }
    if (preset.provider === 'lmstudio') assert(CONTEXT_MODES.has(params.contextMode), `${preset.id}: invalid context mode`);
    else assert(params.contextMode === null, `${preset.id}: context mode only applies to LM Studio`);
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
  const deployment = ROLE_DEPLOYMENT[role];
  return deployment ? catalog.presets.filter((preset) => preset.deployment === deployment) : [];
}

function presetForRole(id, role) {
  const preset = getPreset(id);
  return preset && preset.deployment === ROLE_DEPLOYMENT[role] ? preset : null;
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
  const outputMinimum = preset.provider === 'lmstudio' ? 256 : 128;
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
    preset.provider === 'lmstudio' && CONTEXT_MODES.has(overrides.contextMode)
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
  if (provider === 'codex') {
    const adapter = settings.codexReasoningAdapter === 'openai' ? 'openai' : 'none';
    return {
      id: 'custom', provider, deployment: 'hosted', model: settings.codexModel || 'gpt-5.5',
      limits: { contextWindow: 1050000, maxOutputTokens: 128000 },
      requestLimits: { maxOutputContextFraction: null },
      capabilities: {
        temperature: adapter === 'none', contextWindowConfigurable: false, reasoningAdapter: adapter,
        reasoningEfforts: adapter === 'openai' ? ['none', 'low', 'medium', 'high', 'xhigh'] : ['none'],
      },
      parameters: {
        contextWindow: settings.codexContextWindow || 1000000,
        maxOutputTokens: settings.codexMaxTokens || 4096,
        temperature: adapter === 'none' ? settings.codexTemperature ?? 0 : null,
        topP: null, topK: null, repeatPenalty: null,
        reasoning: { effort: settings.codexReasoningEffort || 'none', parameter: adapter === 'openai' ? 'reasoning.effort' : null },
        jsonMode: null, contextMode: null,
      },
    };
  }
  const adapter = settings.claudeReasoningAdapter === 'anthropic-adaptive' ? 'anthropic-adaptive' : 'none';
  return {
    id: 'custom', provider, deployment: 'hosted', model: settings.claudeModel || 'claude-opus-4-8',
    limits: { contextWindow: 1000000, maxOutputTokens: 128000 },
    requestLimits: { maxOutputContextFraction: null },
    capabilities: {
      temperature: false, contextWindowConfigurable: false, reasoningAdapter: adapter,
      reasoningEfforts: adapter === 'anthropic-adaptive' ? ['none', 'low', 'medium', 'high', 'xhigh', 'max'] : ['none'],
    },
    parameters: {
      contextWindow: settings.claudeContextWindow || 1000000,
      maxOutputTokens: settings.claudeMaxTokens || 16000,
      temperature: null,
      topP: null, topK: null, repeatPenalty: null,
      reasoning: { effort: settings.claudeReasoningEffort || 'none', parameter: adapter === 'anthropic-adaptive' ? 'thinking.type=adaptive + output_config.effort' : null },
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
  validateCatalog,
  getPreset,
  presetForRole,
  presetForModel,
  presetsForRole,
  normalizeParameters,
  modelMatchesPreset,
  settingsPatchForPreset,
  customPresetForSettings,
  publicCatalog,
};
