'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { executeAgentRuntime } = require('./dispatch');
const { executeDeepseek, resolveDshBin } = require('./deepseek');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A real path to stand in for a mounted DSH_BIN so resolveDshBin passes. */
function fakeDshBin(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'dsh');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  return bin;
}

test('deepseek runs headless and returns the normalized contract with clean env', async (t) => {
  const root = workspace(t);
  const seen = {};
  const execution = await executeAgentRuntime({
    runtime: 'deepseek',
    workflow: 'planning',
    workflowPattern: 'parallel',
    prompt: 'Create hello.py that prints hi',
    rootDir: root,
    backendKind: 'filesystem',
    systemPrompt: 'Trusted planning rules',
    llm: {
      provider: 'ollama',
      model: 'qwen2.5:7b',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'ollama-key',
      reasoningEffort: 'high',
    },
    env: { PATH: process.env.PATH, DSH_BIN: fakeDshBin(t), FOO_TOKEN: 'must-not-leak' },
    loaders: {
      deepseek: async () => (config) => {
        seen.config = config;
        return {
          finalText: 'DeepSeek finished',
          usage: { input_tokens: 20, output_tokens: 8 },
          sessionId: 'dsh-session-1',
          raw: { code: 0 },
        };
      },
    },
    getCurrentRunTree: () => seen.run || (seen.run = { metadata: {} }),
    traceFactory: (fn, cfg) => { seen.trace = cfg; return fn; },
  });

  // Contract shape.
  assert.equal(execution.runtime, 'deepseek');
  assert.equal(execution.provider, 'ollama');
  assert.equal(execution.model, 'qwen2.5:7b');
  assert.equal(execution.finalText, 'DeepSeek finished');
  assert.equal(execution.usage.inputTokens, 20);
  assert.equal(execution.usage.totalTokens, 28);
  assert.equal(execution.costUsd, null);
  assert.equal(execution.sessionId, 'dsh-session-1');
  assert.deepEqual(execution.messages, [{ role: 'assistant', content: 'DeepSeek finished' }]);

  // Env hygiene: scoped model config present, ambient secret stripped.
  assert.equal(seen.config.env.DEEPSEEK_BASE_URL, 'http://127.0.0.1:11434/v1');
  assert.equal(seen.config.env.DEEPSEEK_API_KEY, 'ollama-key');
  assert.equal(seen.config.env.DEEPSEEK_MODEL, 'qwen2.5:7b');
  assert.equal(seen.config.env.DSH_PROVIDER, 'deepseek-official');
  assert.ok(seen.config.env.DSH_HOME);
  assert.equal(seen.config.env.FOO_TOKEN, undefined);
  assert.equal(seen.config.env.HARNESS_WORKSPACE, root);
  // System prompt folds into the task ahead of the pattern-wrapped prompt.
  assert.match(seen.config.task, /Trusted planning rules/);
  assert.match(seen.config.task, /workflow_pattern id="parallel"/);
  assert.equal(seen.config.reasoningEffort, 'high');

  // Trace metadata identifies the harness while riding the underlying provider.
  assert.equal(seen.trace.metadata.agent_runtime, 'deepseek');
  assert.equal(seen.trace.metadata.harness, 'deepseek');
  assert.equal(seen.trace.metadata.ls_provider, 'ollama');
  assert.equal(seen.trace.run_type, 'llm');
  assert.ok(seen.trace.tags.includes('runtime:deepseek'));
  assert.ok(seen.trace.tags.includes('harness:deepseek'));
});

test('deepseek rejects a missing model and unsupported provider slots', async (t) => {
  const root = workspace(t);
  await assert.rejects(
    executeDeepseek({ rootDir: root, llm: { provider: 'ollama' }, env: { DSH_BIN: fakeDshBin(t) } }, 'hi'),
    (error) => error.code === 'runtime_provider_mismatch' && error.status === 400
  );
  await assert.rejects(
    executeDeepseek({ rootDir: root, llm: { provider: 'claude', model: 'x' }, env: { DSH_BIN: fakeDshBin(t) } }, 'hi'),
    (error) => error.code === 'runtime_provider_mismatch'
  );
});

test('resolveDshBin points at an external disk and fails fast when absent', (t) => {
  const bin = fakeDshBin(t);
  assert.deepEqual(resolveDshBin({ DSH_BIN: bin }), { command: bin, prefixArgs: [] });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-js-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'bin.js');
  fs.writeFileSync(script, '');
  assert.deepEqual(resolveDshBin({ DSH_BIN: script }), { command: process.execPath, prefixArgs: [script] });

  assert.throws(
    () => resolveDshBin({ DSH_BIN: '/no/such/dsh-runtime-xyz' }),
    (error) => error.code === 'runtime_unavailable' && error.status === 503
  );
});

test('defaultRunDsh spawns the real dsh headless subprocess and returns its stdout', async (t) => {
  const root = workspace(t);
  // A stand-in `dsh` binary: `--dump-default-config` materializes the profile
  // dir; a headless run echoes a deterministic final line to stdout and exits 0.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-fakebin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'dsh');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'for a in "$@"; do if [ "$a" = "--dump-default-config" ]; then',
    '  mkdir -p "$DSH_HOME/profiles/headless"; exit 0; fi; done',
    // The task text is the final positional argument.
    'eval "task=\\${$#}"',
    'printf "DSH_MODEL=%s ran: %s\\n" "$DEEPSEEK_MODEL" "$task"',
  ].join('\n'), { mode: 0o755 });

  // No loaders stub → the real defaultRunDsh spawn path runs.
  const execution = await executeDeepseek({
    rootDir: root,
    workflowPattern: 'sequential',
    systemPrompt: '',
    llm: { provider: 'ollama', model: 'qwen2.5:7b', baseUrl: 'http://127.0.0.1:11434/v1' },
    env: { PATH: process.env.PATH, DSH_BIN: bin },
  }, 'write a haiku');

  assert.equal(execution.runtime, 'deepseek');
  assert.match(execution.finalText, /DSH_MODEL=qwen2\.5:7b ran: write a haiku/);
});

test('an ephemeral DSH_HOME is created for the run and removed afterward', async (t) => {
  const root = workspace(t);
  let capturedHome = null;
  const run = (llm, runner) => executeDeepseek({
    rootDir: root,
    llm,
    env: { PATH: process.env.PATH, DSH_BIN: fakeDshBin(t) },
    loaders: { deepseek: async () => runner },
  }, 'do it');

  await run({ provider: 'ollama', model: 'm' }, (config) => {
    capturedHome = config.env.DSH_HOME;
    assert.ok(fs.existsSync(capturedHome), 'ephemeral home exists during the run');
    return { finalText: 'ok' };
  });
  assert.ok(capturedHome);
  assert.equal(fs.existsSync(capturedHome), false, 'ephemeral home removed after success');

  // Cleanup also runs when the runner throws.
  let throwHome = null;
  await assert.rejects(run({ provider: 'ollama', model: 'm' }, (config) => {
    throwHome = config.env.DSH_HOME;
    throw new Error('boom');
  }));
  assert.equal(fs.existsSync(throwHome), false, 'ephemeral home removed after failure');
});
