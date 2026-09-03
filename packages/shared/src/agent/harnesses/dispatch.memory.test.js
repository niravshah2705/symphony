'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createRuntimeDispatcher } = require('./dispatch');
const mw = require('../memory-middleware');

/** A minimal registry + executor so the test never loads a real SDK/harness. */
function fakeRegistry(seen) {
  return {
    resolveAgentRuntime: () => ({ requestedRuntime: 'fake', runtime: 'fake', fallbackReason: null }),
    get: () => ({
      label: 'Fake',
      createExecutor: () => (opts, promptText) => {
        seen.push(promptText);
        return { finalText: 'ok', runtime: 'fake', usage: null, costUsd: null, messages: [] };
      },
    }),
    harnessLabel: () => 'fake',
  };
}

async function withStubbedMiddleware(overrides, fn) {
  const saved = { isEnabled: mw.isEnabled, inject: mw.inject, capture: mw.capture };
  Object.assign(mw, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(mw, saved);
  }
}

test('memory ON — dispatch injects into the prompt and captures the finished run', async () => {
  const seen = [];
  const dispatch = createRuntimeDispatcher(fakeRegistry(seen));
  let captured = null;
  await withStubbedMiddleware({
    isEnabled: () => true,
    inject: async (prompt) => `MEM\n${prompt}`,
    capture: async (result) => { captured = result; },
  }, async () => {
    const res = await dispatch({ runtime: 'fake', prompt: 'hello', trace: false, llm: {} });
    assert.equal(res.finalText, 'ok');
  });
  assert.equal(seen[0], 'MEM\nhello', 'executor received the injected prompt');
  assert.ok(captured && captured.finalText === 'ok', 'capture saw the reviewed result');
});

test('memory OFF — dispatch is byte-identical (no injection, no capture)', async () => {
  const seen = [];
  const dispatch = createRuntimeDispatcher(fakeRegistry(seen));
  let captureCalls = 0;
  await withStubbedMiddleware({
    isEnabled: () => false,
    inject: async (prompt) => `MEM\n${prompt}`,
    capture: async () => { captureCalls += 1; },
  }, async () => {
    await dispatch({ runtime: 'fake', prompt: 'hello', trace: false, llm: {} });
  });
  assert.equal(seen[0], 'hello', 'prompt passed through unchanged');
  assert.equal(captureCalls, 0, 'capture never runs when disabled');
});

test('a throwing inject can never fail the run — the original prompt is used', async () => {
  const seen = [];
  const dispatch = createRuntimeDispatcher(fakeRegistry(seen));
  await withStubbedMiddleware({
    isEnabled: () => true,
    inject: async () => { throw new Error('inject blew up'); },
    capture: async () => {},
  }, async () => {
    const res = await dispatch({ runtime: 'fake', prompt: 'hello', trace: false, llm: {} });
    assert.equal(res.finalText, 'ok');
  });
  assert.equal(seen[0], 'hello', 'fell back to the original prompt');
});
