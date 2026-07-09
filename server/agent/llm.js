'use strict';

const crypto = require('crypto');
const { CONFIG } = require('../config');
const store = require('../store');
const logger = require('../logger');
const oauth = require('./oauth');
const claudeOauth = require('./claude-oauth');

/**
 * Deep-agent LLM provider factory. Four providers are supported:
 *   - 'ollama'   — local inference (ChatOllama), no credentials.
 *   - 'lmstudio' — local inference via LM Studio's OpenAI-compatible API
 *                  (ChatOpenAI against http://localhost:1234/v1), no credentials.
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
// Ollama path. Subclasses ChatOpenAI to (a) rewrite system→developer messages and
// (b) preserve itself through `withConfig`/`bindTools`, which otherwise rebuild a
// base ChatOpenAI and would drop the message rewrite.
let CodexChatModelClass = null;
function getCodexChatModelClass() {
  if (CodexChatModelClass) return CodexChatModelClass;
  const { ChatOpenAI } = require('@langchain/openai');
  CodexChatModelClass = class CodexChatModel extends ChatOpenAI {
    async _generate(messages, options, runManager) {
      return super._generate(systemToDeveloper(messages), options, runManager);
    }
    async *_streamResponseChunks(messages, options, runManager) {
      yield* super._streamResponseChunks(systemToDeveloper(messages), options, runManager);
    }
    async *_streamChatModelEvents(messages, options, runManager) {
      yield* super._streamChatModelEvents(systemToDeveloper(messages), options, runManager);
    }
    withConfig(config) {
      const next = new CodexChatModel(this.fields);
      next.defaultOptions = { ...this.defaultOptions, ...config };
      return next;
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
  };
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
    async _generate(messages, options, runManager) {
      return super._generate(withClaudeIdentity(messages, prefix), options, runManager);
    }
    async *_streamResponseChunks(messages, options, runManager) {
      yield* super._streamResponseChunks(withClaudeIdentity(messages, prefix), options, runManager);
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
  return new ClaudeChatModel({
    model: llm.model,
    maxTokens: llm.numTokens,
    // No apiKey — createClient supplies OAuth Bearer auth, so x-api-key is never sent.
    createClient: (options) =>
      new Anthropic({
        ...options,
        apiKey: null,
        authToken: llm.accessToken,
        baseURL,
        defaultHeaders: { ...(options.defaultHeaders || {}), 'anthropic-beta': betaHeader },
      }),
  });
}

// Lazily built + cached so @langchain/openai stays off the Ollama/Claude paths.
// Subclasses ChatOpenAI to bound the (unbounded, re-sent-every-turn) deep-agent
// history to `promptBudget` tokens before each call — via the configured strategy
// (trim | summarize | none) and ONLY when the prompt actually exceeds the budget —
// so a long run can't overflow LM Studio's fixed context window. Mirrors the Codex
// wrapper's shape, including the withConfig override that otherwise rebuilds a base
// ChatOpenAI and would drop the behavior (bindTools wraps `this`, so no override).
let LmStudioChatModelClass = null;
function getLmStudioChatModelClass() {
  if (LmStudioChatModelClass) return LmStudioChatModelClass;
  const { ChatOpenAI } = require('@langchain/openai');
  LmStudioChatModelClass = class LmStudioChatModel extends ChatOpenAI {
    constructor(fields) {
      super(fields);
      // 0/undefined budget → context management disabled (pass-through).
      this.promptBudget = Number(fields && fields.promptBudget) || 0;
      this.charsPerToken = Number(fields && fields.charsPerToken) || CONFIG.LMSTUDIO.charsPerToken;
      this.contextMode = (fields && fields.contextMode) || 'trim';
      this.summaryMaxTokens = Number(fields && fields.summaryMaxTokens) || CONFIG.LMSTUDIO.summaryMaxTokens;
      // Captured for the (separate, tool-free) summarizer sub-model.
      this._summaryCfg = {
        model: fields && fields.model,
        baseURL: fields && fields.configuration && fields.configuration.baseURL,
        timeout: fields && fields.timeout,
        maxRetries: fields && fields.maxRetries,
      };
      this._summaryModel = null;
    }
    // A plain ChatOpenAI (no tools, small output) reused for summarization calls, so
    // they never re-enter _prepareMessages and never carry the agent's bound tools.
    _summarizer() {
      if (this._summaryModel) return this._summaryModel;
      this._summaryModel = new ChatOpenAI({
        model: this._summaryCfg.model,
        apiKey: 'lm-studio',
        temperature: 0,
        maxTokens: this.summaryMaxTokens,
        timeout: this._summaryCfg.timeout,
        maxRetries: this._summaryCfg.maxRetries,
        configuration: { baseURL: this._summaryCfg.baseURL },
      });
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
      return super._generate(await this._prepareMessages(messages), options, runManager);
    }
    async *_streamResponseChunks(messages, options, runManager) {
      yield* super._streamResponseChunks(await this._prepareMessages(messages), options, runManager);
    }
    async *_streamChatModelEvents(messages, options, runManager) {
      yield* super._streamChatModelEvents(await this._prepareMessages(messages), options, runManager);
    }
    withConfig(config) {
      const next = new LmStudioChatModel({
        ...this.fields,
        promptBudget: this.promptBudget,
        charsPerToken: this.charsPerToken,
        contextMode: this.contextMode,
        summaryMaxTokens: this.summaryMaxTokens,
      });
      next.defaultOptions = { ...this.defaultOptions, ...config };
      return next;
    }
  };
  return LmStudioChatModelClass;
}

/** Build a LangChain chat model for the given provider descriptor. */
function createChatModel(llm, { json = false } = {}) {
  if (llm.provider === 'claude') {
    return createClaudeModel(llm, json);
  }
  if (llm.provider === 'codex') {
    if (llm.backend === 'chatgpt') return createCodexChatgptModel(llm, json);
    // Metered OpenAI Chat Completions API (requires funded API credits).
    const { ChatOpenAI } = require('@langchain/openai');
    const opts = {
      model: llm.model,
      apiKey: llm.accessToken,
      temperature: 0,
      maxTokens: llm.numTokens,
      configuration: { baseURL: llm.baseUrl },
    };
    // Constrained JSON output (equivalent to Ollama's format:'json').
    if (json) opts.modelKwargs = { response_format: { type: 'json_object' } };
    return new ChatOpenAI(opts);
  }
  if (llm.provider === 'lmstudio') {
    // LM Studio serves an OpenAI-compatible API, so ChatOpenAI targets it directly.
    // No real key is needed (LM Studio ignores it), but the SDK requires a non-empty
    // apiKey, so we pass a placeholder. Context length is fixed when the model is
    // loaded in LM Studio and cannot be set per-request, so we cap the OUTPUT budget
    // (max_tokens) to fit the operator-declared context window, reserving room for
    // the (large) deep-agent prompt. Without this, sending max_tokens > n_ctx (e.g.
    // 16000 in an 8192 window) yields LM Studio 400s like "n_keep >= n_ctx".
    const LmStudioChatModel = getLmStudioChatModelClass();
    const opts = {
      model: llm.model,
      apiKey: 'lm-studio',
      temperature: 0,
      maxTokens: lmstudioMaxTokens(llm),
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
    // Constrained JSON output — the accepted format varies by model/engine, so the
    // mode is operator-selectable ('text' sends nothing and relies on the prompt).
    if (json) {
      const kwargs = lmstudioJsonKwargs(llm.jsonMode);
      if (kwargs) opts.modelKwargs = kwargs;
    }
    return new LmStudioChatModel(opts);
  }
  // Default: local Ollama.
  const { ChatOllama } = require('@langchain/ollama');
  const opts = {
    baseUrl: llm.host,
    model: llm.model,
    numCtx: llm.contextWindow,
    numPredict: llm.numTokens,
    temperature: 0,
  };
  // 'json' uses Ollama's native constrained mode; 'text' relies on the prompt.
  if (json && llm.jsonMode !== 'text') opts.format = 'json';
  return new ChatOllama(opts);
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
 * Which provider name backs a given deep-agent role:
 *   'global' (default) — the hosted slot (settings.llmProvider); used by the
 *     planner and by the coder for hosted/unlabeled issues.
 *   'local' — the local slot (settings.localLlmProvider); used by the coder for
 *     "local"-labeled (XS) issues. Falls back to the global slot when unset.
 */
function providerForRole(settings, role) {
  if (role === 'local') return settings.localLlmProvider || settings.llmProvider || 'ollama';
  return settings.llmProvider || 'ollama';
}

/**
 * Resolve a provider descriptor from settings for the given role ('global' by
 * default, or 'local'). For 'codex'/'claude' this refreshes the access token if
 * needed (async, may hit the token endpoint). The per-provider config (model,
 * host, tokens) is shared across roles; only WHICH provider differs by role.
 */
async function resolveLlm(settings, role = 'global') {
  const provider = providerForRole(settings, role);
  if (provider === 'claude') {
    const tokens = await ensureFreshClaudeTokens();
    return {
      provider: 'claude',
      model: settings.claudeModel || CONFIG.CLAUDE.defaultModel,
      baseUrl: CONFIG.CLAUDE.baseUrl,
      accessToken: tokens.accessToken,
      numTokens: settings.claudeMaxTokens || 16000,
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
        accountId,
        numTokens: settings.codexMaxTokens || 4096,
      };
    }
    return {
      provider: 'codex',
      backend: 'api',
      model: settings.codexModel || CONFIG.OAUTH.defaultModel,
      baseUrl: CONFIG.OAUTH.baseUrl,
      accessToken: tokens.accessToken,
      numTokens: settings.codexMaxTokens || 4096,
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
      jsonMode: settings.lmstudioJsonMode || 'text',
      // How to keep the prompt within the loaded window: trim | summarize | none.
      contextMode: settings.lmstudioContextMode || 'summarize',
    };
  }
  return {
    provider: 'ollama',
    host: settings.ollamaHost,
    model: settings.ollamaModel,
    contextWindow: settings.ollamaContextWindow,
    numTokens: settings.ollamaNumTokens,
    jsonMode: settings.ollamaJsonMode || 'json',
  };
}

/** Cheap readiness check (no network) for status endpoints and scheduler gating. */
function llmReady(settings) {
  if (settings.llmProvider === 'claude') {
    const t = settings.claudeTokens;
    const hasToken = Boolean(t && (t.accessToken || t.refreshToken));
    const hasModel = Boolean(settings.claudeModel || CONFIG.CLAUDE.defaultModel);
    return hasToken && hasModel;
  }
  if (settings.llmProvider === 'codex') {
    const t = settings.codexTokens;
    const hasToken = Boolean(t && (t.accessToken || t.refreshToken));
    const hasModel = Boolean(settings.codexModel || CONFIG.OAUTH.defaultModel);
    return hasToken && hasModel;
  }
  if (settings.llmProvider === 'lmstudio') {
    return Boolean(settings.lmstudioHost && settings.lmstudioModel);
  }
  return Boolean(settings.ollamaHost && settings.ollamaModel);
}

/** Human-readable "not ready" reason for the active provider. */
function notReadyReason(settings) {
  if (settings.llmProvider === 'claude') {
    return 'Sign in with Claude in Settings → LLM to enable enrichment.';
  }
  if (settings.llmProvider === 'codex') {
    return 'Sign in with Codex (OpenAI) in Settings → LLM to enable enrichment.';
  }
  if (settings.llmProvider === 'lmstudio') {
    return 'Set the LM Studio host and model in Settings → LLM to enable enrichment.';
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
  clampContextWindow,
  trimMessagesForBudget,
  estimateMessageTokens,
};
