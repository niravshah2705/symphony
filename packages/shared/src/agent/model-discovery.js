'use strict';

const { CONFIG } = require('../config');
const store = require('../store');
const codexOauth = require('./oauth');
const claudeOauth = require('./claude-oauth');

const CACHE_TTL_MS = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 5000;

const EFFORT_LABELS = Object.freeze({
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
});

const EFFORT_DESCRIPTIONS = Object.freeze({
  none: 'Disable additional reasoning.',
  minimal: 'Use the smallest available reasoning budget.',
  low: 'Fast responses with lighter reasoning.',
  medium: 'Balance speed and reasoning depth for everyday tasks.',
  high: 'Use greater reasoning depth for complex problems.',
  xhigh: 'Use extra reasoning for difficult, long-running work.',
  max: 'Use maximum reasoning depth for the hardest problems.',
  ultra: 'Use maximum reasoning with automatic task delegation.',
});

const CODEX_CHATGPT_PROFILES = Object.freeze([
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description: 'Latest frontier agentic coding model for complex professional work.',
    contextWindow: 372000,
    apiContextWindow: 1050000,
    maxOutputTokens: 128000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    apiEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'xhigh',
    apiDefaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'GPT-5.6 model balancing intelligence, latency, and cost.',
    contextWindow: 372000,
    apiContextWindow: 1050000,
    maxOutputTokens: 128000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    apiEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'xhigh',
    apiDefaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'GPT-5.6 model optimized for cost-sensitive, high-volume workloads.',
    contextWindow: 372000,
    apiContextWindow: 1050000,
    maxOutputTokens: 128000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    apiEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'xhigh',
    apiDefaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
    contextWindow: 272000,
    apiContextWindow: 1050000,
    maxOutputTokens: 128000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    apiEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'xhigh',
    apiDefaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'Strong general-purpose model for coding and professional work.',
    contextWindow: 272000,
    apiContextWindow: 1050000,
    maxOutputTokens: 128000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    apiEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
    apiDefaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: 'Smaller frontier model for fast coding and subagent workloads.',
    contextWindow: 272000,
    apiContextWindow: 400000,
    maxOutputTokens: 128000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    apiEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
    apiDefaultReasoningEffort: 'medium',
  },
]);

const CLAUDE_PROFILES = Object.freeze([
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    description: 'Next-generation intelligence for long-running agents.',
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    reasoningAdapter: 'anthropic-adaptive',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high',
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    description: 'Complex agentic coding and high-autonomy enterprise work.',
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    reasoningAdapter: 'anthropic-adaptive',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    description: 'Fast frontier model balancing intelligence and throughput.',
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    reasoningAdapter: 'anthropic-adaptive',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    description: 'Fast, economical model for high-volume and subagent workloads.',
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoningAdapter: 'none',
    efforts: ['none'],
    defaultReasoningEffort: 'none',
  },
]);

const cache = new Map();

function safePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function titleFromId(id) {
  return String(id || '')
    .split('-')
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1)))
    .join(' ');
}

function effortOptions(values, descriptions = null) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((entry) => {
      const value = typeof entry === 'string' ? entry : entry && (entry.effort || entry.value);
      if (!value || seen.has(value) || !EFFORT_LABELS[value]) return null;
      seen.add(value);
      const supplied = typeof entry === 'object' && entry ? entry.description : null;
      return {
        value,
        label: EFFORT_LABELS[value],
        description: supplied || (descriptions && descriptions[value]) || EFFORT_DESCRIPTIONS[value],
      };
    })
    .filter(Boolean);
}

function cloneModel(model) {
  return {
    ...model,
    reasoningEfforts: model.reasoningEfforts.map((effort) => ({ ...effort })),
  };
}

function cloneModels(models) {
  return models.map(cloneModel);
}

function codexFallbackModels(backend = CONFIG.OAUTH.backend) {
  const api = backend === 'api';
  return CODEX_CHATGPT_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    description: profile.description,
    contextWindow: api ? profile.apiContextWindow : profile.contextWindow,
    maxOutputTokens: profile.maxOutputTokens,
    reasoningAdapter: 'openai',
    reasoningEfforts: effortOptions(api ? profile.apiEfforts : profile.efforts),
    defaultReasoningEffort: api ? profile.apiDefaultReasoningEffort : profile.defaultReasoningEffort,
    source: 'fallback',
  }));
}

function claudeFallbackModels() {
  return CLAUDE_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    description: profile.description,
    contextWindow: profile.contextWindow,
    maxOutputTokens: profile.maxOutputTokens,
    reasoningAdapter: profile.reasoningAdapter,
    reasoningEfforts: effortOptions(profile.efforts),
    defaultReasoningEffort: profile.defaultReasoningEffort,
    source: 'fallback',
  }));
}

function seedCache() {
  cache.set('codex:chatgpt', {
    models: codexFallbackModels('chatgpt'), source: 'fallback', refreshedAt: null, expiresAt: 0,
  });
  cache.set('codex:api', {
    models: codexFallbackModels('api'), source: 'fallback', refreshedAt: null, expiresAt: 0,
  });
  cache.set('claude', {
    models: claudeFallbackModels(), source: 'fallback', refreshedAt: null, expiresAt: 0,
  });
}

seedCache();

function cacheKey(provider, backend = CONFIG.OAUTH.backend) {
  return provider === 'codex' ? `codex:${backend === 'api' ? 'api' : 'chatgpt'}` : 'claude';
}

function fallbackModels(provider, backend = CONFIG.OAUTH.backend) {
  return provider === 'codex' ? codexFallbackModels(backend) : claudeFallbackModels();
}

function result(provider, models, source, connected, refreshedAt) {
  return {
    provider,
    models: cloneModels(models),
    source,
    connected,
    refreshedAt,
  };
}

function fallbackResult(provider, backend, connected) {
  return result(provider, fallbackModels(provider, backend), 'fallback', connected, null);
}

function findCodexProfile(id) {
  const normalized = String(id || '').toLowerCase();
  if (normalized === 'gpt-5.6') return CODEX_CHATGPT_PROFILES[0];
  return CODEX_CHATGPT_PROFILES.find((profile) => profile.id === normalized) || null;
}

function findClaudeProfile(id) {
  const normalized = String(id || '').toLowerCase();
  if (normalized === 'claude-haiku-4-5') return CLAUDE_PROFILES[3];
  return CLAUDE_PROFILES.find((profile) => profile.id === normalized) || null;
}

function mapCodexChatgptModel(raw) {
  const id = String(raw.slug || raw.id || '').trim();
  if (!id) return null;
  const fallback = findCodexProfile(id);
  const efforts = effortOptions(raw.supported_reasoning_levels);
  const usableEfforts = efforts.length
    ? efforts
    : effortOptions(fallback ? fallback.efforts : ['low', 'medium', 'high', 'xhigh']);
  const defaultEffort = usableEfforts.some((entry) => entry.value === raw.default_reasoning_level)
    ? raw.default_reasoning_level
    : fallback && usableEfforts.some((entry) => entry.value === fallback.defaultReasoningEffort)
      ? fallback.defaultReasoningEffort
      : usableEfforts[0].value;
  return {
    id,
    label: raw.display_name || (fallback && fallback.label) || titleFromId(id),
    description: raw.description || (fallback && fallback.description) || 'Available through Codex.',
    contextWindow: safePositiveInt(raw.context_window, fallback ? fallback.contextWindow : 128000),
    maxOutputTokens: safePositiveInt(raw.max_output_tokens, fallback ? fallback.maxOutputTokens : 128000),
    reasoningAdapter: 'openai',
    reasoningEfforts: usableEfforts,
    defaultReasoningEffort: defaultEffort,
    source: 'live',
  };
}

function isSelectableOpenAiModel(id) {
  const value = String(id || '').toLowerCase();
  if (!/^(gpt-|o\d|chatgpt-)/.test(value)) return false;
  return !/(audio|realtime|transcrib|tts|image|search|embedding|moderation)/.test(value);
}

function genericOpenAiApiModel(id) {
  return {
    id,
    label: titleFromId(id),
    description: 'Available to the connected OpenAI API account; reasoning capabilities are provider-managed until catalog metadata is known.',
    contextWindow: 128000,
    maxOutputTokens: 128000,
    reasoningAdapter: 'none',
    reasoningEfforts: effortOptions(['none']),
    defaultReasoningEffort: 'none',
    source: 'live',
  };
}

function mergeMeteredCodexModels(rawModels) {
  const fallbacks = codexFallbackModels('api');
  const available = new Map();
  for (const raw of Array.isArray(rawModels) ? rawModels : []) {
    const id = String(raw && (raw.id || raw.slug) || '').trim();
    if (id && isSelectableOpenAiModel(id)) available.set(id, raw);
  }
  const merged = fallbacks.map((model) => ({
    ...model,
    source: available.has(model.id) ? 'live' : 'fallback',
  }));
  const known = new Set(merged.map((model) => model.id));
  for (const id of available.keys()) {
    if (!known.has(id)) merged.push(genericOpenAiApiModel(id));
  }
  // `ultra` is a Codex product mode, not a public Responses API effort.
  return merged.map((model) => ({
    ...model,
    reasoningEfforts: model.reasoningEfforts.filter((effort) => effort.value !== 'ultra'),
  }));
}

function capabilitySupported(value) {
  return Boolean(value && value.supported);
}

function mapClaudeModel(raw) {
  const id = String(raw && raw.id || '').trim();
  if (!id) return null;
  const fallback = findClaudeProfile(id);
  const capabilities = raw.capabilities || {};
  const effort = capabilities.effort || null;
  const effortValues = [];
  if (effort && effort.supported) {
    for (const value of ['low', 'medium', 'high', 'xhigh', 'max']) {
      if (capabilitySupported(effort[value])) effortValues.push(value);
    }
  }
  if (!effortValues.length && fallback && fallback.reasoningAdapter !== 'none') {
    effortValues.push(...fallback.efforts);
  }
  const adaptiveCapability = capabilities.thinking && capabilities.thinking.types &&
    capabilities.thinking.types.adaptive;
  const adaptiveSupported = capabilitySupported(adaptiveCapability);
  const fallbackAdaptive = !adaptiveCapability && fallback && fallback.reasoningAdapter === 'anthropic-adaptive';
  const reasoningAdapter = effortValues.length
    ? adaptiveSupported || fallbackAdaptive ? 'anthropic-adaptive' : 'anthropic-effort'
    : 'none';
  const efforts = effortOptions(effortValues.length ? effortValues : ['none']);
  const fallbackDefault = fallback ? fallback.defaultReasoningEffort : null;
  const defaultReasoningEffort = efforts.some((entry) => entry.value === fallbackDefault)
    ? fallbackDefault
    : efforts.some((entry) => entry.value === 'high') ? 'high' : efforts[0].value;
  return {
    id,
    label: raw.display_name || (fallback && fallback.label) || titleFromId(id),
    description: (fallback && fallback.description) || 'Available to the connected Claude account.',
    contextWindow: safePositiveInt(raw.max_input_tokens, fallback ? fallback.contextWindow : 200000),
    maxOutputTokens: safePositiveInt(raw.max_tokens, fallback ? fallback.maxOutputTokens : 64000),
    reasoningAdapter,
    reasoningEfforts: efforts,
    defaultReasoningEffort,
    source: 'live',
  };
}

function hasCredentials(tokens) {
  return Boolean(tokens && (tokens.accessToken || tokens.refreshToken));
}

async function storedCodexCredentials() {
  let tokens = store.getCodexTokens();
  if (!hasCredentials(tokens)) return null;
  if (codexOauth.isExpired(tokens)) {
    tokens = await codexOauth.refreshTokens(tokens);
    store.setCodexTokens(tokens);
  }
  return {
    accessToken: tokens.accessToken,
    accountId: codexOauth.accountIdFromIdToken(tokens.idToken),
  };
}

async function storedClaudeCredentials() {
  let tokens = store.getClaudeTokens();
  if (!hasCredentials(tokens)) return null;
  if (claudeOauth.isExpired(tokens)) {
    tokens = await claudeOauth.refreshTokens(tokens);
    store.setClaudeTokens(tokens);
  }
  return { accessToken: tokens.accessToken };
}

function configuredConnected(provider) {
  return provider === 'codex'
    ? hasCredentials(store.getCodexTokens())
    : hasCredentials(store.getClaudeTokens());
}

async function credentialsFor(provider, options) {
  if (Object.prototype.hasOwnProperty.call(options, 'credentials')) return options.credentials;
  return provider === 'codex' ? storedCodexCredentials() : storedClaudeCredentials();
}

async function fetchCodexModels(credentials, backend, options) {
  const fetchImpl = options.fetchImpl || fetch;
  const baseUrl = String(backend === 'api' ? CONFIG.OAUTH.baseUrl : CONFIG.OAUTH.chatgptBaseUrl).replace(/\/$/, '');
  if (backend === 'api') {
    const response = await fetchImpl(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${credentials.accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OpenAI models request failed (HTTP ${response.status}).`);
    const body = await response.json();
    return mergeMeteredCodexModels(body.data);
  }
  if (!credentials.accountId) throw new Error('Codex model discovery requires a ChatGPT account id.');
  const clientVersion = options.clientVersion || CONFIG.OAUTH.clientVersion;
  const url = new URL(`${baseUrl}/models`);
  url.searchParams.set('client_version', clientVersion);
  const response = await fetchImpl(url.toString(), {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'chatgpt-account-id': credentials.accountId,
      Accept: 'application/json',
      originator: 'codex_cli_rs',
    },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Codex models request failed (HTTP ${response.status}).`);
  const body = await response.json();
  const models = (Array.isArray(body.models) ? body.models : [])
    .filter((model) => model && model.visibility === 'list' && model.supported_in_api === true)
    .sort((a, b) => (Number(a.priority) || 9999) - (Number(b.priority) || 9999))
    .map(mapCodexChatgptModel)
    .filter(Boolean);
  if (!models.length) throw new Error('Codex returned no selectable models.');
  return models;
}

async function fetchClaudeModels(credentials, options) {
  const createClient = options.createAnthropicClient || ((clientOptions) => {
    const { Anthropic } = require('@anthropic-ai/sdk');
    return new Anthropic(clientOptions);
  });
  const client = createClient({
    apiKey: null,
    authToken: credentials.accessToken,
    baseURL: String(CONFIG.CLAUDE.baseUrl).replace(/\/$/, ''),
    timeout: DISCOVERY_TIMEOUT_MS,
    maxRetries: 0,
    defaultHeaders: { 'anthropic-beta': CONFIG.CLAUDE.betaHeader },
  });
  const page = await client.models.list({ limit: 100 });
  const models = (Array.isArray(page.data) ? page.data : [])
    .map(mapClaudeModel)
    .filter(Boolean);
  if (!models.length) throw new Error('Claude returned no selectable models.');
  return models;
}

/**
 * Discover selectable hosted models. Live results are cached briefly; callers
 * can pass `{ refresh: true }` to bypass the cache. Discovery is deliberately
 * fail-open to the static catalog so the Settings page always remains usable.
 */
async function discoverModels(provider, options = {}) {
  if (provider !== 'codex' && provider !== 'claude') {
    throw new TypeError(`Unsupported model discovery provider: ${provider}`);
  }
  const backend = provider === 'codex' && (options.backend || CONFIG.OAUTH.backend) === 'api' ? 'api' : 'chatgpt';
  const key = cacheKey(provider, backend);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const connected = Object.prototype.hasOwnProperty.call(options, 'credentials')
    ? hasCredentials(options.credentials)
    : configuredConnected(provider);
  if (!connected) return fallbackResult(provider, backend, false);

  const cached = cache.get(key);
  if (!options.refresh && cached && cached.source === 'live' && cached.expiresAt > now) {
    return result(provider, cached.models, cached.source, true, cached.refreshedAt);
  }

  try {
    const credentials = await credentialsFor(provider, options);
    if (!credentials || !credentials.accessToken) return fallbackResult(provider, backend, false);
    const models = provider === 'codex'
      ? await fetchCodexModels(credentials, backend, options)
      : await fetchClaudeModels(credentials, options);
    const refreshedAt = new Date(now).toISOString();
    cache.set(key, { models: cloneModels(models), source: 'live', refreshedAt, expiresAt: now + CACHE_TTL_MS });
    return result(provider, models, 'live', true, refreshedAt);
  } catch (error) {
    // Agent dispatch uses strict discovery as a readiness preflight: falling
    // back to a static catalog there would claim that an inaccessible model is
    // usable and start a job that is certain to fail. Settings keeps the
    // existing fail-open behavior by omitting `strict`.
    if (options.strict) throw error;
    cache.set(key, { models: fallbackModels(provider, backend), source: 'fallback', refreshedAt: null, expiresAt: 0 });
    return fallbackResult(provider, backend, true);
  }
}

/** Return a discovered model synchronously, falling back to the seeded catalog. */
function getCachedModel(provider, id) {
  if (provider !== 'codex' && provider !== 'claude') return null;
  const modelId = String(id || '').trim();
  if (!modelId) return null;
  const preferredKey = cacheKey(provider, CONFIG.OAUTH.backend);
  const keys = provider === 'codex'
    ? [preferredKey, preferredKey === 'codex:api' ? 'codex:chatgpt' : 'codex:api']
    : ['claude'];
  for (const key of keys) {
    const entry = cache.get(key);
    const model = entry && entry.models.find((candidate) => candidate.id === modelId);
    if (model) return cloneModel(model);
  }
  const fallback = fallbackModels(provider, CONFIG.OAUTH.backend)
    .find((candidate) => candidate.id === modelId);
  return fallback ? cloneModel(fallback) : null;
}

function resetCacheForTests() {
  cache.clear();
  seedCache();
}

module.exports = {
  discoverModels,
  getCachedModel,
  _test: {
    resetCacheForTests,
    mapCodexChatgptModel,
    mergeMeteredCodexModels,
    mapClaudeModel,
    codexFallbackModels,
    claudeFallbackModels,
  },
};
