'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { findIssueLabel } = require('./linear');

/* ------------------------------ findIssueLabel -------------------------- */

const NODES = [
  { id: 'g1', name: 'Models', isGroup: true, parent: null },
  { id: 'c1', name: 'local', isGroup: false, parent: { id: 'g1' } },
  { id: 'c2', name: 'hosted', isGroup: false, parent: null },
  { id: 'l1', name: 'AI', isGroup: false, parent: null },
];

test('findIssueLabel matches by name case-insensitively', () => {
  assert.strictEqual(findIssueLabel(NODES, 'LOCAL').id, 'c1');
  assert.strictEqual(findIssueLabel(NODES, '  Hosted  ').id, 'c2');
});

test('findIssueLabel with group:true matches only group labels', () => {
  assert.strictEqual(findIssueLabel(NODES, 'Models', { group: true }).id, 'g1');
  // A non-group label of the same name must not match a group query.
  assert.strictEqual(findIssueLabel(NODES, 'local', { group: true }), null);
});

test('findIssueLabel with group:false excludes group labels', () => {
  assert.strictEqual(findIssueLabel(NODES, 'local', { group: false }).id, 'c1');
  assert.strictEqual(findIssueLabel(NODES, 'Models', { group: false }), null);
});

test('findIssueLabel returns null when absent and tolerates empty input', () => {
  assert.strictEqual(findIssueLabel(NODES, 'nope'), null);
  assert.strictEqual(findIssueLabel([], 'local'), null);
  assert.strictEqual(findIssueLabel(undefined, 'local'), null);
});

test('findIssueLabel surfaces a child parent id so callers can detect grouping', () => {
  const grouped = findIssueLabel(NODES, 'local', { group: false });
  assert.strictEqual(grouped.parent.id, 'g1');
  const flat = findIssueLabel(NODES, 'hosted', { group: false });
  assert.strictEqual(flat.parent, null);
});
