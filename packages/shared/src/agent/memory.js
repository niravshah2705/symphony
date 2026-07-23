'use strict';

/**
 * Typed, persistent workspace memory. Five scopes carry durable facts the
 * omnibox can save and recall:
 *   user      — per-user preferences, role, and stated facts
 *   business  — durable decisions about a business
 *   project   — decisions/notes scoped to a project
 *   task      — notes/outcomes scoped to a task or issue
 *   workspace — global notes alongside reviewed documentation
 *
 * This module is deterministic: validation, scope detection, and lexical recall
 * run with no model call (mirroring workspace-router.js / knowledge-search.js).
 * Persistence lives in store.js (addMemory/listMemories/...). Writes from free
 * text are surfaced as a *draft* and confirmed by the user before saving.
 */

const MAX_QUERY_CHARS = 8_000;
const MAX_TITLE_CHARS = 160;
const MAX_TEXT_CHARS = 2_000;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 40;
const MAX_RESULTS = 8;
const TITLE_FROM_TEXT_CHARS = 60;
const REFID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MEMORY_SCOPES = Object.freeze(['user', 'business', 'project', 'task', 'workspace']);
const MEMORY_SOURCES = Object.freeze(['omnibox', 'business-pipeline', 'task', 'explicit']);

const STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'can', 'check', 'find', 'for', 'from', 'have',
  'into', 'look', 'our', 'please', 'recall', 'remember', 'save', 'search', 'show', 'that',
  'the', 'their', 'this', 'what', 'when', 'where', 'which', 'with', 'workspace', 'would', 'your',
]);

class MemoryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'MemoryError';
    this.status = status;
  }
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Boundary validation for a memory write. Returns ONLY the allowlisted fields —
 * an attacker-supplied `id`/`createdAt` cannot slip through (no mass assignment).
 */
function normalizeMemory(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new MemoryError('A memory object is required.');
  }
  const scope = String(body.scope || '').trim().toLowerCase();
  if (!MEMORY_SCOPES.includes(scope)) {
    throw new MemoryError(`scope must be one of: ${MEMORY_SCOPES.join(', ')}.`);
  }
  const text = cleanText(body.text, MAX_TEXT_CHARS);
  if (!text) throw new MemoryError('text is required.');

  let refId = null;
  if (body.refId != null && body.refId !== '') {
    refId = String(body.refId);
    if (!REFID_PATTERN.test(refId)) {
      throw new MemoryError('refId may contain only letters, numbers, "_" and "-" (max 64).');
    }
  }

  const title = cleanText(body.title, MAX_TITLE_CHARS) || text.slice(0, TITLE_FROM_TEXT_CHARS);
  const tags = Array.isArray(body.tags)
    ? [...new Set(body.tags.map((tag) => cleanText(tag, MAX_TAG_CHARS)).filter(Boolean))].slice(0, MAX_TAGS)
    : [];
  const source = MEMORY_SOURCES.includes(body.source) ? body.source : 'omnibox';
  return { scope, refId, title, text, tags, source };
}

// Keyword fallbacks, checked in priority order after explicit "<scope> memory".
const SCOPE_KEYWORDS = Object.freeze([
  ['user', /\b(?:remember (?:that )?i\b|i (?:prefer|like|want|always|usually|am|work)\b|my (?:name|role|preference|email|timezone|style|goal)\b|about me|remind me|note to self|for me)\b/i],
  ['task', /\b(?:tasks?|issues?|tickets?|stor(?:y|ies)|bugs?|backlog|sprint)\b/i],
  ['project', /\bprojects?\b/i],
  ['business', /\b(?:business|revenue|pricing|prices?|customers?|markets?|moneti[sz]\w*|sales|profit|margins?|go-to-market|startup|company)\b/i],
  ['workspace', /\b(?:docs?|documentation|readme|guides?|how (?:do|to)|wiki)\b/i],
]);

/** Deterministic scope inference. Returns a scope or 'all' when ambiguous. */
function detectMemoryScope(query) {
  const input = cleanText(query, MAX_QUERY_CHARS);
  if (!input) return 'all';
  const explicit = input.match(/\b(user|business|project|task|workspace)\s+memor(?:y|ies)\b/i);
  if (explicit) return explicit[1].toLowerCase();
  for (const [scope, pattern] of SCOPE_KEYWORDS) {
    if (pattern.test(input)) return scope;
  }
  return 'all';
}

const WRITE_TRIGGER = /\b(?:remember(?:\s+that)?|note to self|keep in mind|make a note(?:\s+that)?)\b/i;
const SCOPED_WRITE = /\bsave (?:this )?(?:to|in) (?:my |our |the )?(user|business|project|task|workspace) memor(?:y|ies)\s*[:\-]?\s*(.*)$/i;

/**
 * Recognize a "remember this" style write request and return a DRAFT
 * ({ scope, title, text }) for the user to confirm — this never persists.
 * Returns null when the input is a plain read/query.
 */
function detectMemoryWrite(input) {
  const text = cleanText(input, MAX_QUERY_CHARS);
  if (!text) return null;

  const scoped = text.match(SCOPED_WRITE);
  if (scoped) {
    return draft(scoped[1].toLowerCase(), cleanText(scoped[2], MAX_TEXT_CHARS) || text);
  }
  if (!WRITE_TRIGGER.test(text)) return null;

  const body = cleanText(
    text.replace(/^.*?\b(?:remember(?:\s+that)?|note to self|keep in mind|make a note(?:\s+that)?)\s*[:\-]?\s*/i, ''),
    MAX_TEXT_CHARS,
  ) || text;
  return draft(detectMemoryScope(text), body);
}

function draft(scope, body) {
  const scopeOut = MEMORY_SCOPES.includes(scope) ? scope : 'workspace';
  const text = body || '';
  return { scope: scopeOut, title: text.slice(0, TITLE_FROM_TEXT_CHARS) || 'Saved note', text };
}

function queryTerms(query) {
  return [...new Set(cleanText(query, MAX_QUERY_CHARS).toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || [])]
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term))
    .slice(0, 20);
}

function matchScore(text, terms) {
  const haystack = String(text || '').toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

/** Bounded lexical recall over stored memories, optionally filtered by scope. */
function searchMemories(query, memories, options = {}) {
  const scope = options.scope && options.scope !== 'all' ? options.scope : null;
  const terms = queryTerms(query);
  const pool = (Array.isArray(memories) ? memories : []).filter((memory) => !scope || memory.scope === scope);
  return pool
    .map((memory, index) => ({
      id: memory.id,
      scope: memory.scope,
      refId: memory.refId || null,
      type: `Memory · ${memory.scope}`,
      title: memory.title || 'Memory',
      summary: cleanText(memory.text, 320),
      status: memory.source || 'Saved',
      score: matchScore(`${memory.title} ${memory.text} ${(memory.tags || []).join(' ')}`, terms),
      index,
    }))
    .filter((record) => !terms.length || record.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_RESULTS)
    .map(({ index, ...record }) => record);
}

module.exports = {
  MAX_QUERY_CHARS,
  MAX_TEXT_CHARS,
  MAX_RESULTS,
  MEMORY_SCOPES,
  MEMORY_SOURCES,
  MemoryError,
  normalizeMemory,
  detectMemoryScope,
  detectMemoryWrite,
  searchMemories,
};
