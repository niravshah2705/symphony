'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Isolate any store writes to a throwaway data dir BEFORE requiring modules that
// read config. The real data/store.json holds live secrets and must never be
// touched by tests.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-patch-test-'));
process.env.AI_FLEET_DATA_DIR = TMP_DATA;

const {
  sanitizeSettingsPatch,
  applySettingsPatch,
  snapshotEditable,
  describeEditableSettings,
  EDITABLE_KEYS,
} = require('./settings-patch');
const { getSettings } = require('../store');

test('sanitizeSettingsPatch accepts valid keys and coerces values', () => {
  const { patch, applied } = sanitizeSettingsPatch({
    agentRuntime: 'codex-sdk',
    workflowPattern: 'supervisor',
    langsmithTracing: false,
    llmProvider: 'ollama',
    ollamaTemperature: 5, // clamped to 2
    langsmithEndpoint: 'https://api.smith.langchain.com/', // trailing slash trimmed
  });
  assert.equal(patch.agentRuntime, 'codex-sdk');
  assert.equal(patch.workflowPattern, 'supervisor');
  assert.equal(patch.langsmithTracing, false);
  assert.equal(patch.ollamaTemperature, 2);
  assert.equal(patch.langsmithEndpoint, 'https://api.smith.langchain.com');
  assert.ok(applied.includes('agentRuntime'));
});

test('sanitizeSettingsPatch rejects invalid enum/provider values with reasons', () => {
  const { rejected } = sanitizeSettingsPatch({
    agentRuntime: 'not-a-runtime',
    workflowPattern: 'nope',
    byomProvider: 'codex', // not a BYoM provider
  });
  const keys = rejected.map((r) => r.key).sort();
  assert.deepEqual(keys, ['agentRuntime', 'byomProvider', 'workflowPattern']);
  for (const r of rejected) assert.equal(typeof r.reason, 'string');
});

test('sanitizeSettingsPatch ignores unknown, derived, and secret keys', () => {
  const { patch, ignored } = sanitizeSettingsPatch({
    hasKey: true,
    maskedKey: '****',
    planningConfigured: true,
    linearApiKey: 'lin_live_secret',
    langsmithApiKey: 'lsv2_secret',
    githubToken: 'ghp_secret',
    totallyUnknown: 1,
  });
  assert.deepEqual(patch, {});
  for (const key of ['hasKey', 'linearApiKey', 'langsmithApiKey', 'githubToken', 'totallyUnknown']) {
    assert.ok(ignored.includes(key), `${key} should be ignored`);
  }
});

test('EDITABLE_KEYS never exposes secret material', () => {
  const secrets = [
    'linearApiKey',
    'githubToken',
    'gitlabToken',
    'langsmithApiKey',
    'jiraApiToken',
    'asanaAccessToken',
    'omlxApiKey',
    'codexTokens',
    'claudeTokens',
  ];
  for (const secret of secrets) {
    assert.ok(!EDITABLE_KEYS.includes(secret), `${secret} must not be editable via JSON/tool`);
  }
});

test('snapshotEditable keeps only editable keys', () => {
  const snapshot = snapshotEditable({
    agentRuntime: 'deepagent',
    langsmithProject: 'demo',
    linearApiKey: 'secret',
    unknownKey: 'x',
  });
  assert.deepEqual(snapshot, { agentRuntime: 'deepagent', langsmithProject: 'demo' });
});

test('describeEditableSettings lists keys and harness enum mapping', () => {
  const text = describeEditableSettings();
  assert.match(text, /agentRuntime/);
  assert.match(text, /claude-agent-sdk=ClaudeCode/);
  assert.match(text, /langsmithTracing: true \| false/);
});

test('applySettingsPatch persists valid keys to the store and skips empty patches', () => {
  const outcome = applySettingsPatch({ agentRuntime: 'codex-sdk', langsmithTracing: false, hasKey: true });
  assert.deepEqual(outcome.applied.sort(), ['agentRuntime', 'langsmithTracing']);
  assert.equal(getSettings().agentRuntime, 'codex-sdk');
  assert.equal(getSettings().langsmithTracing, false);

  // A patch with no valid keys writes nothing and does not throw.
  const noop = applySettingsPatch({ linearApiKey: 'x', unknownKey: 1 });
  assert.equal(noop.applied.length, 0);
  assert.equal(getSettings().agentRuntime, 'codex-sdk');
});

test.after(() => {
  fs.rmSync(TMP_DATA, { recursive: true, force: true });
});
