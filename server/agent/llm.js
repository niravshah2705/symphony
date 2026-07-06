'use strict';

const crypto = require('crypto');
const { CONFIG } = require('../config');
const store = require('../store');
const oauth = require('./oauth');
const claudeOauth = require('./claude-oauth');

/**
 * Deep-agent LLM provider factory. Three providers are supported:
 *   - 'ollama'  — local inference (ChatOllama), no credentials.
 *   - 'codex'   — OpenAI via OAuth (ChatOpenAI) with a Bearer access token.
 *   - 'claude'  — Anthropic via OAuth (ChatAnthropic) with a Bearer access token.
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
  // Default: local Ollama.
  const { ChatOllama } = require('@langchain/ollama');
  const opts = {
    baseUrl: llm.host,
    model: llm.model,
    numCtx: llm.contextWindow,
    numPredict: llm.numTokens,
    temperature: 0,
  };
  if (json) opts.format = 'json';
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
 * Resolve the active provider's descriptor from settings. For 'codex'/'claude'
 * this refreshes the access token if needed (async, may hit the token endpoint).
 */
async function resolveLlm(settings) {
  if (settings.llmProvider === 'claude') {
    const tokens = await ensureFreshClaudeTokens();
    return {
      provider: 'claude',
      model: settings.claudeModel || CONFIG.CLAUDE.defaultModel,
      baseUrl: CONFIG.CLAUDE.baseUrl,
      accessToken: tokens.accessToken,
      numTokens: settings.claudeMaxTokens || 16000,
    };
  }
  if (settings.llmProvider === 'codex') {
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
  return {
    provider: 'ollama',
    host: settings.ollamaHost,
    model: settings.ollamaModel,
    contextWindow: settings.ollamaContextWindow,
    numTokens: settings.ollamaNumTokens,
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
  return 'Set the Ollama host and model in Settings → LLM to enable enrichment.';
}

module.exports = {
  createChatModel,
  ensureFreshCodexTokens,
  ensureFreshClaudeTokens,
  resolveLlm,
  llmReady,
  notReadyReason,
};
