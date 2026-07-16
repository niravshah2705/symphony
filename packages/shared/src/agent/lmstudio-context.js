'use strict';

const { CONFIG } = require('../config');

/**
 * Context-window management for LM Studio (and any fixed-window local provider).
 *
 * The deep agent re-sends its ENTIRE, growing message history on every turn, but
 * LM Studio's loaded context window is fixed. A long coder run therefore overflows
 * the window and 400s ("...number of tokens to keep from the initial prompt is
 * greater than the context length"). This module bounds the prompt — but only when
 * it actually exceeds the budget — using one of two strategies:
 *
 *   - 'trim'      — drop the oldest middle turns, keep the head + most recent turns.
 *   - 'summarize' — condense the oldest middle turns into a single summary message
 *                   (via an injected LLM call) and keep the most recent turns
 *                   verbatim, so recent context stays exact and older context is
 *                   preserved in compressed form.
 *   - 'none'      — pass through unchanged (send as-is; may overflow).
 *
 * All estimates are model-agnostic char→token approximations (no per-model
 * tokenizer): deliberately conservative so we over-count and manage sooner rather
 * than under-count and overflow.
 */

// Flat per-message allowance for role/formatting tokens the char estimate misses.
const LMSTUDIO_MESSAGE_TOKEN_OVERHEAD = 4;
// Cap on reduce passes when a summarized middle is still too big to fit in one go.
const MAX_REDUCE_PASSES = 3;

// System prompt for the summarization sub-call (kept terse and information-dense).
const SUMMARY_SYSTEM_PROMPT =
  "You are compressing an AI coding agent's working history so it fits a smaller " +
  'context window. Summarize the conversation excerpt below into a compact, ' +
  'information-dense progress note. Preserve: decisions made, files created or ' +
  'edited (with paths), commands run and their key results, errors encountered, and ' +
  'any open TODOs or next steps. Omit chit-chat and redundant detail. Write terse ' +
  'notes, not prose. Do not invent information.';

// Header on the injected summary message so it is recognizable in transcripts.
const SUMMARY_MARKER = '[Summary of earlier turns — condensed to fit the context window]';

/** LangChain message type ('system'|'human'|'ai'|'tool'|…), tolerant of plain role objects. */
function messageType(message) {
  if (message && typeof message._getType === 'function') return message._getType();
  const role = message && message.role;
  if (role === 'user') return 'human';
  if (role === 'assistant') return 'ai';
  return role || 'generic';
}

/** Flatten a message's content (string | content blocks) to plain text. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join('\n');
  if (content == null) return '';
  return String(content);
}

/** Extract tool-call entries from either the LangChain or OpenAI shape. */
function toolCallsOf(message) {
  const calls = message && (message.tool_calls || (message.additional_kwargs && message.additional_kwargs.tool_calls));
  return Array.isArray(calls) ? calls : [];
}

/** Approximate character length of a message's content + any tool-call payload. */
function messageCharLength(message) {
  if (!message) return 0;
  let chars = contentToText(message.content).length;
  const toolCalls = toolCallsOf(message);
  if (toolCalls.length) chars += JSON.stringify(toolCalls).length;
  return chars;
}

/** Token estimate for a free-text string. */
function estimateTextTokens(text, charsPerToken = CONFIG.LMSTUDIO.charsPerToken) {
  const cpt = Number(charsPerToken) || CONFIG.LMSTUDIO.charsPerToken;
  return Math.ceil((typeof text === 'string' ? text.length : 0) / cpt);
}

/** Model-agnostic token estimate for a single chat message (over-estimates by design). */
function estimateMessageTokens(message, charsPerToken = CONFIG.LMSTUDIO.charsPerToken) {
  const cpt = Number(charsPerToken) || CONFIG.LMSTUDIO.charsPerToken;
  return Math.ceil(messageCharLength(message) / cpt) + LMSTUDIO_MESSAGE_TOKEN_OVERHEAD;
}

/** Total estimated token cost of a message list. */
function totalTokens(messages, charsPerToken) {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m, charsPerToken), 0);
}

/** Render a message as a single text line for the summarizer's input. */
function serializeMessageForSummary(message) {
  const role = messageType(message).toUpperCase();
  const text = contentToText(message && message.content);
  const calls = toolCallsOf(message)
    .map((tc) => {
      const name = tc.name || (tc.function && tc.function.name) || 'tool';
      const argsRaw = tc.args != null ? tc.args : tc.function && tc.function.arguments;
      let args = '';
      try {
        args = typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw || {});
      } catch {
        args = '';
      }
      return `→calls ${name}(${args})`;
    })
    .join(' ');
  return `${role}: ${text}${calls ? ` ${calls}` : ''}`.trim();
}

/**
 * Split a history into a preserved head (leading system prompt(s) + the first human
 * message — the task), a `tail` of the most recent messages that fit the budget
 * (after reserving `summaryReserve` tokens), and the `middle` in between (to be
 * dropped or summarized). A tool result never leads the tail — its assistant
 * tool_call sits in the middle — so it is moved into the middle instead.
 */
function splitForBudget(messages, { budget, summaryReserve = 0, charsPerToken = CONFIG.LMSTUDIO.charsPerToken }) {
  const cost = (m) => estimateMessageTokens(m, charsPerToken);
  const head = [];
  let i = 0;
  while (i < messages.length && messageType(messages[i]) === 'system') head.push(messages[i++]);
  if (i < messages.length && messageType(messages[i]) === 'human') head.push(messages[i++]);

  let remaining = budget - head.reduce((sum, m) => sum + cost(m), 0) - summaryReserve;
  const tail = [];
  let j = messages.length - 1;
  for (; j >= i; j--) {
    const c = cost(messages[j]);
    if (c > remaining) break;
    tail.unshift(messages[j]);
    remaining -= c;
  }
  const middle = messages.slice(i, j + 1);
  // Move orphaned leading tool result(s) out of the tail and into the middle.
  while (tail.length && messageType(tail[0]) === 'tool') middle.push(tail.shift());
  return { head, middle, tail };
}

/**
 * Trim a history to fit `budgetTokens`: keep the head + most recent turns, drop the
 * middle. A leading tool result is never kept (its assistant tool_call was trimmed,
 * and OpenAI-compatible APIs reject an orphaned tool message). budgetTokens <= 0 (or
 * a history that already fits) is a pass-through.
 */
function trimMessagesForBudget(messages, budgetTokens, charsPerToken = CONFIG.LMSTUDIO.charsPerToken) {
  if (!Array.isArray(messages) || !(budgetTokens > 0)) return messages;
  if (totalTokens(messages, charsPerToken) <= budgetTokens) return messages;
  const { head, tail } = splitForBudget(messages, { budget: budgetTokens, summaryReserve: 0, charsPerToken });
  return [...head, ...tail];
}

/**
 * Map step: pack serialized blocks into chunks that fit `effectiveBudget` and
 * summarize each chunk. An oversized single block is truncated to fit and
 * summarized on its own. Returns one summary string per chunk.
 */
async function mapSummarize(blocks, effectiveBudget, charsPerToken, summarize) {
  const summaries = [];
  let buf = [];
  let bufTokens = 0;
  const flush = async () => {
    if (!buf.length) return;
    summaries.push(await summarize(buf.join('\n')));
    buf = [];
    bufTokens = 0;
  };
  for (const block of blocks) {
    const t = estimateTextTokens(block, charsPerToken);
    if (t > effectiveBudget) {
      await flush();
      summaries.push(await summarize(block.slice(0, Math.max(0, effectiveBudget * charsPerToken))));
      continue;
    }
    if (bufTokens + t > effectiveBudget) await flush();
    buf.push(block);
    bufTokens += t;
  }
  await flush();
  return summaries;
}

/**
 * Summarize the middle turns into a single note, map-reduce style so the summarizer
 * input never exceeds the window (a huge middle is chunked, each chunk summarized,
 * then the summaries reduced until they collapse to one that fits `summaryMaxTokens`).
 */
async function summarizeMiddle(middle, { budget, charsPerToken, summaryMaxTokens, summarize }) {
  const promptTokens = estimateTextTokens(SUMMARY_SYSTEM_PROMPT, charsPerToken);
  const effectiveBudget = Math.max(256, budget - summaryMaxTokens - promptTokens - LMSTUDIO_MESSAGE_TOKEN_OVERHEAD);
  let summaries = await mapSummarize(middle.map(serializeMessageForSummary), effectiveBudget, charsPerToken, summarize);
  for (let pass = 0; summaries.length > 1 && pass < MAX_REDUCE_PASSES; pass++) {
    const joined = summaries.join('\n\n');
    if (estimateTextTokens(joined, charsPerToken) <= summaryMaxTokens) return joined;
    summaries = await mapSummarize(summaries, effectiveBudget, charsPerToken, summarize);
  }
  return summaries.join('\n\n');
}

/**
 * Prepare a history for a fixed-window call, applying the configured strategy ONLY
 * when the estimated prompt exceeds `budget`. `summarize(text) => Promise<string>`
 * is injected by the caller (so this module needs no LLM client and stays testable).
 * On any summarization failure we fall back to trimming so the run still proceeds.
 */
async function prepareMessages({ messages, mode, budget, charsPerToken, summaryMaxTokens, summarize }) {
  if (!Array.isArray(messages) || !(budget > 0) || mode === 'none') return messages;
  if (totalTokens(messages, charsPerToken) <= budget) return messages; // only when bigger
  if (mode !== 'summarize') return trimMessagesForBudget(messages, budget, charsPerToken);

  const reserve = Number(summaryMaxTokens) || CONFIG.LMSTUDIO.summaryMaxTokens;
  const { head, middle, tail } = splitForBudget(messages, { budget, summaryReserve: reserve, charsPerToken });
  if (!middle.length) return trimMessagesForBudget(messages, budget, charsPerToken);

  let summaryText;
  try {
    summaryText = await summarizeMiddle(middle, { budget, charsPerToken, summaryMaxTokens: reserve, summarize });
  } catch {
    return trimMessagesForBudget(messages, budget, charsPerToken);
  }
  const { HumanMessage } = require('@langchain/core/messages');
  const summaryMsg = new HumanMessage(`${SUMMARY_MARKER}\n${summaryText}`);
  return [...head, summaryMsg, ...tail];
}

module.exports = {
  messageType,
  contentToText,
  estimateTextTokens,
  estimateMessageTokens,
  serializeMessageForSummary,
  splitForBudget,
  trimMessagesForBudget,
  prepareMessages,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_MARKER,
};
