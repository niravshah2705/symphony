'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { lmstudioMaxTokens, resolveLlm, lmstudioPromptBudget, trimMessagesForBudget, estimateMessageTokens } = require('./llm');
const { SystemMessage, HumanMessage, AIMessage, ToolMessage } = require('@langchain/core/messages');

/* --------------------------- lmstudioMaxTokens -------------------------- */

test('lmstudioMaxTokens caps output at half the context window', () => {
  // 16000 requested, 8192 window → half = 4096.
  assert.strictEqual(lmstudioMaxTokens({ numTokens: 16000, contextWindow: 8192 }), 4096);
});

test('lmstudioMaxTokens keeps the requested budget when it fits', () => {
  // 16000 requested, 40960 window → half = 20480 ≥ 16000, keep 16000.
  assert.strictEqual(lmstudioMaxTokens({ numTokens: 16000, contextWindow: 40960 }), 16000);
});

test('lmstudioMaxTokens never returns less than 256', () => {
  assert.strictEqual(lmstudioMaxTokens({ numTokens: 16000, contextWindow: 512 }), 256);
});

test('lmstudioMaxTokens defaults a missing context window to 8192', () => {
  assert.strictEqual(lmstudioMaxTokens({ numTokens: 16000 }), 4096);
});

/* ----------------------------- resolveLlm ------------------------------- */

test('resolveLlm surfaces the LM Studio context window on the descriptor', async () => {
  const llm = await resolveLlm({
    llmProvider: 'lmstudio',
    lmstudioHost: 'http://localhost:1234',
    lmstudioModel: 'ornith-1.0-35b',
    lmstudioContextWindow: 32768,
    lmstudioNumTokens: 16000,
  });
  assert.strictEqual(llm.provider, 'lmstudio');
  assert.strictEqual(llm.contextWindow, 32768);
  assert.strictEqual(lmstudioMaxTokens(llm), 16000); // half of 32768 = 16384 ≥ 16000
});

/* -------------------------- lmstudioPromptBudget ------------------------ */

test('lmstudioPromptBudget reserves the output cap + margin below the window', () => {
  // 129536 window, output cap 16000 (half=64768 ≥ 16000), 1024 margin → 112512.
  assert.strictEqual(lmstudioPromptBudget({ contextWindow: 129536, numTokens: 16000 }), 112512);
});

test('lmstudioPromptBudget returns 0 (trimming disabled) when no window is known', () => {
  assert.strictEqual(lmstudioPromptBudget({ numTokens: 16000 }), 0);
});

test('lmstudioPromptBudget never goes negative on a tiny window', () => {
  // 512 window, output cap 256, 1024 margin → clamped to 0.
  assert.strictEqual(lmstudioPromptBudget({ contextWindow: 512, numTokens: 16000 }), 0);
});

/* ------------------------- trimMessagesForBudget ------------------------ */

const CPT = 4; // chars-per-token for deterministic test arithmetic

// system + first human (the task) + two read tool-calls with large results + a
// final assistant turn — the shape of a long deep-agent coding run.
function buildConvo() {
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

test('trimMessagesForBudget returns the history unchanged when it already fits', () => {
  const msgs = buildConvo();
  assert.strictEqual(trimMessagesForBudget(msgs, 1_000_000, CPT), msgs);
});

test('trimMessagesForBudget is a pass-through when trimming is disabled (budget 0)', () => {
  const msgs = buildConvo();
  assert.strictEqual(trimMessagesForBudget(msgs, 0, CPT), msgs);
});

test('trimMessagesForBudget keeps system + first human + most recent turn, drops the middle', () => {
  const msgs = buildConvo();
  const [sys, human, , , , , lastAi] = msgs;
  const budget = estimateMessageTokens(sys, CPT) + estimateMessageTokens(human, CPT) + estimateMessageTokens(lastAi, CPT) + 5;
  const out = trimMessagesForBudget(msgs, budget, CPT);
  assert.deepStrictEqual(out, [sys, human, lastAi]);
});

test('trimMessagesForBudget never leaves an orphaned tool result leading the tail', () => {
  const msgs = buildConvo();
  const [sys, human, , tool1, , tool2, lastAi] = msgs;
  // Budget fits tool2 + lastAi but not the assistant turn that requested tool2, so a
  // naive tail would start on tool2 (orphaned) — it must be dropped instead.
  const budget =
    estimateMessageTokens(sys, CPT) +
    estimateMessageTokens(human, CPT) +
    estimateMessageTokens(lastAi, CPT) +
    estimateMessageTokens(tool2, CPT) +
    5;
  const out = trimMessagesForBudget(msgs, budget, CPT);
  assert.deepStrictEqual(out, [sys, human, lastAi]);
  assert.ok(!out.includes(tool1) && !out.includes(tool2));
  assert.notStrictEqual(out[out.length - 1]._getType(), 'tool');
});
