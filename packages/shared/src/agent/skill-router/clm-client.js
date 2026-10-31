'use strict';

/**
 * Client for internal CLM (Contrastive Language Model) inference service.
 * Performs dual-encoder contrastive candidate routing with latency-bounded timeout.
 */

const { CONFIG } = require('../../config');

async function routeWithClm(prompt, candidates = [], options = {}) {
  const baseUrl = options.baseUrl || options.endpoint || CONFIG.clmUrl || process.env.CLM_INFERENCE_URL || 'http://localhost:8089';
  const timeoutMs = options.timeoutMs || CONFIG.skillRouter?.timeoutMs || 150;
  const topK = options.topK || CONFIG.skillRouter?.topK || 3;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/route`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
      },
      body: JSON.stringify({
        query: prompt,
        candidates: candidates.map((c) => ({
          id: c.id,
          name: c.name || c.id,
          description: c.description || c.id,
        })),
        top_k: topK,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`CLM inference service returned status ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data.selected_ids)
      ? data.selected_ids
      : (Array.isArray(data.selected_skills) ? data.selected_skills : []);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`CLM inference timeout exceeded ${timeoutMs}ms SLA`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { routeWithClm };
