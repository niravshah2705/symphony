'use strict';

const crypto = require('crypto');
const { CONFIG } = require('../config');
const store = require('../store');
const logger = require('../logger');
const oauth = require('./oauth');
const claudeOauth = require('./claude-oauth');
const { runWithRetry, streamWithRetry } = require('./llm-retry');

// Hard cap on the configurable stream-retry count (mirrors settings-patch.js).
const MAX_STREAM_RETRIES = 5;

/** Coerce an operator-supplied retry count to a bounded, non-negative integer. */
function clampStreamRetries(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return CONFIG.LLM_STREAM_RETRIES;
  return Math.min(MAX_STREAM_RETRIES, Math.max(0, Math.round(n)));
}

/**
 * Build the `onRetry` callback passed to the retry helpers: logs each retry with
 * the provider and whatever the provider disclosed (HTTP status, error code/type,
 * message) so a recurring transient failure is visible instead of silent.
 */
function streamRetryLogger(provider) {
  return (err, attempt) => {
    const status = err && (err.status ?? err.statusCode);
    const detail = (err && err.error && (err.error.code || err.error.type)) || (err && err.code) || '';
    const message = err && err.message ? ` ${err.message}` : '';
    logger.warn(
      `LLM stream error on ${provider} (status=${status ?? 'none'}${detail ? `, ${detail}` : ''}); retry ${attempt}.${message}`
    );
  };
}

/**
 * Deep-agent LLM provider factory. Five providers are supported:
 *   - 'ollama'   — local inference (ChatOllama), no credentials.
 *   - 'lmstudio' — local inference via LM Studio's OpenAI-compatible API
 *                  (ChatOpenAI against http://localhost:1234/v1), no credentials.
 *   - 'omlx'     — local Apple-Silicon inference via oMLX's OpenAI-compatible API
 *                  (ChatOpenAI against http://127.0.0.1:8000/v1), optional key.
 *   - 'codex'    — OpenAI via OAuth (ChatOpenAI) with a Bearer access token.
 *   - 'claude'   — Anthropic via OAuth (ChatAnthropic) with a Bearer access token.
 *
 * plan.js is provider-agnostic: it builds a provider `llm` descriptor (via
 * resolveLlm) and asks this factory for a chat model. Tokens never leave the
 * server; the descriptor carries a short-lived access token resolved per run.
 */

/**
 * The ChatGPT Codex backend rejects `role:"system"` items in `input` (it expects
 * the system prompt as top-level `instructions`, and injects its own). LangChain
 * only auto-maps system→developer on one of its two Responses converter paths, so
 * messages carrying `output_version:"v1"` (e.g. from the deep agent) slip through
 * as `role:"system"` and 400. Normalizing every system message to a generic
 * `developer` ChatMessage makes BOTH converter paths emit `developer` (accepted).
 */
/**
 * Map an LM Studio JSON mode to the `modelKwargs` for the OpenAI-compatible call.
 * Returns null when no request-level constraint should be sent (prompt-driven).
 *   - 'json_object' — classic OpenAI JSON mode (rejected by some engines, e.g. ornith)
 *   - 'json_schema' — structured output constrained to a permissive JSON object;
 *     the planner's prompts already pin the exact shape, so a generic object schema
 *     (strict:false) is enough to force valid JSON without over-constraining.
 *   - anything else (incl. 'text') — no response_format; rely on the prompt +
 *     parseJsonLoose (identical to how the Claude provider handles JSON).
 */
function lmstudioJsonKwargs(mode) {
  if (mode === 'json_object') return { response_format: { type: 'json_object' } };
  if (mode === 'json_schema') {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'response', strict: false, schema: { type: 'object', additionalProperties: true } },
      },
    };
  }
  return null;
}

/**
 * Output-token budget for LM Studio, bounded by the loaded context window. LM
 * Studio can't resize n_ctx per request, so the prompt + output must fit the
 * loaded window. We reserve roughly half the window for the (large) deep-agent
 * prompt and cap max_tokens at the rest, so a request never asks for more output
 * than the context can hold (which triggers "n_keep >= n_ctx" 400s).
 */
function lmstudioMaxTokens(llm) {
  const ctx = Number(llm.contextWindow) || 8192;
  const want = Number(llm.numTokens) || 4096;
  return Math.max(256, Math.min(want, Math.floor(ctx / 2)));
}

/** oMLX output budget; saved presets already reserve prompt room explicitly. */
function omlxMaxTokens(llm) {
  const ctx = Number(llm.contextWindow) || 8192;
  const want = Number(llm.numTokens) || 4096;
  return Math.max(256, Math.min(want, Math.max(256, ctx - 256)));
}

/**
 * Output-token reserve used when sizing the Codex prompt budget. The ChatGPT
 * backend rejects `max_output_tokens` (we send `maxTokens:-1`), so unlike LM
 * Studio this does NOT cap output — it only reserves room for the response when
 * computing how much of the context window the prompt may occupy.
 */
function codexMaxTokens(llm) {
  const want = Number(llm && llm.numTokens) || 4096;
  return Math.max(256, want);
}

/**
 * Prompt-token budget for Codex: the model's context window minus the output
 * reserve and a fixed margin. Returns 0 when no window is known (→ context
 * management disabled). Mirrors lmstudioPromptBudget so a long deep-agent run
 * can't overflow even a large hosted window.
 */
function codexPromptBudget(llm) {
  const ctx = Number(llm && llm.contextWindow) || 0;
  if (ctx <= 0) return 0;
  const budget = ctx - codexMaxTokens(llm) - CONFIG.OAUTH.promptMarginTokens;
  return Math.max(0, budget);
}

// Context-window management (trim / summarize) lives in its own module; it is
// provider-agnostic and LLM-client-free (summarization is injected), so it stays
// pure and testable. See lmstudio-context.js.
const {
  prepareMessages,
  trimMessagesForBudget,
  estimateMessageTokens,
  SUMMARY_SYSTEM_PROMPT,
  contentToText,
} = require('./lmstudio-context');

/**
 * Max prompt tokens for LM Studio: the operator-declared context window minus the
 * reserved output budget (the max_tokens we send) and a safety margin. Returns 0
 * when no context window is known (→ context management disabled). Uses the declared
 * window, which should be ≤ the model's loaded window, so the estimate stays
 * conservative.
 */
function lmstudioPromptBudget(llm) {
  const ctx = Number(llm && llm.contextWindow) || 0;
  if (ctx <= 0) return 0;
  const budget = ctx - lmstudioMaxTokens(llm) - CONFIG.LMSTUDIO.promptMarginTokens;
  return Math.max(0, budget);
}

function omlxPromptBudget(llm) {
  const ctx = Number(llm && llm.contextWindow) || 0;
  if (ctx <= 0) return 0;
  return Math.max(0, ctx - omlxMaxTokens(llm) - CONFIG.OMLX.promptMarginTokens);
}

// Dedup key for the "loaded < configured" warning so resolveLlm (called on every
// scheduler/monitor tick) logs it once per distinct situation, not every tick.
let lastCtxMismatchWarning = null;

/**
 * Warn (at most once per distinct model/loaded/declared combination) when LM Studio
 * loaded a smaller context window than the operator configured.
 */
function warnContextMismatch(model, loaded, declared) {
  if (!(loaded && declared && loaded < declared)) return;
  const key = `${model}:${loaded}:${declared}`;
  if (key === lastCtxMismatchWarning) return;
  lastCtxMismatchWarning = key;
  logger.warn(
    `LM Studio: model "${model}" is loaded with only ${loaded} context tokens, but the app is configured for ${declared}. Using ${loaded}. Reload the model in LM Studio with a larger context window (it must exceed the coder's initial prompt, ~10–20k tokens) to run the coder.`
  );
}

/**
 * Reconcile the operator-declared context window with the value LM Studio actually
 * loaded the model with. LM Studio fixes n_ctx at load time and may load a model
 * with a SMALLER window than configured (e.g. reduced to fit memory). Keying the
 * prompt budget to a too-large window sends prompts the model can't hold → instant
 * "tokens to keep from the initial prompt is greater than the context length" 400s.
 * Prefer the smaller of the two (and fall back to whichever is known).
 */
function clampContextWindow(declared, loaded) {
  const d = Number(declared) || 0;
  const l = Number(loaded) || 0;
  if (d > 0 && l > 0) return Math.min(d, l);
  return l > 0 ? l : d;
}

/**
 * Read the actually-loaded context length for `model` from LM Studio's native REST
 * API (/api/v0/models exposes `loaded_context_length`). Returns null when it can't
 * be determined (old LM Studio, model not loaded, endpoint unreachable) so callers
 * fall back to the operator setting. Short timeout so a run never hangs on it.
 */
async function fetchLmstudioLoadedContext(host, model) {
  const url = `${String(host || '').replace(/\/$/, '')}/api/v0/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    const models = (body && (body.data || body.models)) || [];
    const found = Array.isArray(models) ? models.find((m) => m && m.id === model) : null;
    const n = found && Number(found.loaded_context_length);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function systemToDeveloper(messages) {
  const { ChatMessage } = require('@langchain/core/messages');
  return messages.map((m) =>
    m && typeof m._getType === 'function' && m._getType() === 'system' ? new ChatMessage({ content: m.content, role: 'developer' }) : m
  );
}

// Lazily built (and cached) so the heavy @langchain/openai import stays off the
// Ollama path. Extends the shared context-managed base (prompt budget + stream
// retry) and additionally rewrites system→developer messages, which the ChatGPT
// Codex backend requires. `_prepareMessages` composes the base's budget step with
// that rewrite; `_buildSummarizer` reuses THIS authenticated Codex model (with the
// budget disabled to avoid recursion) so 'summarize' mode works on the backend.
let CodexChatModelClass = null;
function getCodexChatModelClass() {
  if (CodexChatModelClass) return CodexChatModelClass;
  const Base = getManagedChatOpenAIClass();
  CodexChatModelClass = class CodexChatModel extends Base {
    async _prepareMessages(messages) {
      return systemToDeveloper(await super._prepareMessages(messages));
    }
    _buildSummarizer() {
      // A second Codex model carrying the same auth/headers, with context
      // management + retry disabled so the summarize call never re-enters budgeting.
      return new this.constructor({ ...this.fields, promptBudget: 0, contextMode: 'none', streamRetries: 0 });
    }
  };
  return CodexChatModelClass;
}

/**
 * Build a ChatOpenAI targeting the ChatGPT-plan Codex backend (Responses API).
 *
 * The backend's contract differs from the metered Chat Completions API and is
 * enforced strictly (see server/config.js OAUTH.backend):
 *   - Responses API (`useResponsesApi`), and `stream` MUST be true → `streaming`.
 *   - `store` must be false → `zdrEnabled` (Zero Data Retention flag).
 *   - `max_output_tokens` is rejected → `maxTokens: -1` omits it.
 *   - `temperature` is rejected by gpt-5.5 → not set.
 *   - JSON mode uses `text.format` (Responses), NOT `response_format`.
 *   - `role:"system"` input items are rejected → see getCodexChatModelClass.
 *   - Auth: Bearer access token + a `chatgpt-account-id` header from the id_token.
 */
function createCodexChatgptModel(llm, json) {
  const CodexChatModel = getCodexChatModelClass();
  const opts = {
    model: llm.model,
    apiKey: llm.accessToken,
    useResponsesApi: true,
    streaming: true,
    zdrEnabled: true,
    maxTokens: -1,
    configuration: {
      baseURL: llm.baseUrl,
      defaultHeaders: {
        'chatgpt-account-id': llm.accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        session_id: crypto.randomUUID(),
      },
    },
    // Bound the growing deep-agent history to fit the Codex context window (only
    // acts when it overflows). Same strategy as LM Studio; 'trim' by default so
    // no extra hosted call is made unless the operator selects 'summarize'.
    promptBudget: codexPromptBudget(llm),
    charsPerToken: CONFIG.OAUTH.charsPerToken,
    contextMode: llm.contextMode,
    summaryMaxTokens: CONFIG.OAUTH.summaryMaxTokens,
    // Retry once (by default) on a Codex in-stream error — the failure that
    // surfaces as "An error occurred while processing your request" mid-generation.
    streamRetries: clampStreamRetries(llm.streamRetries),
    retryProvider: 'codex',
  };
  // `ultra` is advertised by the Codex subscription model catalog. It is not a
  // public Responses API effort, so it is accepted only on this ChatGPT path.
  if (llm.reasoningAdapter === 'openai' && ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(llm.reasoningEffort)) {
    opts.reasoning = { effort: llm.reasoningEffort };
  }
  if (json) opts.modelKwargs = { text: { format: { type: 'json_object' } } };
  return new CodexChatModel(opts);
}

/**
 * Prepend the Claude Code identity to the system prompt. Subscription OAuth
 * tokens require the request to present as Claude Code (the first system block),
 * or the API rejects the credential. Merges into an existing leading system
 * message (rather than adding a second) to keep a single `system` block, and is
 * idempotent so retries/loops don't stack the prefix.
 */
function withClaudeIdentity(messages, prefix) {
  if (!prefix) return messages;
  const { SystemMessage } = require('@langchain/core/messages');
  const first = messages[0];
  const isSystem = first && typeof first._getType === 'function' && first._getType() === 'system';
  if (!isSystem) return [new SystemMessage(prefix), ...messages];
  const content = first.content;
  if (typeof content === 'string') {
    if (content.startsWith(prefix)) return messages;
    return [new SystemMessage(`${prefix}\n\n${content}`), ...messages.slice(1)];
  }
  if (Array.isArray(content)) {
    if (content.some((c) => typeof c.text === 'string' && c.text.startsWith(prefix))) return messages;
    return [new SystemMessage({ content: [{ type: 'text', text: prefix }, ...content] }), ...messages.slice(1)];
  }
  return [new SystemMessage(prefix), ...messages];
}

// Lazily built + cached so @langchain/anthropic stays off the other providers'
// paths. Subclasses ChatAnthropic to inject the Claude Code identity system
// block on every request (base Runnable.withConfig wraps `this`, so the override
// survives bindTools — no withConfig override needed, unlike the Codex model).
let ClaudeChatModelClass = null;
function getClaudeChatModelClass() {
  if (ClaudeChatModelClass) return ClaudeChatModelClass;
  const { ChatAnthropic } = require('@langchain/anthropic');
  const prefix = CONFIG.CLAUDE.systemPrefix;
  ClaudeChatModelClass = class ClaudeChatModel extends ChatAnthropic {
    constructor(fields) {
      super(fields);
      this.streamRetries = clampStreamRetries(fields && fields.streamRetries);
    }
    async _generate(messages, options, runManager) {
      const prepared = withClaudeIdentity(messages, prefix);
      return runWithRetry(
        () => super._generate(prepared, options, runManager),
        this.streamRetries,
        streamRetryLogger('claude')
      );
    }
    async *_streamResponseChunks(messages, options, runManager) {
      const prepared = withClaudeIdentity(messages, prefix);
      yield* streamWithRetry(
        () => super._streamResponseChunks(prepared, options, runManager),
        this.streamRetries,
        streamRetryLogger('claude')
      );
    }
    async *_streamChatModelEvents(messages, options, runManager) {
      yield* super._streamChatModelEvents(withClaudeIdentity(messages, prefix), options, runManager);
    }
  };
  return ClaudeChatModelClass;
}

/**
 * Build a ChatAnthropic authenticated with a Claude OAuth (subscription) token.
 *   - Auth: `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`
 *     (NOT `x-api-key`). A custom `createClient` supplies this and lets us omit
 *     the API key entirely.
 *   - `temperature` is left unset (Opus 4.8 rejects sampling params).
 *   - JSON mode: Anthropic has no `json_object` format; the enrichment prompts
 *     already say "return ONLY JSON" and plan.js parseJsonLoose tolerates fences,
 *     so `json` is prompt-driven here (no request param).
 */
function createClaudeModel(llm /* , json */) {
  const ClaudeChatModel = getClaudeChatModelClass();
  const { Anthropic } = require('@anthropic-ai/sdk');
  const baseURL = String(llm.baseUrl || CONFIG.CLAUDE.baseUrl).replace(/\/$/, '');
  const betaHeader = CONFIG.CLAUDE.betaHeader;
  const opts = {
    model: llm.model,
    maxTokens: llm.numTokens,
    streamRetries: clampStreamRetries(llm.streamRetries),
    // Stream responses (settings-configurable, `claudeStreaming`, default on). A
    // large maxTokens (up to 128000) makes a NON-streaming request one the
    // Anthropic SDK rejects outright — "Streaming is required for operations that
    // may take longer than 10 minutes" — because it estimates the request could
    // exceed the 10-minute non-streaming ceiling. Streaming routes through the
    // SDK's .stream() (headers/tokens arrive incrementally), so the guard never
    // fires. LangChain aggregates the chunks, so .invoke() callers (the deep-agent
    // loop) are unaffected. Mirrors the lmstudio/omlx paths. Only an explicit
    // `false` disables it — turning it off re-breaks large max output.
    streaming: llm.streaming !== false,
    // No apiKey — createClient supplies OAuth Bearer auth, so x-api-key is never sent.
    createClient: (options) =>
      new Anthropic({
        ...options,
        apiKey: null,
        authToken: llm.accessToken,
        baseURL,
        defaultHeaders: { ...(options.defaultHeaders || {}), 'anthropic-beta': betaHeader },
      }),
  };
  // Opus 4.8 supports adaptive thinking only; fixed budget_tokens and sampling
  // parameters are rejected. Effort is the supported depth control.
  if (llm.reasoningAdapter === 'anthropic-adaptive' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(llm.reasoningEffort)) {
    opts.thinking = { type: 'adaptive' };
    opts.outputConfig = { effort: llm.reasoningEffort };
  } else if (llm.reasoningAdapter === 'anthropic-effort' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(llm.reasoningEffort)) {
    // Older effort-capable Claude models may not support adaptive thinking.
    // Effort still controls the response without inventing an unsupported
    // `thinking.type` request field.
    opts.outputConfig = { effort: llm.reasoningEffort };
  }
  return new ClaudeChatModel(opts);
}

// Lazily built + cached so @langchain/openai stays off the Ollama/Claude paths.
// Subclasses ChatOpenAI to (a) bound the (unbounded, re-sent-every-turn) deep-agent
// history to `promptBudget` tokens before each call — via the configured strategy
// (trim | summarize | none) and ONLY when the prompt actually exceeds the budget —
// and (b) retry a transient/in-stream error `streamRetries` times. Shared by the
// LM Studio, oMLX, Codex, and Hugging Face paths (Codex subclasses it to add its
// system→developer rewrite). Overrides withConfig, which otherwise rebuilds a base
// ChatOpenAI (bindTools wraps `this`) and would drop these behaviors.
let ManagedChatOpenAIClass = null;
function getManagedChatOpenAIClass() {
  if (ManagedChatOpenAIClass) return ManagedChatOpenAIClass;
  const { ChatOpenAI } = require('@langchain/openai');
  ManagedChatOpenAIClass = class ContextManagedChatOpenAI extends ChatOpenAI {
    constructor(fields) {
      super(fields);
      // 0/undefined budget → context management disabled (pass-through).
      this.promptBudget = Number(fields && fields.promptBudget) || 0;
      this.charsPerToken = Number(fields && fields.charsPerToken) || CONFIG.LMSTUDIO.charsPerToken;
      this.contextMode = (fields && fields.contextMode) || 'trim';
      this.summaryMaxTokens = Number(fields && fields.summaryMaxTokens) || CONFIG.LMSTUDIO.summaryMaxTokens;
      this.streamRetries = clampStreamRetries(fields && fields.streamRetries);
      this.retryProvider = (fields && fields.retryProvider) || 'openai';
      // Captured for the (separate, tool-free) summarizer sub-model.
      this._summaryCfg = {
        model: fields && fields.model,
        apiKey: fields && fields.apiKey,
        baseURL: fields && fields.configuration && fields.configuration.baseURL,
        timeout: fields && fields.timeout,
        maxRetries: fields && fields.maxRetries,
      };
      this._summaryModel = null;
    }
    // A plain ChatOpenAI (no tools, small output) reused for summarization calls, so
    // they never re-enter _prepareMessages and never carry the agent's bound tools.
    // Overridable — the Codex backend needs its own (authenticated) summarizer.
    _buildSummarizer() {
      return new ChatOpenAI({
        model: this._summaryCfg.model,
        apiKey: this._summaryCfg.apiKey || 'local-openai-compatible',
        temperature: 0,
        maxTokens: this.summaryMaxTokens,
        timeout: this._summaryCfg.timeout,
        maxRetries: this._summaryCfg.maxRetries,
        configuration: { baseURL: this._summaryCfg.baseURL },
      });
    }
    _summarizer() {
      if (!this._summaryModel) this._summaryModel = this._buildSummarizer();
      return this._summaryModel;
    }
    _summarize(text) {
      const { SystemMessage, HumanMessage } = require('@langchain/core/messages');
      return this._summarizer()
        .invoke([new SystemMessage(SUMMARY_SYSTEM_PROMPT), new HumanMessage(text)])
        .then((res) => contentToText(res && res.content));
    }
    _prepareMessages(messages) {
      return prepareMessages({
        messages,
        mode: this.contextMode,
        budget: this.promptBudget,
        charsPerToken: this.charsPerToken,
        summaryMaxTokens: this.summaryMaxTokens,
        summarize: (text) => this._summarize(text),
      });
    }
    async _generate(messages, options, runManager) {
      const prepared = await this._prepareMessages(messages);
      return runWithRetry(
        () => super._generate(prepared, options, runManager),
        this.streamRetries,
        streamRetryLogger(this.retryProvider)
      );
    }
    async *_streamResponseChunks(messages, options, runManager) {
      const prepared = await this._prepareMessages(messages);
      yield* streamWithRetry(
        () => super._streamResponseChunks(prepared, options, runManager),
        this.streamRetries,
        streamRetryLogger(this.retryProvider)
      );
    }
    async *_streamChatModelEvents(messages, options, runManager) {
      yield* super._streamChatModelEvents(await this._prepareMessages(messages), options, runManager);
    }
    withConfig(config) {
      const next = new this.constructor({
        ...this.fields,
        promptBudget: this.promptBudget,
        charsPerToken: this.charsPerToken,
        contextMode: this.contextMode,
        summaryMaxTokens: this.summaryMaxTokens,
        streamRetries: this.streamRetries,
        retryProvider: this.retryProvider,
      });
      next.defaultOptions = { ...this.defaultOptions, ...config };
      return next;
    }
  };
  return ManagedChatOpenAIClass;
}

// Lazily built + cached so @langchain/ollama stays off the other providers' paths.
// Subclasses ChatOllama to add the same transient/in-stream retry as the hosted
// providers. No withConfig override is needed: base Runnable.withConfig wraps
// `this` (as for ChatAnthropic), so the overridden methods survive bindTools.
let OllamaChatModelClass = null;
function getOllamaChatModelClass() {
  if (OllamaChatModelClass) return OllamaChatModelClass;
  const { ChatOllama } = require('@langchain/ollama');
  OllamaChatModelClass = class RetryingChatOllama extends ChatOllama {
    constructor(fields) {
      super(fields);
      this.streamRetries = clampStreamRetries(fields && fields.streamRetries);
    }
    // ChatOllama._generate aggregates by iterating THIS._streamResponseChunks, so
    // wrapping only the stream covers both .invoke() and .stream() with a single
    // retry layer (wrapping _generate too would nest retries).
    async *_streamResponseChunks(messages, options, runManager) {
      yield* streamWithRetry(
        () => super._streamResponseChunks(messages, options, runManager),
        this.streamRetries,
        streamRetryLogger('ollama')
      );
    }
  };
  return OllamaChatModelClass;
}

/** Build a LangChain chat model for the given provider descriptor. */
function createChatModel(llm, { json = false } = {}) {
  if (llm.provider === 'claude') {
    return createClaudeModel(llm, json);
  }
  if (llm.provider === 'codex') {
    if (llm.backend === 'chatgpt') return createCodexChatgptModel(llm, json);
    // Metered OpenAI Chat Completions API (requires funded API credits). Routed
    // through the shared managed base so it gets the same prompt budget + stream
    // retry as the ChatGPT backend (the standard API accepts role:"system", so no
    // developer rewrite is needed here).
    const ManagedChatOpenAI = getManagedChatOpenAIClass();
    const opts = {
      model: llm.model,
      apiKey: llm.accessToken,
      maxTokens: llm.numTokens,
      configuration: { baseURL: llm.baseUrl },
      promptBudget: codexPromptBudget(llm),
      charsPerToken: CONFIG.OAUTH.charsPerToken,
      contextMode: llm.contextMode,
      summaryMaxTokens: CONFIG.OAUTH.summaryMaxTokens,
      streamRetries: clampStreamRetries(llm.streamRetries),
      retryProvider: 'codex',
    };
    if (llm.reasoningAdapter === 'openai' && ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(llm.reasoningEffort)) {
      opts.reasoning = { effort: llm.reasoningEffort };
    }
    // Current reasoning models reject sampling controls. A custom non-reasoning
    // model can still opt into a numeric temperature by setting effort to none.
    if ((llm.reasoningAdapter !== 'openai' || llm.reasoningEffort === 'none') && typeof llm.temperature === 'number' && Number.isFinite(llm.temperature)) {
      opts.temperature = llm.temperature;
    }
    // Constrained JSON output (equivalent to Ollama's format:'json').
    if (json) opts.modelKwargs = { response_format: { type: 'json_object' } };
    return new ManagedChatOpenAI(opts);
  }
  if (llm.provider === 'huggingface') {
    // Hugging Face's router is OpenAI-compatible, so the shared managed base targets
    // it with a Bearer HF token (context budget stays off — no window is declared —
    // but the stream retry applies). Streamed so a large max output never trips the
    // SDK's 10-minute non-streaming ceiling (LangChain re-aggregates for .invoke()).
    const ManagedChatOpenAI = getManagedChatOpenAIClass();
    const opts = {
      model: llm.model,
      apiKey: llm.apiKey,
      maxTokens: llm.numTokens,
      streaming: true,
      configuration: { baseURL: llm.baseUrl },
      streamRetries: clampStreamRetries(llm.streamRetries),
      retryProvider: 'huggingface',
    };
    if (llm.reasoningAdapter === 'openai' && ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(llm.reasoningEffort)) {
      opts.reasoning = { effort: llm.reasoningEffort };
    }
    if ((llm.reasoningAdapter !== 'openai' || llm.reasoningEffort === 'none') && typeof llm.temperature === 'number' && Number.isFinite(llm.temperature)) {
      opts.temperature = llm.temperature;
    }
    if (json) opts.modelKwargs = { response_format: { type: 'json_object' } };
    return new ManagedChatOpenAI(opts);
  }
  if (llm.provider === 'lmstudio') {
    // LM Studio serves an OpenAI-compatible API, so ChatOpenAI targets it directly.
    // No real key is needed (LM Studio ignores it), but the SDK requires a non-empty
    // apiKey, so we pass a placeholder. Context length is fixed when the model is
    // loaded in LM Studio and cannot be set per-request, so we cap the OUTPUT budget
    // (max_tokens) to fit the operator-declared context window, reserving room for
    // the (large) deep-agent prompt. Without this, sending max_tokens > n_ctx (e.g.
    // 16000 in an 8192 window) yields LM Studio 400s like "n_keep >= n_ctx".
    const LmStudioChatModel = getManagedChatOpenAIClass();
    const opts = {
      model: llm.model,
      apiKey: 'lm-studio',
      maxTokens: lmstudioMaxTokens(llm),
      streamRetries: clampStreamRetries(llm.streamRetries),
      retryProvider: 'lmstudio',
      // Stream responses. A slow local model can take minutes per turn; a
      // NON-streaming request holds the socket until the whole answer is ready, so
      // Node's undici HTTP client aborts it at its default 5-min headers timeout
      // (which the SDK's `timeout` below does NOT override) — killing a generation
      // that is actually still progressing. Streaming sends headers immediately and
      // tokens incrementally, so the 5-min cutoff never fires on a live generation.
      streaming: true,
      // Slow local reasoning models can exceed the OpenAI SDK's 10-min default per
      // turn; use a generous, env-configurable timeout and few retries so a genuine
      // timeout fails once instead of being retried into a much longer wait.
      timeout: CONFIG.LMSTUDIO.requestTimeoutMs,
      maxRetries: CONFIG.LMSTUDIO.maxRetries,
      configuration: { baseURL: llm.baseUrl },
      // Bound the growing deep-agent history to fit the loaded context window, so a
      // long run can't overflow it (the max_tokens cap only bounds OUTPUT, not the
      // re-sent input). `contextMode` picks the strategy (trim | summarize | none);
      // `promptBudget` is 0 when no context window is declared → management disabled.
      promptBudget: lmstudioPromptBudget(llm),
      contextMode: llm.contextMode,
      summaryMaxTokens: CONFIG.LMSTUDIO.summaryMaxTokens,
    };
    if (typeof llm.temperature === 'number' && Number.isFinite(llm.temperature)) {
      opts.temperature = llm.temperature;
    }
    if (typeof llm.topP === 'number' && Number.isFinite(llm.topP)) opts.topP = llm.topP;
    const modelKwargs = {};
    if (typeof llm.topK === 'number' && Number.isFinite(llm.topK)) modelKwargs.top_k = llm.topK;
    if (typeof llm.repeatPenalty === 'number' && Number.isFinite(llm.repeatPenalty)) {
      modelKwargs.repeat_penalty = llm.repeatPenalty;
    }
    if (llm.reasoningAdapter === 'openai-compatible' && ['low', 'medium', 'high'].includes(llm.reasoningEffort)) {
      modelKwargs.reasoning_effort = llm.reasoningEffort;
    }
    // Constrained JSON output — the accepted format varies by model/engine, so the
    // mode is operator-selectable ('text' sends nothing and relies on the prompt).
    if (json) {
      const kwargs = lmstudioJsonKwargs(llm.jsonMode);
      if (kwargs) Object.assign(modelKwargs, kwargs);
    }
    if (Object.keys(modelKwargs).length) opts.modelKwargs = modelKwargs;
    return new LmStudioChatModel(opts);
  }
  if (llm.provider === 'omlx') {
    const OmlxChatModel = getManagedChatOpenAIClass();
    const opts = {
      model: llm.model,
      apiKey: llm.apiKey || 'omlx-local',
      maxTokens: omlxMaxTokens(llm),
      streaming: true,
      timeout: CONFIG.OMLX.requestTimeoutMs,
      maxRetries: CONFIG.OMLX.maxRetries,
      configuration: { baseURL: llm.baseUrl },
      promptBudget: omlxPromptBudget(llm),
      charsPerToken: CONFIG.OMLX.charsPerToken,
      contextMode: llm.contextMode,
      summaryMaxTokens: CONFIG.OMLX.summaryMaxTokens,
      streamRetries: clampStreamRetries(llm.streamRetries),
      retryProvider: 'omlx',
    };
    if (typeof llm.temperature === 'number' && Number.isFinite(llm.temperature)) {
      opts.temperature = llm.temperature;
    }
    if (typeof llm.topP === 'number' && Number.isFinite(llm.topP)) opts.topP = llm.topP;
    const modelKwargs = {};
    if (typeof llm.topK === 'number' && Number.isFinite(llm.topK)) modelKwargs.top_k = llm.topK;
    if (typeof llm.repeatPenalty === 'number' && Number.isFinite(llm.repeatPenalty)) {
      // oMLX names this field differently from LM Studio.
      modelKwargs.repetition_penalty = llm.repeatPenalty;
    }
    if (llm.reasoningAdapter === 'omlx-template-effort' && ['low', 'medium', 'high'].includes(llm.reasoningEffort)) {
      modelKwargs.chat_template_kwargs = { reasoning_effort: llm.reasoningEffort };
    }
    if (json) {
      const kwargs = lmstudioJsonKwargs(llm.jsonMode);
      if (kwargs) Object.assign(modelKwargs, kwargs);
    }
    if (Object.keys(modelKwargs).length) opts.modelKwargs = modelKwargs;
    return new OmlxChatModel(opts);
  }
  if (llm.provider !== 'ollama') {
    throw new TypeError(`Unsupported LLM provider: ${llm.provider || 'unknown'}`);
  }
  // Local Ollama.
  const OllamaChatModel = getOllamaChatModelClass();
  const opts = {
    baseUrl: llm.host,
    model: llm.model,
    numCtx: llm.contextWindow,
    numPredict: llm.numTokens,
    streamRetries: clampStreamRetries(llm.streamRetries),
  };
  if (typeof llm.temperature === 'number' && Number.isFinite(llm.temperature)) {
    opts.temperature = llm.temperature;
  }
  if (typeof llm.topP === 'number' && Number.isFinite(llm.topP)) opts.topP = llm.topP;
  if (typeof llm.topK === 'number' && Number.isFinite(llm.topK)) opts.topK = llm.topK;
  if (typeof llm.repeatPenalty === 'number' && Number.isFinite(llm.repeatPenalty)) {
    opts.repeatPenalty = llm.repeatPenalty;
  }
  if (llm.reasoningAdapter === 'ollama-think-effort' && ['low', 'medium', 'high'].includes(llm.reasoningEffort)) {
    opts.think = llm.reasoningEffort;
  } else if (llm.reasoningAdapter === 'ollama-think-toggle') {
    opts.think = llm.reasoningEffort !== 'none';
  }
  // 'json' uses Ollama's native constrained mode; 'text' relies on the prompt.
  if (json && llm.jsonMode !== 'text') opts.format = 'json';
  return new OllamaChatModel(opts);
}

/**
 * Return a valid Codex token set, refreshing (and persisting rotation) when the
 * access token is missing or near expiry. Throws (401) when no usable token
 * exists so the caller can prompt the operator to sign in again.
 */
async function ensureFreshCodexTokens() {
  const tokens = store.getCodexTokens();
  if (!tokens || (!tokens.accessToken && !tokens.refreshToken)) {
    const err = new Error('Sign in with Codex (OpenAI) in Settings → LLM.');
    err.status = 401;
    throw err;
  }
  if (!oauth.isExpired(tokens)) return tokens;
  const refreshed = await oauth.refreshTokens(tokens);
  store.setCodexTokens(refreshed);
  return refreshed;
}

/**
 * Return a valid Claude token set, refreshing (and persisting rotation) when the
 * access token is missing or near expiry. Throws (401) when no usable token
 * exists so the caller can prompt the operator to sign in again.
 */
async function ensureFreshClaudeTokens() {
  const tokens = store.getClaudeTokens();
  if (!tokens || (!tokens.accessToken && !tokens.refreshToken)) {
    const err = new Error('Sign in with Claude in Settings → LLM.');
    err.status = 401;
    throw err;
  }
  if (!claudeOauth.isExpired(tokens)) return tokens;
  const refreshed = await claudeOauth.refreshTokens(tokens);
  store.setClaudeTokens(refreshed);
  return refreshed;
}

/**
 * Which provider name backs a given deep-agent role. Two kinds of roles exist:
 *   Deployment slots (legacy, deployment-pinned):
 *     'global' (default) — hosted slot (settings.llmProvider),
 *     'local'            — local slot (settings.localLlmProvider); used by
 *                          localization / local-intelligence. Falls back to the
 *                          global slot when unset.
 *   Purpose roles (provider-flexible; see MODEL_ROLES):
 *     'thinking'  — planner model (settings.thinkingLlmProvider),
 *     'execution' — coder model (settings.executionLlmProvider),
 *     'testing'   — tool-calling model (settings.testingLlmProvider; reserved).
 * A purpose role falls back to the hosted slot when unset (matching how new
 * roles are seeded from the hosted slot on migration).
 */
const ROLE_PROVIDER_KEYS = Object.freeze({
  global: 'llmProvider',
  local: 'localLlmProvider',
  thinking: 'thinkingLlmProvider',
  execution: 'executionLlmProvider',
  testing: 'testingLlmProvider',
});

function providerForRole(settings, role) {
  if (role === 'local') return settings.localLlmProvider || settings.llmProvider || 'ollama';
  const key = ROLE_PROVIDER_KEYS[role] || 'llmProvider';
  return settings[key] || settings.llmProvider || 'ollama';
}

/**
 * Resolve a provider descriptor from settings for the given role ('global' by
 * default, or 'local'). For 'codex'/'claude' this refreshes the access token if
 * needed (async, may hit the token endpoint). The per-provider config (model,
 * host, tokens) is shared across roles; only WHICH provider differs by role.
 */
async function resolveLlm(settings, role = 'global') {
  const provider = providerForRole(settings, role);
  // Transient/in-stream retry count is a single knob applied to every provider.
  const streamRetries = clampStreamRetries(settings.llmStreamRetries);
  if (provider === 'claude') {
    const tokens = await ensureFreshClaudeTokens();
    return {
      provider: 'claude',
      model: settings.claudeModel || CONFIG.CLAUDE.defaultModel,
      baseUrl: CONFIG.CLAUDE.baseUrl,
      accessToken: tokens.accessToken,
      numTokens: settings.claudeMaxTokens || 65536,
      temperature: settings.claudeTemperature ?? null,
      reasoningEffort: settings.claudeReasoningEffort ?? null,
      reasoningAdapter: settings.claudeReasoningAdapter || 'none',
      streaming: settings.claudeStreaming !== false,
      streamRetries,
    };
  }
  if (provider === 'codex') {
    const tokens = await ensureFreshCodexTokens();
    if (CONFIG.OAUTH.backend === 'chatgpt') {
      const accountId = oauth.accountIdFromIdToken(tokens.idToken);
      if (!accountId) {
        const err = new Error('Codex ChatGPT backend needs an account id from your sign-in; sign in with Codex again.');
        err.status = 401;
        throw err;
      }
      return {
        provider: 'codex',
        backend: 'chatgpt',
        model: settings.codexModel || CONFIG.OAUTH.chatgptModel,
        baseUrl: CONFIG.OAUTH.chatgptBaseUrl,
        accessToken: tokens.accessToken,
        // The official Codex SDK consumes ChatGPT-managed credentials from
        // auth.json, not through its `apiKey` option. Keep this internal token
        // bundle on the per-run descriptor so the runtime can materialize an
        // isolated auth cache without re-reading stale store state.
        authTokens: { ...tokens },
        accountId,
        numTokens: settings.codexMaxTokens || 65536,
        contextWindow: Number(settings.codexContextWindow) || 0,
        contextMode: settings.codexContextMode || 'trim',
        temperature: settings.codexTemperature ?? null,
        reasoningEffort: settings.codexReasoningEffort ?? null,
        reasoningAdapter: settings.codexReasoningAdapter || 'none',
        streamRetries,
      };
    }
    return {
      provider: 'codex',
      backend: 'api',
      model: settings.codexModel || CONFIG.OAUTH.defaultModel,
      baseUrl: CONFIG.OAUTH.baseUrl,
      accessToken: tokens.accessToken,
      authTokens: { ...tokens },
      numTokens: settings.codexMaxTokens || 65536,
      contextWindow: Number(settings.codexContextWindow) || 0,
      contextMode: settings.codexContextMode || 'trim',
      temperature: settings.codexTemperature ?? null,
      reasoningEffort: settings.codexReasoningEffort ?? null,
      reasoningAdapter: settings.codexReasoningAdapter || 'none',
      streamRetries,
    };
  }
  if (provider === 'lmstudio') {
    const host = String(settings.lmstudioHost || CONFIG.LMSTUDIO.defaultHost).replace(/\/$/, '');
    // Key the prompt budget to the window the model is ACTUALLY loaded with (LM
    // Studio may load it smaller than configured), not just the operator setting.
    const declaredCtx = Number(settings.lmstudioContextWindow) || 0;
    const loadedCtx = await fetchLmstudioLoadedContext(host, settings.lmstudioModel);
    const contextWindow = clampContextWindow(declaredCtx, loadedCtx);
    warnContextMismatch(settings.lmstudioModel, loadedCtx, declaredCtx);
    return {
      provider: 'lmstudio',
      host,
      // OpenAI-compatible endpoint the ChatOpenAI client targets.
      baseUrl: `${host}${CONFIG.LMSTUDIO.apiPath}`,
      model: settings.lmstudioModel,
      contextWindow,
      numTokens: settings.lmstudioNumTokens,
      temperature: settings.lmstudioTemperature ?? null,
      topP: settings.lmstudioTopP ?? null,
      topK: settings.lmstudioTopK ?? null,
      repeatPenalty: settings.lmstudioRepeatPenalty ?? null,
      reasoningEffort: settings.lmstudioReasoningEffort || 'none',
      reasoningAdapter: settings.lmstudioReasoningAdapter || 'none',
      jsonMode: settings.lmstudioJsonMode || 'text',
      // How to keep the prompt within the loaded window: trim | summarize | none.
      contextMode: settings.lmstudioContextMode || 'summarize',
      streamRetries,
    };
  }
  if (provider === 'omlx') {
    const host = String(settings.omlxHost || CONFIG.OMLX.defaultHost)
      .replace(/\/v1\/?$/i, '')
      .replace(/\/$/, '');
    return {
      provider: 'omlx',
      host,
      baseUrl: `${host}${CONFIG.OMLX.apiPath}`,
      apiKey: settings.omlxApiKey || '',
      model: settings.omlxModel,
      contextWindow: settings.omlxContextWindow,
      numTokens: settings.omlxNumTokens,
      temperature: settings.omlxTemperature ?? null,
      topP: settings.omlxTopP ?? null,
      topK: settings.omlxTopK ?? null,
      repeatPenalty: settings.omlxRepeatPenalty ?? null,
      reasoningEffort: settings.omlxReasoningEffort || 'none',
      reasoningAdapter: settings.omlxReasoningAdapter || 'none',
      jsonMode: settings.omlxJsonMode || 'text',
      contextMode: settings.omlxContextMode || 'summarize',
      streamRetries,
    };
  }
  if (provider === 'huggingface') {
    const host = String(settings.huggingfaceHost || CONFIG.HUGGINGFACE.defaultHost)
      .replace(/\/v1\/?$/i, '')
      .replace(/\/$/, '');
    return {
      provider: 'huggingface',
      host,
      baseUrl: `${host}${CONFIG.HUGGINGFACE.apiPath}`,
      apiKey: settings.huggingfaceApiKey || '',
      model: settings.huggingfaceModel,
      contextWindow: settings.huggingfaceContextWindow,
      numTokens: settings.huggingfaceMaxTokens || 8192,
      temperature: settings.huggingfaceTemperature ?? null,
      reasoningEffort: settings.huggingfaceReasoningEffort || 'none',
      reasoningAdapter: settings.huggingfaceReasoningAdapter || 'none',
      streamRetries,
    };
  }
  if (provider !== 'ollama') throw new TypeError(`Unsupported LLM provider: ${provider || 'unknown'}`);
  return {
    provider: 'ollama',
    host: settings.ollamaHost,
    model: settings.ollamaModel,
    contextWindow: settings.ollamaContextWindow,
    numTokens: settings.ollamaNumTokens,
    temperature: settings.ollamaTemperature ?? null,
    topP: settings.ollamaTopP ?? null,
    topK: settings.ollamaTopK ?? null,
    repeatPenalty: settings.ollamaRepeatPenalty ?? null,
    reasoningEffort: settings.ollamaReasoningEffort || 'none',
    reasoningAdapter: settings.ollamaReasoningAdapter || 'none',
    jsonMode: settings.ollamaJsonMode || 'json',
    streamRetries,
  };
}

/**
 * Cheap readiness check (no network) for status endpoints and scheduler gating.
 * `role` selects which slot's provider to check (defaults to the hosted/global
 * slot); the planner passes 'thinking'. Provider-specific fields are shared per
 * provider, so the resolved provider name is sufficient.
 */
function llmReady(settings, role = 'global') {
  const provider = providerForRole(settings, role);
  if (provider === 'claude') {
    const t = settings.claudeTokens;
    const hasToken = Boolean(t && (t.accessToken || t.refreshToken));
    const hasModel = Boolean(settings.claudeModel || CONFIG.CLAUDE.defaultModel);
    return hasToken && hasModel;
  }
  if (provider === 'codex') {
    const t = settings.codexTokens;
    const hasToken = Boolean(t && (t.accessToken || t.refreshToken));
    const hasModel = Boolean(settings.codexModel || CONFIG.OAUTH.defaultModel);
    return hasToken && hasModel;
  }
  if (provider === 'lmstudio') {
    return Boolean(settings.lmstudioHost && settings.lmstudioModel);
  }
  if (provider === 'omlx') {
    return Boolean(settings.omlxHost && settings.omlxModel);
  }
  if (provider === 'huggingface') {
    // The HF access token is mandatory (the router rejects unauthenticated calls).
    return Boolean(settings.huggingfaceApiKey && settings.huggingfaceModel);
  }
  return Boolean(settings.ollamaHost && settings.ollamaModel);
}

/** Human-readable "not ready" reason for the given role's provider. */
function notReadyReason(settings, role = 'global') {
  const provider = providerForRole(settings, role);
  if (provider === 'claude') {
    return 'Sign in with Claude in Settings → LLM to enable enrichment.';
  }
  if (provider === 'codex') {
    return 'Sign in with Codex (OpenAI) in Settings → LLM to enable enrichment.';
  }
  if (provider === 'lmstudio') {
    return 'Set the LM Studio host and model in Settings → LLM to enable enrichment.';
  }
  if (provider === 'omlx') {
    return 'Set the oMLX host and model in Settings → LLM to enable enrichment.';
  }
  if (provider === 'huggingface') {
    return 'Add your Hugging Face access token and model in Settings → LLM to enable enrichment.';
  }
  return 'Set the Ollama host and model in Settings → LLM to enable enrichment.';
}

module.exports = {
  createChatModel,
  ensureFreshCodexTokens,
  ensureFreshClaudeTokens,
  resolveLlm,
  providerForRole,
  llmReady,
  notReadyReason,
  lmstudioMaxTokens,
  lmstudioPromptBudget,
  omlxMaxTokens,
  omlxPromptBudget,
  codexMaxTokens,
  codexPromptBudget,
  clampStreamRetries,
  clampContextWindow,
  trimMessagesForBudget,
  estimateMessageTokens,
};
