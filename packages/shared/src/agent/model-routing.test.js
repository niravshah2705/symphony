'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { providerForRole } = require('./llm');
const { modelRoleForTask } = require('./coder-orchestrator');
const { PlanSchema, normalizeTshirtSize } = require('./schema');
const { CONFIG } = require('../config');

/* ----------------------------- providerForRole ------------------------- */

test('providerForRole: global role uses the hosted slot (llmProvider)', () => {
  assert.strictEqual(providerForRole({ llmProvider: 'claude', byomProvider: 'lmstudio' }, 'global'), 'claude');
});

test('providerForRole: byom role uses the BYoM slot (byomProvider)', () => {
  assert.strictEqual(providerForRole({ llmProvider: 'claude', byomProvider: 'lmstudio' }, 'byom'), 'lmstudio');
});

test('providerForRole: legacy "local" role alias still reads the BYoM slot', () => {
  assert.strictEqual(providerForRole({ llmProvider: 'claude', byomProvider: 'lmstudio' }, 'local'), 'lmstudio');
});

test('providerForRole: default role is global', () => {
  assert.strictEqual(providerForRole({ llmProvider: 'codex', byomProvider: 'ollama' }), 'codex');
});

test('providerForRole: byom falls back to global, then ollama', () => {
  assert.strictEqual(providerForRole({ llmProvider: 'codex' }, 'byom'), 'codex');
  assert.strictEqual(providerForRole({}, 'byom'), 'ollama');
});

test('providerForRole: purpose roles read their own provider slot', () => {
  const settings = {
    llmProvider: 'claude',
    thinkingLlmProvider: 'codex',
    executionLlmProvider: 'ollama',
    testingLlmProvider: 'lmstudio',
    deploymentLlmProvider: 'claude',
  };
  assert.strictEqual(providerForRole(settings, 'thinking'), 'codex');
  assert.strictEqual(providerForRole(settings, 'execution'), 'ollama');
  assert.strictEqual(providerForRole(settings, 'testing'), 'lmstudio');
  assert.strictEqual(providerForRole(settings, 'deployment'), 'claude');
});

test('providerForRole: purpose roles fall back to the hosted slot, then ollama', () => {
  assert.strictEqual(providerForRole({ llmProvider: 'claude' }, 'thinking'), 'claude');
  assert.strictEqual(providerForRole({ llmProvider: 'codex' }, 'execution'), 'codex');
  assert.strictEqual(providerForRole({}, 'testing'), 'ollama');
  assert.strictEqual(providerForRole({}, 'deployment'), 'ollama');
});

/* ----------------------------- modelRoleForTask ------------------------ */

const LOCAL = CONFIG.CODER.localModelLabel;
const HOSTED = CONFIG.CODER.hostedModelLabel;

// Model selection is now purpose-based: the coder always uses the `execution`
// role regardless of a task's size or legacy "local"/"hosted" model label.
test('modelRoleForTask: always routes the coder to the execution role', () => {
  assert.strictEqual(modelRoleForTask({ labels: ['AI', LOCAL] }), 'execution');
  assert.strictEqual(modelRoleForTask({ labels: ['AI', HOSTED] }), 'execution');
  assert.strictEqual(modelRoleForTask({ labels: ['AI'] }), 'execution');
  assert.strictEqual(modelRoleForTask({}), 'execution');
  assert.strictEqual(modelRoleForTask({ labels: [LOCAL.toUpperCase()] }), 'execution');
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
