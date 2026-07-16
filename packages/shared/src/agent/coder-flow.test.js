'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseVerdict } = require('./coder-orchestrator');
const { activeRepositoryBranch, assertOpenSweRepositoryProvider } = require('./coder');
const { pickStateByType } = require('../linear');

/* ------------------------------ parseVerdict ---------------------------- */

test('parseVerdict reads a fenced verdict JSON block (completed)', () => {
  const text = 'Implemented and validated.\n\n```verdict\n{"status": "completed", "reason": "All acceptance criteria met."}\n```';
  const v = parseVerdict(text);
  assert.strictEqual(v.status, 'completed');
  assert.strictEqual(v.reason, 'All acceptance criteria met.');
});

test('parseVerdict reads an insufficient JSON verdict with its reason', () => {
  const v = parseVerdict('{"status":"insufficient","reason":"No repository configured for this project."}');
  assert.strictEqual(v.status, 'insufficient');
  assert.strictEqual(v.reason, 'No repository configured for this project.');
});

test('parseVerdict extracts the merged PR URL when completed', () => {
  const text = '```verdict\n{"status":"completed","reason":"Merged.","pr":"https://github.com/acme/app/pull/42"}\n```';
  const v = parseVerdict(text);
  assert.strictEqual(v.status, 'completed');
  assert.strictEqual(v.pr, 'https://github.com/acme/app/pull/42');
});

test('parseVerdict leaves pr null when absent', () => {
  assert.strictEqual(parseVerdict('{"status":"completed","reason":"done"}').pr, null);
  assert.strictEqual(parseVerdict('VERDICT: completed — done').pr, null);
});

test('parseVerdict accepts a plain VERDICT: line', () => {
  const v = parseVerdict('Work done.\nVERDICT: completed — shipped and green.');
  assert.strictEqual(v.status, 'completed');
  assert.strictEqual(v.reason, 'shipped and green.');
});

test('parseVerdict normalizes case in the status field', () => {
  const v = parseVerdict('{"status":"Completed","reason":"done"}');
  assert.strictEqual(v.status, 'completed');
});

test('parseVerdict defaults to insufficient when no verdict is present', () => {
  const v = parseVerdict('I finished the task and it looks great.');
  assert.strictEqual(v.status, 'insufficient');
  assert.match(v.reason, /did not emit/i);
});

test('parseVerdict defaults to insufficient on empty/nullish input', () => {
  assert.strictEqual(parseVerdict('').status, 'insufficient');
  assert.strictEqual(parseVerdict(undefined).status, 'insufficient');
});

test('OpenSWE fails closed for a GitLab repository selection', () => {
  assert.doesNotThrow(() => assertOpenSweRepositoryProvider('github'));
  assert.throws(() => assertOpenSweRepositoryProvider('gitlab'), /GitHub-only/);
});

test('coder results report the broker branch after an automatic retry rotation', () => {
  const broker = { publicInfo: () => ({ branch: 'task-123-retry-17' }) };
  assert.strictEqual(activeRepositoryBranch('task-123', broker), 'task-123-retry-17');
  assert.strictEqual(activeRepositoryBranch('task-123', null), 'task-123');
});

/* ----------------------------- pickStateByType -------------------------- */

const STATES = [
  { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 's-prog', name: 'In Progress', type: 'started', position: 2 },
  { id: 's-review', name: 'In Review', type: 'started', position: 3 },
  { id: 's-done', name: 'Done', type: 'completed', position: 4 },
];

test('pickStateByType prefers the state whose name matches', () => {
  assert.strictEqual(pickStateByType(STATES, 'started', 'In Progress').id, 's-prog');
});

test('pickStateByType falls back to the lowest-position state of the type', () => {
  // No "Working" name match → lowest-position started state (In Progress @2).
  assert.strictEqual(pickStateByType(STATES, 'started', 'Working').id, 's-prog');
});

test('pickStateByType resolves the completed (Done) state', () => {
  assert.strictEqual(pickStateByType(STATES, 'completed', 'Done').id, 's-done');
});

test('pickStateByType returns null when no state of the type exists', () => {
  assert.strictEqual(pickStateByType(STATES, 'canceled', 'Canceled'), null);
});
