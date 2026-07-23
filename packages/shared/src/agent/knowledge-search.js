'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MAX_QUERY_CHARS = 8_000;
const MAX_FILES = 80;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 8;
const ALLOWED_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'can', 'check', 'find', 'for', 'from', 'have',
  'into', 'look', 'our', 'please', 'search', 'show', 'that', 'the', 'their', 'this', 'what',
  'when', 'where', 'which', 'with', 'workspace', 'would', 'your',
]);

class KnowledgeSearchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'KnowledgeSearchError';
    this.status = status;
  }
}

function normalizeQuery(value) {
  if (typeof value !== 'string') throw new KnowledgeSearchError('query must be a string.');
  const query = value.replace(/\s+/g, ' ').trim();
  if (!query) throw new KnowledgeSearchError('Describe what you want to find.');
  if (query.length > MAX_QUERY_CHARS) throw new KnowledgeSearchError(`query must be ${MAX_QUERY_CHARS.toLocaleString()} characters or fewer.`);
  return query;
}

function queryTerms(query) {
  return [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || [])]
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term))
    .slice(0, 20);
}

function collectDocumentPaths(root) {
  const resolvedRoot = path.resolve(root);
  const files = [];
  const addFile = (candidate) => {
    if (files.length >= MAX_FILES) return;
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (_) {
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return;
    if (!ALLOWED_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return;
    const resolved = path.resolve(candidate);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) return;
    files.push({ absolute: resolved, relative: path.relative(resolvedRoot, resolved), size: stat.size });
  };
  addFile(path.join(resolvedRoot, 'README.md'));

  const walk = (directory, depth) => {
    if (depth > 3 || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(candidate, depth + 1);
      else if (entry.isFile()) addFile(candidate);
    }
  };
  walk(path.join(resolvedRoot, 'docs'), 0);
  return files;
}

function documentTitle(lines, relative) {
  const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line));
  return heading ? heading.replace(/^#{1,3}\s+/, '').trim().slice(0, 160) : path.basename(relative, path.extname(relative));
}

function cleanSnippet(lines, index) {
  return lines
    .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 520);
}

function scoreLine(line, terms, phrase) {
  const lower = line.toLowerCase();
  const termScore = terms.reduce((score, term) => score + (lower.includes(term) ? 2 : 0), 0);
  return termScore + (phrase.length >= 5 && lower.includes(phrase) ? 5 : 0);
}

/** Bounded lexical search over reviewed workspace documentation only. */
function searchDocuments(value, options = {}) {
  const query = normalizeQuery(value);
  const terms = queryTerms(query);
  if (!terms.length) return { query, indexedFiles: 0, results: [] };
  const paths = collectDocumentPaths(options.root || DEFAULT_ROOT);
  let totalBytes = 0;
  const matches = [];
  for (const file of paths) {
    if (totalBytes + file.size > MAX_TOTAL_BYTES) break;
    totalBytes += file.size;
    let text;
    try {
      text = fs.readFileSync(file.absolute, 'utf8');
    } catch (_) {
      continue;
    }
    const lines = text.split(/\r?\n/);
    let best = null;
    for (let index = 0; index < lines.length; index += 1) {
      const score = scoreLine(lines[index], terms, query.toLowerCase());
      if (score > 0 && (!best || score > best.score)) best = { score, index };
    }
    if (!best) continue;
    matches.push({
      type: 'Workspace document',
      title: documentTitle(lines, file.relative),
      path: file.relative.split(path.sep).join('/'),
      snippet: cleanSnippet(lines, best.index),
      score: best.score,
    });
  }
  const limit = Math.min(MAX_RESULTS, Math.max(1, Number(options.limit) || MAX_RESULTS));
  return {
    query,
    indexedFiles: paths.length,
    results: matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit),
  };
}

module.exports = {
  DEFAULT_ROOT,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  KnowledgeSearchError,
  normalizeQuery,
  collectDocumentPaths,
  searchDocuments,
};
