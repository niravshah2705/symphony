'use strict';

/**
 * Memory backend selector — the single seam the MemoryMiddleware writes/reads
 * through. Mirrors the store.js file-vs-firestore backend switch:
 *
 *   MEMORY_ROOT set  → the write-once on-disk (gcsfuse managed disk) backend,
 *                      with per-memory embeddings + blended vector/lexical recall.
 *   MEMORY_ROOT unset → fall back to the existing Firestore/file `memories`
 *                      store (store.js addMemory/listMemories) so local dev and a
 *                      disabled mount still work — lexical-only recall (no vectors).
 *
 * Every method fails open (returns a benign empty/null) so a storage defect can
 * never fail an agent run.
 */

const { resolveMemorySrc } = require('./paths');
const disk = require('./disk-backend');
const { recallMemories } = require('./recall');

function storeBackend() {
  return require('@ai-fleet/shared-core/store');
}

function isDiskActive(env = process.env) {
  return Boolean(resolveMemorySrc(env));
}

/** Persist one memory record (with an optional `embedding`). */
function persist(record, { context, env = process.env } = {}) {
  try {
    if (isDiskActive(env)) {
      return disk.writeMemory(record, { src: resolveMemorySrc(env), context });
    }
    // The JSON/Firestore store has no vector column — drop the embedding.
    const { embedding, path, ...rest } = record || {};
    return storeBackend().addMemory(rest);
  } catch (_) {
    return null;
  }
}

/** Newest-first candidate memories for the current workspace tenant. */
function load({ context, scope, limit, env = process.env } = {}) {
  try {
    if (isDiskActive(env)) {
      return disk.listMemories({ src: resolveMemorySrc(env), context, scope, limit });
    }
    return storeBackend().listMemories(scope ? { scope } : {});
  } catch (_) {
    return [];
  }
}

/**
 * Blended recall over the active backend. Accepts a pre-loaded `memories` list to
 * avoid a second scan; otherwise loads it. Disk supplies vectors; the fallback is
 * lexical-only.
 */
function recall({ query, queryVector, context, scope, limit, memories, env = process.env } = {}) {
  try {
    const pool = Array.isArray(memories) ? memories : load({ context, scope, env });
    const loadVector = isDiskActive(env)
      ? (memory) => (memory && memory.path ? disk.readVector(memory.path) : null)
      : () => null;
    return recallMemories({ query, queryVector, memories: pool, scope, limit, loadVector });
  } catch (_) {
    return [];
  }
}

module.exports = { isDiskActive, persist, load, recall };
