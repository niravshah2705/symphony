'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG } = require('../config');
const {
  createChatModel,
  resolveLlm,
  codexMaxTokens,
  codexPromptBudget,
  clampStreamRetries,
} = require('./llm');
const { SystemMessage, HumanMessage, AIMessage, ToolMessage } = require('@langchain/core/messages');

/* ----------------------------- codexMaxTokens --------------------------- */

test('codexMaxTokens reserves the requested output (floored at 256)', () => {
  assert.equal(codexMaxTokens({ numTokens: 65536 }), 65536);
  assert.equal(codexMaxTokens({ numTokens: 10 }), 256);
  assert.equal(codexMaxTokens({}), 4096);
});

/* --------------------------- codexPromptBudget -------------------------- */

test('codexPromptBudget reserves the output cap + margin below the window', () => {
  const budget = codexPromptBudget({ contextWindow: 272000, numTokens: 65536 });
  assert.equal(budget, 272000 - 65536 - CONFIG.OAUTH.promptMarginTokens);
});

test('codexPromptBudget returns 0 (trimming disabled) when no window is known', () => {
  assert.equal(codexPromptBudget({ numTokens: 65536 }), 0);
});

test('codexPromptBudget never goes negative on a tiny window', () => {
  assert.equal(codexPromptBudget({ contextWindow: 512, numTokens: 65536 }), 0);
});

/* --------------------------- clampStreamRetries ------------------------- */

test('clampStreamRetries bounds to a non-negative integer and defaults sanely', () => {
  assert.equal(clampStreamRetries(2), 2);
  assert.equal(clampStreamRetries(-4), 0);
  assert.equal(clampStreamRetries(999), 5); // MAX_STREAM_RETRIES
  assert.equal(clampStreamRetries(1.7), 2); // rounded
  assert.equal(clampStreamRetries('nope'), CONFIG.LLM_STREAM_RETRIES);
  assert.equal(clampStreamRetries(undefined), CONFIG.LLM_STREAM_RETRIES);
});

/* ------------------------------ resolveLlm ------------------------------ */

test('resolveLlm surfaces the single stream-retry knob on every provider descriptor', async () => {
  const d = await resolveLlm({
    llmProvider: 'lmstudio',
    lmstudioModel: 'ornith-1.0-35b',
    lmstudioContextWindow: 32768,
    llmStreamRetries: 3,
  });
  assert.equal(d.streamRetries, 3);
});

test('resolveLlm defaults the stream-retry knob to the configured default', async () => {
  const d = await resolveLlm({ llmProvider: 'lmstudio', lmstudioModel: 'x', lmstudioContextWindow: 8192 });
  assert.equal(d.streamRetries, CONFIG.LLM_STREAM_RETRIES);
});

/* -------------------- Codex model prompt budget + rewrite --------------- */

function codexDescriptor(overrides = {}) {
  return {
    provider: 'codex',
    backend: 'chatgpt',
    model: 'gpt-5.6-sol',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    accessToken: 'test-access-token',
    accountId: 'acct_test',
    numTokens: 256,
    contextWindow: 0,
    contextMode: 'trim',
    streamRetries: 1,
    reasoningAdapter: 'none',
    reasoningEffort: null,
    ...overrides,
  };
}

function longConvo() {
  return [
    new SystemMessage('S'.repeat(400)),
    new HumanMessage('H'.repeat(400)),
    new AIMessage({ content: '', tool_calls: [{ id: '1', name: 'read', args: { path: 'a.js' } }] }),
    new ToolMessage({ content: 'T'.repeat(20000), tool_call_id: '1' }),
    new AIMessage({ content: '', tool_calls: [{ id: '2', name: 'read', args: { path: 'b.js' } }] }),
    new ToolMessage({ content: 'T'.repeat(20000), tool_call_id: '2' }),
    new AIMessage('final summary of the work done'),
  ];
}

test('createChatModel wires the Codex prompt budget and stream-retry count onto the model', () => {
  const llm = codexDescriptor({ contextWindow: 272000, numTokens: 65536, streamRetries: 2 });
  const model = createChatModel(llm);
  assert.equal(model.promptBudget, codexPromptBudget(llm));
  assert.equal(model.contextMode, 'trim');
  assert.equal(model.streamRetries, 2);
  assert.equal(model.retryProvider, 'codex');
});

test('Codex _prepareMessages rewrites system→developer but keeps a fitting history intact', async () => {
  // No context window → budget 0 → no trimming, only the system→developer rewrite.
  const model = createChatModel(codexDescriptor());
  const convo = longConvo();
  const out = await model._prepareMessages(convo);
  assert.equal(out.length, convo.length);
  assert.equal(out[0].role, 'developer'); // system rewritten
  assert.equal(out[0]._getType(), 'generic');
  assert.equal(out[3], convo[3]); // untouched messages keep their identity
});

test('Codex _prepareMessages trims the middle when the prompt overflows the window', async () => {
  // 4602 window, 256 output reserve, 4096 margin → 250-token budget: the two large
  // tool results cannot fit, so the middle is dropped (head + most recent turn kept).
  const model = createChatModel(codexDescriptor({ contextWindow: 4602, numTokens: 256, contextMode: 'trim' }));
  const convo = longConvo();
  const [, , , tool1, , tool2, lastAi] = convo;
  const out = await model._prepareMessages(convo);
  assert.equal(out[0].role, 'developer'); // system still rewritten
  assert.equal(out[out.length - 1], lastAi);
  assert.ok(!out.includes(tool1) && !out.includes(tool2));
  assert.ok(out.length < convo.length);
});
