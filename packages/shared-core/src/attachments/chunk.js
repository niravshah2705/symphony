'use strict';

const CHUNK_SIZE = 1_500;
const CHUNK_OVERLAP = 200;
const MAX_CHUNKS_PER_ATTACHMENT = 500; // bounds embedding-call cost/latency on pathological files

/** Fixed-size character windows with overlap — deliberately not semantic/sentence-aware. */
function chunkText(text, { chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP, maxChunks = MAX_CHUNKS_PER_ATTACHMENT } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return { chunks: [], truncated: false };

  const safeOverlap = Math.min(overlap, chunkSize - 1); // guards against a zero-progress infinite loop
  const chunks = [];
  let start = 0;
  while (start < clean.length && chunks.length < maxChunks) {
    const end = Math.min(start + chunkSize, clean.length);
    chunks.push(clean.slice(start, end));
    if (end >= clean.length) break;
    start = end - safeOverlap;
  }

  const truncated = chunks.length >= maxChunks && start < clean.length;
  return { chunks, truncated };
}

module.exports = { chunkText, CHUNK_SIZE, CHUNK_OVERLAP, MAX_CHUNKS_PER_ATTACHMENT };
