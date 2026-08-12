'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveHarnessForStage,
  applyOperationalPrefs,
  STAGE_HARNESS_PREF,
} = require('./policy-runtime');

test('resolveHarnessForStage honors request > stage pref > default > builtin', () => {
  // Explicit per-request selection wins over everything.
  assert.equal(
    resolveHarnessForStage('coding', {
      requestSelection: 'claude-agent-sdk',
      prefs: { codeHarness: 'codex-sdk', agentRuntime: 'antigravity-sdk' },
    }),
    'claude-agent-sdk'
  );
  // Per-stage pref beats the scope default.
  assert.equal(
    resolveHarnessForStage('coding', { prefs: { codeHarness: 'codex-sdk', agentRuntime: 'antigravity-sdk' } }),
    'codex-sdk'
  );
  // Scope default ("one harness does everything") when no stage override.
  assert.equal(
    resolveHarnessForStage('coding', { prefs: { agentRuntime: 'antigravity-sdk' } }),
    'antigravity-sdk'
  );
  // Provided default, then the builtin fallback.
  assert.equal(resolveHarnessForStage('coding', { prefs: {}, defaultHarness: 'codex-sdk' }), 'codex-sdk');
  assert.equal(resolveHarnessForStage('coding', {}), 'deepagent');
});

test('resolveHarnessForStage reads the right per-stage key for each stage', () => {
  const prefs = {
    planHarness: 'p',
    codeHarness: 'c',
    testHarness: 't',
    deployHarness: 'd',
    agentRuntime: 'default',
  };
  assert.equal(resolveHarnessForStage('planning', { prefs }), 'p');
  assert.equal(resolveHarnessForStage('coding', { prefs }), 'c');
  assert.equal(resolveHarnessForStage('testing', { prefs }), 't');
  assert.equal(resolveHarnessForStage('deployment', { prefs }), 'd');
  // An unknown stage has no per-stage key, so it falls back to the default.
  assert.equal(resolveHarnessForStage('unknown-stage', { prefs }), 'default');
});

test('resolveHarnessForStage trims and ignores blank selections', () => {
  assert.equal(
    resolveHarnessForStage('coding', { requestSelection: '   ', prefs: { codeHarness: 'codex-sdk' } }),
    'codex-sdk'
  );
  assert.equal(
    resolveHarnessForStage('coding', { prefs: { codeHarness: '  ', agentRuntime: 'deepagent' } }),
    'deepagent'
  );
});

test('STAGE_HARNESS_PREF maps the four pipeline stages', () => {
  assert.deepEqual(STAGE_HARNESS_PREF, {
    planning: 'planHarness',
    coding: 'codeHarness',
    testing: 'testHarness',
    deployment: 'deployHarness',
  });
});

test('applyOperationalPrefs carries per-stage harness overrides onto run keys', () => {
  const steps = [];
  const next = applyOperationalPrefs(
    { agentRuntime: 'deepagent' },
    { codeHarness: 'codex-sdk', testHarness: 'claude-agent-sdk' },
    (m) => steps.push(m)
  );
  assert.equal(next.codeHarness, 'codex-sdk');
  assert.equal(next.testHarness, 'claude-agent-sdk');
  // Default is untouched, and unset stage keys are not invented.
  assert.equal(next.agentRuntime, 'deepagent');
  assert.equal(Object.hasOwn(next, 'planHarness'), false);
  assert.ok(steps.some((m) => m.includes('codeHarness')));
});

test('applyOperationalPrefs with no per-stage prefs is behavior-preserving', () => {
  const next = applyOperationalPrefs(
    { agentRuntime: 'deepagent', workflowPattern: 'sequential' },
    { agentRuntime: 'codex-sdk' }
  );
  assert.equal(next.agentRuntime, 'codex-sdk');
  assert.equal(next.workflowPattern, 'sequential');
  // No stage keys added when none were provided.
  for (const key of ['planHarness', 'codeHarness', 'testHarness', 'deployHarness']) {
    assert.equal(Object.hasOwn(next, key), false);
  }
});
