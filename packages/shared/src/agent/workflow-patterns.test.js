'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { catalog, patternId, validateWorkflowPattern } = require('./workflow-patterns');
const { workflowPatternCatalog: runtimeWorkflowPatternCatalog } = require('./runtimes');

test('workflow catalog exposes the four supported bounded patterns', () => {
  assert.deepEqual(catalog().map((pattern) => pattern.id), [
    'sequential',
    'parallel',
    'evaluator',
    'supervisor',
  ]);
  assert.equal(patternId('parallel/fan-out'), 'parallel');
  assert.equal(patternId('evaluator/retry'), 'evaluator');
  assert.equal(patternId('supervisor/handoff'), 'supervisor');
  assert.equal(catalog().every((pattern) => pattern.description && pattern.steps.length === 3), true);
  assert.deepEqual(catalog().map((pattern) => pattern.id), runtimeWorkflowPatternCatalog().map((pattern) => pattern.id));
});

test('valid workflow definitions are normalized with bounded defaults', () => {
  assert.deepEqual(validateWorkflowPattern({
    pattern: 'sequential',
    config: { steps: ['Understand request', 'Implement', 'Verify'] },
  }), {
    valid: true,
    errors: [],
    workflow: {
      patternId: 'sequential',
      config: { steps: ['Understand request', 'Implement', 'Verify'] },
    },
  });

  const evaluator = validateWorkflowPattern({
    patternId: 'evaluator',
    config: { worker: 'Builder', evaluator: 'Reviewer' },
  });
  assert.equal(evaluator.valid, true);
  assert.equal(evaluator.workflow.config.maxAttempts, 3);

  const supervisor = validateWorkflowPattern({
    patternId: 'supervisor',
    config: { supervisor: 'Lead', specialists: ['Researcher', 'Engineer'] },
  });
  assert.equal(supervisor.valid, true);
  assert.equal(supervisor.workflow.config.maxHandoffs, 6);
});

test('workflow validation rejects unknown, duplicate, unbounded, and conflicting definitions', () => {
  assert.equal(validateWorkflowPattern({ pattern: 'arbitrary-code' }).valid, false);

  const parallel = validateWorkflowPattern({
    pattern: 'parallel/fan-out',
    branches: ['Research', 'research'],
  });
  assert.equal(parallel.valid, false);
  assert.match(parallel.errors.join(' '), /unique/);

  const evaluator = validateWorkflowPattern({
    pattern: 'evaluator/retry',
    worker: 'Same agent',
    evaluator: 'Same agent',
    maxAttempts: 99,
  });
  assert.equal(evaluator.valid, false);
  assert.match(evaluator.errors.join(' '), /different agents/);
  assert.match(evaluator.errors.join(' '), /1 to 5/);

  const supervisor = validateWorkflowPattern({
    pattern: 'supervisor/handoff',
    supervisor: 'Lead',
    specialists: ['Lead', 'Engineer'],
  });
  assert.equal(supervisor.valid, false);
  assert.match(supervisor.errors.join(' '), /must not also appear/);
});
