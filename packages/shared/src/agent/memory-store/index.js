'use strict';

/**
 * Memory backend selector — the single seam the MemoryMiddleware writes/reads
 * through. Mirrors the store.js backend switch:
 *
 *   MEMORY_DATABASE_URL set → the Cloud SQL for PostgreSQL backend (memory.tf),
 *                             with per-memory embeddings + blended
 *                             vector/lexical recall.
 *   MEMORY_DATABASE_URL not set → fall back to the existing Firestore/file
 *                             `memories` store (store.js addMemory/listMemories)
 *                             so local dev works without a database —
 *                             lexical-only recall (no vectors).
 *
 * Every method is async + fails open (returns a benign empty/null) so a storage
 * defect can never fail an agent run.
 */

const postgres = require('./postgres-backend');
const { recallMemories } = require('./recall');

function storeBackend() {
  return require('@ai-fleet/shared-core/store');
}

function isPostgresActive(env = process.env) {
  return postgres.isConfigured(env);
}

/** Persist one memory record (with an optional `embedding`). */
async function persist(record, { context, env = process.env } = {}) {
  try {
    if (isPostgresActive(env)) {
      return await postgres.persist(record, { context, env });
    }
    // The JSON/Firestore store has no vector column — drop the embedding.
    const { embedding, ...rest } = record || {};
    return storeBackend().addMemory(rest);
  } catch (_) {
    return null;
  }
}

/** Newest-first candidate memories for the current workspace tenant. */
async function load({ context, scope, limit, env = process.env } = {}) {
  try {
    if (isPostgresActive(env)) {
      return await postgres.load({ context, scope, limit, env });
    }
    return storeBackend().listMemories(scope ? { scope } : {});
  } catch (_) {
    return [];
  }
}

/**
 * Blended recall over the active backend. Accepts a pre-loaded `memories` list to
 * avoid a second scan; otherwise loads it. Postgres rows carry their vector; the
 * Firestore/file fallback is lexical-only.
 */
async function recall({ query, queryVector, context, scope, limit, memories, env = process.env } = {}) {
  try {
    const pool = Array.isArray(memories) ? memories : await load({ context, scope, env });
    const loadVector = isPostgresActive(env)
      ? (memory) => postgres.decodeVector(memory && memory.embedding)
      : () => null;
    return recallMemories({ query, queryVector, memories: pool, scope, limit, loadVector });
  } catch (_) {
    return [];
  }
}

module.exports = { isPostgresActive, persist, load, recall };
