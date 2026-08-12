'use strict';

/**
 * Antigravity harness. Google Antigravity ships no npm package, so the Node
 * adapter is backed by @google/genai's managed-agent `interactions` API (the
 * peer of the Codex/Claude SDKs), falling back to `models.generateContent` when
 * the PREVIEW interactions API is unavailable. Auth is a Gemini API key; the
 * called model/agent id is config-driven.
 */

const { CONFIG } = require('../../config');
const { SENTINEL_TOKEN } = require('../../egress');
const registry = require('./registry');
const {
  AgentRuntimeError,
  loadSdk,
  assertWorkingDirectory,
  cleanSystemPrompt,
  normalizeUsage,
  assistantMessagesFromText,
  wrapExecutionError,
} = require('./contract');

const ID = 'antigravity-sdk';
const LABEL = 'Antigravity SDK';
const PACKAGE = '@google/genai';

/**
 * Map Gemini/@google/genai usage metadata onto the shared usage contract. The
 * native API reports promptTokenCount/candidatesTokenCount/totalTokenCount; the
 * preview interactions API may instead report input/output token counts.
 */
function antigravityUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return normalizeUsage({
    input_tokens: raw.promptTokenCount ?? raw.inputTokens ?? raw.input_tokens,
    output_tokens: raw.candidatesTokenCount ?? raw.outputTokens ?? raw.output_tokens,
    total_tokens: raw.totalTokenCount ?? raw.totalTokens ?? raw.total_tokens,
    cached_input_tokens: raw.cachedContentTokenCount ?? raw.cachedInputTokens ?? raw.cached_input_tokens,
    reasoning_output_tokens: raw.thoughtsTokenCount ?? raw.reasoningOutputTokens ?? raw.reasoning_output_tokens,
  });
}

/** Extract the assistant text from an interactions/generateContent response. */
function antigravityText(response) {
  if (!response || typeof response !== 'object') return '';
  for (const key of ['text', 'outputText', 'output_text', 'finalText']) {
    if (typeof response[key] === 'string' && response[key]) return response[key];
  }
  // Managed-agent interactions typically return a list of output items whose
  // content parts each carry a `text` field.
  const output = response.output || response.outputs;
  if (Array.isArray(output)) {
    const parts = output.flatMap((item) => {
      const content = item && (item.content || item.parts);
      return Array.isArray(content) ? content : [];
    });
    const text = parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
    if (text) return text;
  }
  // Native generateContent candidates fallback.
  const candidates = response.candidates;
  if (Array.isArray(candidates) && candidates.length) {
    const parts = candidates[0] && candidates[0].content && candidates[0].content.parts;
    if (Array.isArray(parts)) {
      return parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
    }
  }
  return '';
}

async function executeAntigravity(options, prompt) {
  if (!options.llm || options.llm.provider !== 'antigravity') {
    throw new AgentRuntimeError(
      'Antigravity SDK requires the hosted Antigravity (Gemini) model slot.',
      'runtime_provider_mismatch',
      400
    );
  }
  // Gemini API key precedence: the effective key resolved from the settings
  // service (per the caller's org/project/user) wins; otherwise fall back to the
  // descriptor's key, which carries the GEMINI_API_KEY env / store value.
  const resolvedConfigKey = options.ctx && options.ctx.geminiApiKey;
  // In include-SDK proxy mode the agent has no Gemini key — the proxy injects it
  // (x-goog-api-key) — so the sentinel satisfies the "configured" guard.
  const proxySdk = Boolean(CONFIG.EGRESS_PROXY_INCLUDE_SDK);
  const apiKey = String(
    resolvedConfigKey ||
      (options.llm && (options.llm.apiKey || options.llm.accessToken)) ||
      (proxySdk ? SENTINEL_TOKEN : '')
  );
  if (!apiKey) {
    throw new AgentRuntimeError(
      'Antigravity SDK authentication is unavailable. Add a Gemini API key in Settings and try again.',
      'runtime_auth_unavailable',
      401
    );
  }
  const sdk = await loadSdk({ id: ID, label: LABEL, packageName: PACKAGE, loaders: options.loaders, importer: () => import('@google/genai') });
  const GoogleGenAI = sdk && (sdk.GoogleGenAI || (sdk.default && sdk.default.GoogleGenAI));
  if (typeof GoogleGenAI !== 'function') {
    throw new AgentRuntimeError('The installed @google/genai does not export GoogleGenAI.', 'runtime_unavailable', 503);
  }
  const cwd = assertWorkingDirectory(options.rootDir);
  try {
    // Route native genai through the proxy's /gemini-native prefix when enabled.
    const genaiOptions = proxySdk
      ? { apiKey, httpOptions: { baseUrl: CONFIG.ANTIGRAVITY.nativeBaseUrl } }
      : { apiKey };
    const ai = new GoogleGenAI(genaiOptions);
    // Config-driven target: the Antigravity preview agent id when provided, else a
    // stable Gemini model. The trusted workflow rules stay in the system prompt.
    const target = String(options.llm.agentId || options.llm.model || '');
    const systemPrompt = cleanSystemPrompt(options.systemPrompt, options.ctx);
    const input = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

    let response;
    let sessionId = null;
    if (ai.interactions && typeof ai.interactions.create === 'function') {
      response = await ai.interactions.create({
        model: target,
        input,
        stream: false,
        ...(cwd ? { workingDirectory: cwd } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      sessionId = (response && (response.id || response.interactionId || response.sessionId)) || null;
    } else if (ai.models && typeof ai.models.generateContent === 'function') {
      response = await ai.models.generateContent({ model: target, contents: input });
      sessionId = (response && (response.responseId || response.response_id)) || null;
    } else {
      throw new AgentRuntimeError(
        'The installed @google/genai exposes neither interactions.create nor models.generateContent.',
        'runtime_unavailable',
        503
      );
    }

    const finalText = antigravityText(response);
    return {
      runtime: ID,
      provider: 'antigravity',
      model: options.llm.model,
      workflowPattern: options.workflowPattern,
      result: response,
      messages: assistantMessagesFromText(finalText),
      finalText,
      usage: antigravityUsage(response && (response.usageMetadata || response.usage_metadata || response.usage)),
      // The Gemini API reports token usage but no billed USD amount.
      costUsd: null,
      sessionId,
    };
  } catch (error) {
    throw wrapExecutionError(LABEL, error);
  }
}

registry.register({
  id: ID,
  label: LABEL,
  harnessName: 'antigravity',
  packageName: PACKAGE,
  requiresProvider: 'antigravity',
  capabilities: { coding: false, planning: true, streaming: false, subagents: false },
  createExecutor: () => executeAntigravity,
});

module.exports = { executeAntigravity };
