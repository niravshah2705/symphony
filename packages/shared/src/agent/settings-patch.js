'use strict';

/**
 * Whitelisted, validated settings patching.
 *
 * A single allow-list of NON-SECRET operational settings that may be changed
 * through the "settings as JSON" editor and the local-model settings tool.
 * Secrets (API keys, OAuth tokens, connector tokens) are deliberately excluded
 * here — they keep their dedicated, purpose-built endpoints so a JSON round-trip
 * (which only ever sees masked values) can never clobber or leak them.
 *
 * Every accepted key is coerced/validated; unknown or derived fields (e.g.
 * `hasKey`, `maskedKey`, `*Configured`) are silently ignored so the masked
 * public settings document can be edited and saved back safely.
 */

const { normalizeAgentRuntime, normalizeWorkflowPattern } = require('./runtimes');

const ALL_PROVIDERS = Object.freeze(['ollama', 'lmstudio', 'omlx', 'codex', 'claude', 'huggingface']);
const LOCAL_PROVIDERS = Object.freeze(['ollama', 'lmstudio', 'omlx']);
const PLANNING_PROVIDERS = Object.freeze(['linear', 'jira', 'asana']);
const REPOSITORY_PROVIDERS = Object.freeze(['github', 'gitlab']);
const RUNTIME_IDS = Object.freeze(['deepagent', 'codex-sdk', 'claude-agent-sdk']);
const WORKFLOW_PATTERN_IDS = Object.freeze(['sequential', 'parallel', 'evaluator', 'supervisor']);
const CONTEXT_MODES = Object.freeze(['summarize', 'trim', 'none']);
// Upper bound on the LLM stream retry count; matches the clamp in agent/llm.js.
const MAX_LLM_STREAM_RETRIES = 5;

/* ------------------------------ coercers ------------------------------ */
// Each coercer returns { ok: true, value } or { ok: false, reason }.

const str = (max = 400) => (v) => {
  const s = String(v ?? '').trim();
  if (s.length > max) return { ok: false, reason: `must be ${max} characters or fewer` };
  return { ok: true, value: s };
};

const num = (min, max) => (v) => {
  if (v === null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false, reason: 'must be a number' };
  return { ok: true, value: Math.min(max, Math.max(min, n)) };
};

const bool = () => (v) => ({ ok: true, value: Boolean(v) });

const int = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false, reason: 'must be an integer' };
  return { ok: true, value: Math.min(max, Math.max(min, Math.round(n))) };
};

const oneOf = (values) => (v) => {
  const s = String(v ?? '').trim();
  if (!values.includes(s)) return { ok: false, reason: `must be one of: ${values.join(', ')}` };
  return { ok: true, value: s };
};

const httpUrl = () => (v) => {
  const raw = String(v ?? '').trim();
  if (!raw) return { ok: true, value: '' };
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: 'must be an http(s) URL' };
    }
    return { ok: true, value: url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')) };
  } catch (_) {
    return { ok: false, reason: 'must be a valid URL' };
  }
};

const runtimeCoerce = (v) => {
  try {
    return { ok: true, value: normalizeAgentRuntime(v, { strict: true }) };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
};

const patternCoerce = (v) => {
  try {
    return { ok: true, value: normalizeWorkflowPattern(v, { strict: true }) };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
};

/* ---------------------- per-provider param blocks --------------------- */

function localParamKeys(p, { contextMode = false } = {}) {
  const map = {
    [`${p}Host`]: httpUrl(),
    [`${p}Model`]: str(200),
    [`${p}ContextWindow`]: num(0, 100_000_000),
    [`${p}NumTokens`]: num(0, 100_000_000),
    [`${p}Temperature`]: num(0, 2),
    [`${p}TopP`]: num(0, 1),
    [`${p}TopK`]: num(0, 100_000),
    [`${p}RepeatPenalty`]: num(0, 10),
    [`${p}ReasoningEffort`]: str(40),
    [`${p}ReasoningAdapter`]: str(40),
    [`${p}JsonMode`]: str(40),
  };
  if (contextMode) map[`${p}ContextMode`] = str(40);
  return map;
}

function hostedParamKeys(p, { contextMode = false } = {}) {
  const map = {
    [`${p}Model`]: str(200),
    [`${p}ContextWindow`]: num(0, 100_000_000),
    [`${p}MaxTokens`]: num(0, 100_000_000),
    [`${p}Temperature`]: num(0, 2),
    [`${p}ReasoningEffort`]: str(40),
    [`${p}ReasoningAdapter`]: str(40),
  };
  if (contextMode) map[`${p}ContextMode`] = oneOf(CONTEXT_MODES);
  return map;
}

/* --------------------------- the allow-list --------------------------- */

const ALLOWED = Object.freeze({
  // Harness (agent runtime) + workflow pattern
  agentRuntime: runtimeCoerce,
  workflowPattern: patternCoerce,

  // Retry an LLM stream this many times on a transient/in-stream error. Applies
  // to every provider (0 disables). See CONFIG.LLM_STREAM_RETRIES.
  llmStreamRetries: int(0, MAX_LLM_STREAM_RETRIES),

  // Provider slots (legacy) + purpose roles (thinking/execution/testing)
  llmProvider: oneOf(ALL_PROVIDERS),
  localLlmProvider: oneOf(LOCAL_PROVIDERS),
  thinkingLlmProvider: oneOf(ALL_PROVIDERS),
  executionLlmProvider: oneOf(ALL_PROVIDERS),
  testingLlmProvider: oneOf(ALL_PROVIDERS),
  hostedLlmPresetId: str(80),
  localLlmPresetId: str(80),
  thinkingLlmPresetId: str(80),
  executionLlmPresetId: str(80),
  testingLlmPresetId: str(80),

  // Per-provider model/host/parameter blocks
  ...localParamKeys('ollama'),
  ...localParamKeys('lmstudio', { contextMode: true }),
  ...localParamKeys('omlx', { contextMode: true }),
  ...hostedParamKeys('codex', { contextMode: true }),
  ...hostedParamKeys('claude'),
  ...hostedParamKeys('huggingface'),
  huggingfaceHost: httpUrl(), // hosted, but the router base URL is operator-configurable

  // LangSmith (non-secret only; the API key keeps its dedicated endpoint)
  langsmithProject: str(200),
  langsmithEndpoint: httpUrl(),
  langsmithTracing: bool(),

  // Planning + repository (non-secret only; tokens keep dedicated endpoints)
  planningProvider: oneOf(PLANNING_PROVIDERS),
  repositoryProvider: oneOf(REPOSITORY_PROVIDERS),
  repositoryUrl: str(500),
  jiraBaseUrl: str(300),
  jiraEmail: str(200),
  asanaWorkspaceId: str(100),
});

const EDITABLE_KEYS = Object.freeze(Object.keys(ALLOWED));

/**
 * Validate an arbitrary object into a safe settings patch.
 * @param {object} input
 * @returns {{ patch: object, applied: string[], rejected: {key,reason}[], ignored: string[] }}
 */
function sanitizeSettingsPatch(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const patch = {};
  const applied = [];
  const rejected = [];
  const ignored = [];
  for (const [key, raw] of Object.entries(source)) {
    const coerce = ALLOWED[key];
    if (!coerce) {
      ignored.push(key);
      continue;
    }
    const result = coerce(raw);
    if (!result.ok) {
      rejected.push({ key, reason: result.reason });
      continue;
    }
    patch[key] = result.value;
    applied.push(key);
  }
  return { patch, applied, rejected, ignored };
}

/**
 * Sanitize then persist to the store. Nothing is written when the patch is empty.
 * @param {object} input
 * @returns {{ patch, applied, rejected, ignored }}
 */
function applySettingsPatch(input) {
  const result = sanitizeSettingsPatch(input);
  if (result.applied.length) {
    // Lazy require avoids a load-time cycle with the store.
    const { patchSettings } = require('../store');
    patchSettings(result.patch);
  }
  return result;
}

/** Pick only the editable, non-secret keys from a full settings object. */
function snapshotEditable(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const snapshot = {};
  for (const key of EDITABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) snapshot[key] = source[key];
  }
  return snapshot;
}

/** Compact, human/LLM-readable description of what may be changed. */
function describeEditableSettings() {
  return [
    'Editable settings keys (change only what must change):',
    EDITABLE_KEYS.join(', '),
    '',
    'Enum values:',
    `- agentRuntime (harness): ${RUNTIME_IDS.join(' | ')} (deepagent=DeepAgent, codex-sdk=Codex, claude-agent-sdk=ClaudeCode)`,
    `- workflowPattern: ${WORKFLOW_PATTERN_IDS.join(' | ')}`,
    `- llmProvider / thinkingLlmProvider / executionLlmProvider / testingLlmProvider: ${ALL_PROVIDERS.join(' | ')}`,
    `- localLlmProvider: ${LOCAL_PROVIDERS.join(' | ')}`,
    `- planningProvider: ${PLANNING_PROVIDERS.join(' | ')}`,
    `- repositoryProvider: ${REPOSITORY_PROVIDERS.join(' | ')}`,
    `- lmstudioContextMode / omlxContextMode / codexContextMode: ${CONTEXT_MODES.join(' | ')}`,
    '- langsmithTracing: true | false',
    '',
    'Numbers: temperature 0-2, topP 0-1; context windows and token limits are integers.',
    `- llmStreamRetries (all providers): integer 0-${MAX_LLM_STREAM_RETRIES} (retries on a transient/in-stream LLM error).`,
    'Never set secrets, API keys, or tokens here — those are not editable.',
  ].join('\n');
}

module.exports = {
  ALL_PROVIDERS,
  LOCAL_PROVIDERS,
  EDITABLE_KEYS,
  sanitizeSettingsPatch,
  applySettingsPatch,
  snapshotEditable,
  describeEditableSettings,
};
