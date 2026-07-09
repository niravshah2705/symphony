'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { SystemMessage, HumanMessage, AIMessage, ToolMessage } = require('@langchain/core/messages');
const {
  estimateMessageTokens,
  trimMessagesForBudget,
  splitForBudget,
  prepareMessages,
  SUMMARY_MARKER,
} = require('./lmstudio-context');

const CPT = 4; // chars-per-token for deterministic test arithmetic
const est = (m) => estimateMessageTokens(m, CPT);

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

/* ------------------------------ splitForBudget -------------------------- */

test('splitForBudget keeps system + first human as the head', () => {
  const msgs = buildConvo();
  const [sys, human] = msgs;
  const { head } = splitForBudget(msgs, { budget: 100_000, charsPerToken: CPT });
  assert.deepStrictEqual(head, [sys, human]);
});

test('splitForBudget moves an orphaned leading tool result into the middle', () => {
  const msgs = buildConvo();
  const [sys, human, , , , tool2, lastAi] = msgs;
  // Budget fits tool2 + lastAi in the tail but not the AI turn that requested tool2,
  // so a naive tail would start on tool2 (orphaned) — it must move to the middle.
  const budget = est(sys) + est(human) + est(lastAi) + est(tool2) + 5;
  const { head, middle, tail } = splitForBudget(msgs, { budget, summaryReserve: 0, charsPerToken: CPT });
  assert.deepStrictEqual(head, [sys, human]);
  assert.strictEqual(tail[0], lastAi);
  assert.ok(!tail.includes(tool2));
  assert.ok(middle.includes(tool2));
});

/* ------------------------------ prepareMessages ------------------------- */

test('prepareMessages passes through when the history already fits', async () => {
  const msgs = buildConvo();
  const out = await prepareMessages({ messages: msgs, mode: 'summarize', budget: 1_000_000, charsPerToken: CPT, summarize: async () => 'x' });
  assert.strictEqual(out, msgs);
});

test('prepareMessages with mode "none" never manages the history', async () => {
  const msgs = buildConvo();
  let called = 0;
  const out = await prepareMessages({ messages: msgs, mode: 'none', budget: 10, charsPerToken: CPT, summarize: async () => (called++, 'x') });
  assert.strictEqual(out, msgs);
  assert.strictEqual(called, 0);
});

test('prepareMessages with mode "trim" drops the middle', async () => {
  const msgs = buildConvo();
  const [sys, human, , , , , lastAi] = msgs;
  const budget = est(sys) + est(human) + est(lastAi) + 5;
  const out = await prepareMessages({ messages: msgs, mode: 'trim', budget, charsPerToken: CPT, summarize: async () => 'x' });
  assert.deepStrictEqual(out, trimMessagesForBudget(msgs, budget, CPT));
  assert.deepStrictEqual(out, [sys, human, lastAi]);
});

test('prepareMessages "summarize" injects a summary of the middle, keeps recent turns verbatim', async () => {
  const msgs = buildConvo();
  const [sys, human, , , , , lastAi] = msgs;
  const summaryMaxTokens = 50;
  const budget = est(sys) + est(human) + summaryMaxTokens + est(lastAi) + 5;
  let calls = 0;
  const summarize = async () => {
    calls += 1;
    return 'PROGRESS';
  };
  const out = await prepareMessages({ messages: msgs, mode: 'summarize', budget, charsPerToken: CPT, summaryMaxTokens, summarize });
  // head + one injected summary message + the recent tail (verbatim).
  assert.strictEqual(out.length, 4);
  assert.strictEqual(out[0], sys);
  assert.strictEqual(out[1], human);
  assert.strictEqual(out[3], lastAi);
  assert.strictEqual(out[2]._getType(), 'human');
  assert.ok(out[2].content.startsWith(SUMMARY_MARKER));
  assert.ok(out[2].content.includes('PROGRESS'));
  // The large middle exceeds one summarizer chunk → map-reduce makes several calls.
  assert.ok(calls > 1, `expected multiple summarize calls, got ${calls}`);
});

test('prepareMessages "summarize" falls back to trimming when summarization fails', async () => {
  const msgs = buildConvo();
  const [sys, human, , , , , lastAi] = msgs;
  const summaryMaxTokens = 50;
  const budget = est(sys) + est(human) + summaryMaxTokens + est(lastAi) + 5;
  const summarize = async () => {
    throw new Error('LM Studio channel error');
  };
  const out = await prepareMessages({ messages: msgs, mode: 'summarize', budget, charsPerToken: CPT, summaryMaxTokens, summarize });
  assert.deepStrictEqual(out, trimMessagesForBudget(msgs, budget, CPT));
  assert.ok(!out.some((m) => typeof m.content === 'string' && m.content.startsWith(SUMMARY_MARKER)));
});
