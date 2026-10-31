'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntimeDispatcher } = require('./dispatch');
const { executeDeepAgent } = require('./deepagent');
const { executeCodex } = require('./codex');
const { executeClaude } = require('./claude');
const { executeAntigravity } = require('./antigravity');

/** A minimal registry + executor so the test never loads a real external SDK. */
function fakeRegistry(recorded) {
  return {
    resolveAgentRuntime: () => ({ requestedRuntime: 'fake-harness', runtime: 'fake-harness', fallbackReason: null }),
    get: () => ({
      label: 'Fake Harness',
      createExecutor: () => async (opts, promptText) => {
        recorded.push({ opts, promptText });
        return {
          finalText: 'completed task',
          runtime: 'fake-harness',
          usage: null,
          costUsd: null,
          messages: [],
        };
      },
    }),
    harnessLabel: () => 'fake-harness',
  };
}

function failingRegistry() {
  return {
    resolveAgentRuntime: () => ({ requestedRuntime: 'failing-harness', runtime: 'failing-harness', fallbackReason: null }),
    get: () => ({
      label: 'Failing Harness',
      createExecutor: () => async () => {
        throw new Error('Simulation execution failed');
      },
    }),
    harnessLabel: () => 'failing-harness',
  };
}

test('dispatcher routes candidate skills and stamps skillRouterMetrics and skillPaths on success', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-skills-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const skill1 = path.join(tmpDir, 'skill-1');
  const skill2 = path.join(tmpDir, 'skill-2');
  fs.mkdirSync(skill1);
  fs.mkdirSync(skill2);
  fs.writeFileSync(path.join(skill1, 'SKILL.md'), '--- \ndescription: Testing skill 1\n---');
  fs.writeFileSync(path.join(skill2, 'SKILL.md'), '--- \ndescription: Testing skill 2\n---');

  const recorded = [];
  const dispatch = createRuntimeDispatcher(fakeRegistry(recorded));

  const result = await dispatch({
    runtime: 'fake-harness',
    prompt: 'Execute task using skills',
    skillPaths: [skill1, skill2],
    rootDir: tmpDir,
    trace: false,
    llm: {},
  });

  assert.equal(result.finalText, 'completed task');
  assert.ok(result.skillRouterMetrics, 'skillRouterMetrics is attached to result');
  assert.equal(result.skillRouterMetrics.totalSkills, 2);
  assert.ok(Array.isArray(result.skillPaths), 'skillPaths is attached to result');
  assert.equal(result.skillPaths.length, 2);
});

test('dispatcher preserves pre-routed skillRouterMetrics and does not overwrite', async () => {
  const recorded = [];
  const dispatch = createRuntimeDispatcher(fakeRegistry(recorded));
  const precomputedMetrics = {
    backend: 'laya',
    totalSkills: 4,
    usedSkills: 2,
    contextReductionPercent: 50.0,
  };
  const precomputedPaths = ['/skills/a', '/skills/b'];

  const result = await dispatch({
    runtime: 'fake-harness',
    prompt: 'Pre-routed run',
    skillPaths: precomputedPaths,
    skillRouterMetrics: precomputedMetrics,
    trace: false,
    llm: {},
  });

  assert.equal(result.skillRouterMetrics, precomputedMetrics);
  assert.deepEqual(result.skillPaths, precomputedPaths);
});

test('dispatcher attaches skillRouterMetrics to wrapped error on harness execution failure', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-err-skills-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const skillA = path.join(tmpDir, 'skill-a');
  const skillB = path.join(tmpDir, 'skill-b');
  fs.mkdirSync(skillA);
  fs.mkdirSync(skillB);
  fs.writeFileSync(path.join(skillA, 'SKILL.md'), 'Skill A content');
  fs.writeFileSync(path.join(skillB, 'SKILL.md'), 'Skill B content');

  const dispatch = createRuntimeDispatcher(failingRegistry());

  await assert.rejects(
    async () => {
      await dispatch({
        runtime: 'failing-harness',
        prompt: 'Task that will throw',
        skillPaths: [skillA, skillB],
        rootDir: tmpDir,
        trace: false,
        llm: {},
      });
    },
    (err) => {
      assert.ok(err.skillRouterMetrics, 'skillRouterMetrics is attached to error');
      assert.equal(err.skillRouterMetrics.totalSkills, 2);
      return true;
    }
  );
});

test('executeDeepAgent returns skillRouterMetrics and skillPaths when candidate skills are provided', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepagent-skills-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const skill1 = path.join(tmpDir, 'skill-1');
  const skill2 = path.join(tmpDir, 'skill-2');
  fs.mkdirSync(skill1);
  fs.mkdirSync(skill2);
  fs.writeFileSync(path.join(skill1, 'SKILL.md'), 'Skill 1');
  fs.writeFileSync(path.join(skill2, 'SKILL.md'), 'Skill 2');

  const res = await executeDeepAgent({
    deepAgentInvoke: async () => ({ messages: [{ role: 'assistant', content: 'done' }] }),
    lastText: (r) => r.messages[0].content,
    skillPaths: [skill1, skill2],
    rootDir: tmpDir,
    llm: { provider: 'ollama', model: 'qwen' },
  }, 'Solve bug');

  assert.equal(res.finalText, 'done');
  assert.ok(res.skillRouterMetrics, 'skillRouterMetrics is attached');
  assert.equal(res.skillRouterMetrics.totalSkills, 2);
  assert.ok(Array.isArray(res.skillPaths), 'skillPaths is attached');
});

test('executeCodex returns skillRouterMetrics and skillPaths when candidate skills are provided', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skills-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const skill1 = path.join(tmpDir, 'skill-1');
  const skill2 = path.join(tmpDir, 'skill-2');
  fs.mkdirSync(skill1);
  fs.mkdirSync(skill2);
  fs.writeFileSync(path.join(skill1, 'SKILL.md'), 'Skill 1');
  fs.writeFileSync(path.join(skill2, 'SKILL.md'), 'Skill 2');

  class FakeCodex {
    constructor() {}
    startThread() {
      return {
        id: 'codex-thread-test',
        run: async () => ({ finalResponse: 'Codex completed', items: [], usage: null }),
      };
    }
  }

  const res = await executeCodex({
    rootDir: tmpDir,
    skillPaths: [skill1, skill2],
    llm: { provider: 'codex', backend: 'api', accessToken: 'fake-token' },
    loaders: { 'codex-sdk': async () => ({ Codex: FakeCodex }) },
  }, 'Analyze task');

  assert.equal(res.finalText, 'Codex completed');
  assert.ok(res.skillRouterMetrics, 'skillRouterMetrics is attached');
  assert.equal(res.skillRouterMetrics.totalSkills, 2);
  assert.ok(Array.isArray(res.skillPaths), 'skillPaths is attached');
});

test('executeClaude returns skillRouterMetrics and skillPaths when candidate skills are provided', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-skills-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const skill1 = path.join(tmpDir, 'skill-1');
  const skill2 = path.join(tmpDir, 'skill-2');
  fs.mkdirSync(skill1);
  fs.mkdirSync(skill2);
  fs.writeFileSync(path.join(skill1, 'SKILL.md'), 'Skill 1');
  fs.writeFileSync(path.join(skill2, 'SKILL.md'), 'Skill 2');

  const fakeQuery = () => (async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Claude completed',
      session_id: 'claude-sess-test',
    };
  })();

  const res = await executeClaude({
    rootDir: tmpDir,
    skillPaths: [skill1, skill2],
    llm: { provider: 'claude', accessToken: 'fake-token' },
    loaders: { 'claude-agent-sdk': async () => ({ query: fakeQuery }) },
  }, 'Analyze task');

  assert.equal(res.finalText, 'Claude completed');
  assert.ok(res.skillRouterMetrics, 'skillRouterMetrics is attached');
  assert.equal(res.skillRouterMetrics.totalSkills, 2);
  assert.ok(Array.isArray(res.skillPaths), 'skillPaths is attached');
});

test('executeAntigravity returns skillRouterMetrics and skillPaths when candidate skills are provided', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-skills-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const skill1 = path.join(tmpDir, 'skill-1');
  const skill2 = path.join(tmpDir, 'skill-2');
  fs.mkdirSync(skill1);
  fs.mkdirSync(skill2);
  fs.writeFileSync(path.join(skill1, 'SKILL.md'), 'Skill 1');
  fs.writeFileSync(path.join(skill2, 'SKILL.md'), 'Skill 2');

  class FakeGoogleGenAI {
    constructor() {}
    get models() {
      return {
        generateContent: async () => ({
          text: 'Antigravity completed',
          usageMetadata: {},
        }),
      };
    }
  }

  const res = await executeAntigravity({
    rootDir: tmpDir,
    skillPaths: [skill1, skill2],
    llm: { provider: 'antigravity', apiKey: 'fake-api-key' },
    loaders: { 'antigravity-sdk': async () => ({ GoogleGenAI: FakeGoogleGenAI }) },
  }, 'Analyze task');

  assert.equal(res.finalText, 'Antigravity completed');
  assert.ok(res.skillRouterMetrics, 'skillRouterMetrics is attached');
  assert.equal(res.skillRouterMetrics.totalSkills, 2);
  assert.ok(Array.isArray(res.skillPaths), 'skillPaths is attached');
});
