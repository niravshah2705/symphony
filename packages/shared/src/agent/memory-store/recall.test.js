'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { recallMemories, cosine } = require('./recall');

const MEMORIES = [
  { id: 'm1', scope: 'project', title: 'Database', text: 'We use Firestore for durable state', tags: [] },
  { id: 'm2', scope: 'project', title: 'Auth', text: 'Google One Tap handles sign-in', tags: [] },
  { id: 'm3', scope: 'task', title: 'Deploy', text: 'Cloud Run scales to zero', tags: [] },
];

test('cosine handles empty/mismatched/zero vectors', () => {
  assert.equal(cosine([], []), 0);
  assert.equal(cosine([1, 2], [1]), 0);
  assert.equal(cosine([0, 0], [0, 0]), 0);
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
});

test('lexical-only recall ranks by term overlap when no query vector', () => {
  const hits = recallMemories({ query: 'firestore durable state', queryVector: null, memories: MEMORIES, limit: 2 });
  assert.equal(hits[0].id, 'm1');
});

test('scope restricts the candidate pool', () => {
  const hits = recallMemories({ query: 'scales to zero', queryVector: null, memories: MEMORIES, scope: 'task' });
  assert.deepEqual(hits.map((m) => m.id), ['m3']);
});

test('vector similarity dominates the blend when embeddings are present', () => {
  const vectors = { m1: [1, 0, 0], m2: [0, 1, 0], m3: [0, 0, 1] };
  const hits = recallMemories({
    query: 'unrelated words',            // no lexical overlap
    queryVector: [0, 1, 0],              // closest to m2
    memories: MEMORIES,
    limit: 1,
    loadVector: (m) => vectors[m.id],
  });
  assert.equal(hits[0].id, 'm2');
});

test('empty pool returns nothing', () => {
  assert.deepEqual(recallMemories({ query: 'x', queryVector: null, memories: [] }), []);
});
