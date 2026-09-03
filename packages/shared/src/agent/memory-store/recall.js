'use strict';

/**
 * Rank memories by a blend of lexical overlap (the existing deterministic
 * `memory.js` searchMemories — the FTS-equivalent) and, when embeddings are
 * available, in-process cosine similarity (the Chroma-equivalent). Pure and
 * deterministic given its inputs; `loadVector(memory)` is injected so the disk
 * backend supplies vectors and the Firestore/file fallback (no vectors) degrades
 * to lexical-only.
 */

const { searchMemories } = require('../memory');

// Vector when present dominates; lexical always contributes a little.
const VECTOR_WEIGHT = 0.65;
const LEXICAL_WEIGHT = 0.35;

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * @param {object} args
 * @param {string} args.query           the incoming prompt
 * @param {number[]|null} args.queryVector  embedded query (null → lexical-only)
 * @param {Array} args.memories         candidate records (each needs id/scope/title/text)
 * @param {string} [args.scope]         restrict to one memory scope
 * @param {number} [args.limit]         top-K to return (default 5)
 * @param {(memory:object)=>number[]|null} [args.loadVector]
 * @returns {Array} the top-K memory records, highest score first
 */
function recallMemories({ query, queryVector, memories, scope, limit = 5, loadVector }) {
  const pool = Array.isArray(memories) ? memories : [];
  if (!pool.length) return [];

  const lexical = new Map();
  for (const hit of searchMemories(query, pool, { scope })) lexical.set(hit.id, hit.score || 0);
  const maxLex = Math.max(1, ...lexical.values());
  const hasVector = Array.isArray(queryVector) && queryVector.length > 0 && typeof loadVector === 'function';
  const inScope = scope ? pool.filter((m) => m.scope === scope) : pool;

  return inScope
    .map((memory) => {
      const lexNorm = (lexical.get(memory.id) || 0) / maxLex;
      let cos = 0;
      if (hasVector) {
        const vector = loadVector(memory);
        cos = vector ? Math.max(0, cosine(queryVector, vector)) : 0;
      }
      const score = hasVector ? VECTOR_WEIGHT * cos + LEXICAL_WEIGHT * lexNorm : lexNorm;
      return { memory, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number.isFinite(limit) ? limit : 5))
    .map((entry) => entry.memory);
}

module.exports = { recallMemories, cosine, VECTOR_WEIGHT, LEXICAL_WEIGHT };
