'use strict';

const log = require('../logger');

/**
 * Keyless web search via DuckDuckGo's HTML endpoint. Best-effort: returns [] on
 * any failure so planning degrades gracefully. Results are untrusted content —
 * callers must fence them as data before sending to the LLM (prompt-injection).
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function stripHtml(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Run a web search and return up to `limit` snippet strings.
 * @returns {Promise<string[]>}
 */
async function webSearch(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      log.warn(`web search failed (${resp.status}) for "${q.slice(0, 60)}"`);
      return [];
    }
    const html = await resp.text();
    const snippets = [...html.matchAll(/result__snippet[^>]*>(.*?)<\/a>/gis)]
      .map((m) => stripHtml(m[1]))
      .filter((s) => s.length > 20)
      .slice(0, limit);
    return snippets;
  } catch (err) {
    log.warn(`web search error for "${q.slice(0, 60)}": ${err && err.message ? err.message : err}`);
    return [];
  }
}

/**
 * Run several searches concurrently. Returns one entry per query (order
 * preserved). Blank queries are dropped. Each search fails independently.
 * @returns {Promise<Array<{ query: string, snippets: string[] }>>}
 */
async function webSearchMany(queries, limit = 5) {
  const list = (Array.isArray(queries) ? queries : [queries])
    .map((q) => String(q || '').trim())
    .filter(Boolean);
  const results = await Promise.all(list.map((q) => webSearch(q, limit)));
  return list.map((q, i) => ({ query: q, snippets: results[i] }));
}

/** Fenced, numbered text block of search results — safe to inline in a prompt. */
function formatResults(snippets) {
  if (!snippets.length) return '(no web results)';
  return snippets.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

module.exports = { webSearch, webSearchMany, formatResults };
