'use strict';

const { CONFIG } = require('../config');
const { SENTINEL_TOKEN, projectEgressHeaders } = require('../egress');

// text-embedding-004 (named in earlier design notes) was deprecated 2026-01-14;
// gemini-embedding-001 is its documented replacement and, via Matryoshka
// Representation Learning, explicitly supports truncating to 768 dimensions
// (embedContentConfig.outputDimensionality) — kept at 768 to match the
// Firestore vector index dimension below, not the model's 3072-dim default.
const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMENSION = 768;
const MAX_TEXTS_PER_BATCH = 100; // bounds latency/call count for large attachments

function batchOf(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Embed a batch of text chunks via Gemini's embedding model, routed through the
 * same egress-proxied base URL as the antigravity harness's native genai calls
 * (CONFIG.ANTIGRAVITY.nativeBaseUrl) — proxied (sentinel token) or direct
 * (real apiKey) depending on deployment, exactly like every other provider call.
 */
async function embedTexts(texts, { apiKey, workspaceContext, fetchImpl = fetch } = {}) {
  if (!texts.length) return [];
  const vectors = [];
  for (const batch of batchOf(texts, MAX_TEXTS_PER_BATCH)) {
    const headers = { 'content-type': 'application/json', ...projectEgressHeaders(workspaceContext) };
    headers['x-goog-api-key'] = CONFIG.EGRESS_PROXY_URL ? SENTINEL_TOKEN : apiKey;
    const url = `${CONFIG.ANTIGRAVITY.nativeBaseUrl}/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`;
    const body = {
      requests: batch.map((text) => ({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        embedContentConfig: { outputDimensionality: EMBEDDING_DIMENSION },
      })),
    };
    const resp = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`embeddings request failed (${resp.status}): ${detail.slice(0, 300)}`);
    }
    const data = await resp.json();
    for (const embedding of data.embeddings || []) vectors.push(embedding.values);
  }
  return vectors;
}

module.exports = { embedTexts, EMBEDDING_MODEL, EMBEDDING_DIMENSION, MAX_TEXTS_PER_BATCH };
