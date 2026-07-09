'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { providerForRole } = require('./llm');
const { modelRoleForTask } = require('./coder-orchestrator');
const { PlanSchema, normalizeTshirtSize } = require('./schema');
const { CONFIG } = require('../config');

/* ----------------------------- providerForRole ------------------------- */

test('providerForRole: global role uses the hosted slot (llmProvider)', () => {
  assert.strictEqual(providerForRole({ llmProvider: 'claude', localLlmProvider: 'lmstudio' }, 'global'), 'claude');
});

test('providerForRole: local role uses the local slot (localLlmProvider)', () => {
  assert.strictEqual(providerForRole({ llmProvider: 'claude', localLlmProvider: 'lmstudio' }, 'local'), 'lmstudio');
});

test('providerForRole: default role is global', () => {
  assert.strictEqual(providerForRole({ llmProvider: 'codex', localLlmProvider: 'ollama' }), 'codex');
});

test('providerForRole: local falls back to global, then ollama', () => {
  assert.strictEqual(providerForRole({ llmProvider: 'codex' }, 'local'), 'codex');
  assert.strictEqual(providerForRole({}, 'local'), 'ollama');
});

/* ----------------------------- modelRoleForTask ------------------------ */

const LOCAL = CONFIG.CODER.localModelLabel;
const HOSTED = CONFIG.CODER.hostedModelLabel;

test('modelRoleForTask: a "local" label routes to the local slot', () => {
  assert.strictEqual(modelRoleForTask({ labels: ['AI', LOCAL] }), 'local');
});

test('modelRoleForTask: a "hosted" label routes to the global slot', () => {
  assert.strictEqual(modelRoleForTask({ labels: ['AI', HOSTED] }), 'global');
});

test('modelRoleForTask: no model label defaults to global (hosted)', () => {
  assert.strictEqual(modelRoleForTask({ labels: ['AI'] }), 'global');
  assert.strictEqual(modelRoleForTask({}), 'global');
});

test('modelRoleForTask: model label match is case-insensitive', () => {
  assert.strictEqual(modelRoleForTask({ labels: [LOCAL.toUpperCase()] }), 'local');
});

/* --------------------------- schema: tshirtSize ------------------------- */

function planWith(issue) {
  return PlanSchema.parse({
    description: 'a valid design overview',
    milestones: [{ name: 'M1', startDate: '2026-01-01', targetDate: '2026-02-01', issues: [issue] }],
  });
}

test('PlanSchema: a missing tshirtSize defaults to M', () => {
  const plan = planWith({ title: 'Build the thing' });
  assert.strictEqual(plan.milestones[0].issues[0].tshirtSize, 'M');
});

test('PlanSchema: keeps a messy tshirtSize (clamped later at write time)', () => {
  const plan = planWith({ title: 'Build the thing', tshirtSize: ' xs ' });
  assert.strictEqual(plan.milestones[0].issues[0].tshirtSize, ' xs ');
});

test('normalizeTshirtSize: trims/uppercases valid sizes and defaults unknown to M', () => {
  assert.strictEqual(normalizeTshirtSize(' xs '), 'XS');
  assert.strictEqual(normalizeTshirtSize('L'), 'L');
  assert.strictEqual(normalizeTshirtSize('HUGE'), 'M');
  assert.strictEqual(normalizeTshirtSize(''), 'M');
  assert.strictEqual(normalizeTshirtSize(undefined), 'M');
});
