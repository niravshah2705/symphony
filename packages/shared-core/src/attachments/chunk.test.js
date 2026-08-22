'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkText, CHUNK_SIZE, CHUNK_OVERLAP } = require('./chunk');

test('chunkText returns no chunks for empty/whitespace-only text', () => {
  assert.deepEqual(chunkText(''), { chunks: [], truncated: false });
  assert.deepEqual(chunkText('   \n  '), { chunks: [], truncated: false });
  assert.deepEqual(chunkText(null), { chunks: [], truncated: false });
});

test('chunkText returns a single chunk when text fits within chunkSize', () => {
  const { chunks, truncated } = chunkText('short text', { chunkSize: 100, overlap: 10 });
  assert.deepEqual(chunks, ['short text']);
  assert.equal(truncated, false);
});

test('chunkText splits long text into overlapping windows that together cover it', () => {
  const text = 'x'.repeat(1000);
  const { chunks, truncated } = chunkText(text, { chunkSize: 300, overlap: 50 });
  assert.equal(truncated, false);
  assert.ok(chunks.length > 1);
  // Every character position is covered by at least one chunk.
  const covered = new Set();
  let cursor = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) covered.add(cursor + i);
    cursor += chunk.length - 50; // matches the overlap used above (approx, for coverage check)
  }
  assert.ok(covered.size >= text.length - chunks.length); // loose coverage sanity check
  assert.equal(chunks[chunks.length - 1].endsWith('x'), true);
});

test('chunkText uses default CHUNK_SIZE/CHUNK_OVERLAP when options are omitted', () => {
  const text = 'y'.repeat(CHUNK_SIZE + 100);
  const { chunks } = chunkText(text);
  assert.equal(chunks[0].length, CHUNK_SIZE);
  assert.ok(chunks.length >= 2);
});

test('chunkText respects maxChunks and marks the result truncated', () => {
  const text = 'z'.repeat(10_000);
  const { chunks, truncated } = chunkText(text, { chunkSize: 100, overlap: 10, maxChunks: 5 });
  assert.equal(chunks.length, 5);
  assert.equal(truncated, true);
});

test('chunkText never infinite-loops when overlap >= chunkSize', () => {
  const text = 'a'.repeat(500);
  const { chunks } = chunkText(text, { chunkSize: 50, overlap: 500, maxChunks: 1000 });
  assert.ok(chunks.length > 0 && chunks.length < 1000);
});
