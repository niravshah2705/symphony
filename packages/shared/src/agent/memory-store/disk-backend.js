'use strict';

/**
 * Write-once, gcsfuse-safe on-disk memory backend.
 *
 * gcsfuse has NO partial-write / file-locking support (a rewrite replaces the
 * whole object) and Cloud Run gen2 fuse mounts are fragile — so every memory is
 * a fresh pair of write-once objects and there is NO shared mutable index file.
 * The `.f32` (embedding) is written first, then the `.md`; recall only trusts a
 * memory whose `.md` exists, so a crash between the two writes just drops an
 * orphan vector rather than corrupting anything. Listing scans the scope
 * directory (readdir) — filenames are stamp-prefixed so lexical order == time.
 *
 * All writes are containment- + symlink-checked via the audited shared-core
 * fs-guards (same guarantees as framework.js installSkills).
 */

const fs = require('fs');
const path = require('path');
const {
  assertContained,
  assertNoSymlinks,
  lstatOrNull,
} = require('@ai-fleet/shared-core/agent/registry/fs-guards');
const { resolveMemorySrc, orgKeyFor, MEMORY_SCOPES } = require('./paths');
const { serializeMemoryFile, parseMemoryFile } = require('./memory-file');

const EMBEDDING_BYTES = 4; // Float32
const DEFAULT_SCAN_CAP = 200; // newest-N files scanned per scope during recall

/** Millisecond epoch, zero-padded so the filename sorts chronologically. */
function sortableStamp(createdAt) {
  const ms = Date.parse(createdAt || '');
  return String(Number.isFinite(ms) ? ms : 0).padStart(15, '0');
}

function ensureRoot(src) {
  fs.mkdirSync(src, { recursive: true });
  return fs.realpathSync(src);
}

function safeMkdir(dir, realRoot) {
  assertContained(realRoot, dir);
  fs.mkdirSync(dir, { recursive: true });
  assertNoSymlinks(dir);
}

function encodeVector(embedding) {
  const buf = Buffer.alloc(embedding.length * EMBEDDING_BYTES);
  for (let i = 0; i < embedding.length; i += 1) {
    buf.writeFloatLE(Number(embedding[i]) || 0, i * EMBEDDING_BYTES);
  }
  return buf;
}

/**
 * Persist one memory (a `.f32` then a `.md`). Returns the stored record (with its
 * on-disk `path`), or null when disabled / the scope is unknown. Never throws for
 * a duplicate filename — the id is unique, so `wx` is a crash-consistency guard.
 */
function writeMemory(record, { src = resolveMemorySrc(), context } = {}) {
  if (!src || !record || !MEMORY_SCOPES.includes(record.scope) || !record.id) return null;
  const realRoot = ensureRoot(src);
  const dir = path.join(realRoot, orgKeyFor(context), record.scope);
  safeMkdir(dir, realRoot);

  const base = `${sortableStamp(record.createdAt)}__${record.id}`;
  const mdPath = path.join(dir, `${base}.md`);
  const f32Path = path.join(dir, `${base}.f32`);
  assertContained(realRoot, mdPath);
  assertContained(realRoot, f32Path);

  const embedding = Array.isArray(record.embedding) && record.embedding.length ? record.embedding : null;
  if (embedding) fs.writeFileSync(f32Path, encodeVector(embedding), { flag: 'wx' });
  fs.writeFileSync(mdPath, serializeMemoryFile(record), { encoding: 'utf8', flag: 'wx' });
  return { ...record, path: mdPath };
}

/** Read the sibling embedding for a memory `.md` path, or null when absent. */
function readVector(mdPath) {
  if (typeof mdPath !== 'string') return null;
  const f32Path = mdPath.replace(/\.md$/, '.f32');
  const stat = lstatOrNull(f32Path);
  if (!stat || !stat.isFile()) return null;
  const buf = fs.readFileSync(f32Path);
  const out = new Array(Math.floor(buf.length / EMBEDDING_BYTES));
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readFloatLE(i * EMBEDDING_BYTES);
  return out;
}

/**
 * Newest-first memories for the workspace tenant, optionally one scope. Bounded
 * per scope. Each record carries its on-disk `path` so recall can lazily load
 * the matching vector.
 */
function listMemories({ src = resolveMemorySrc(), context, scope, limit = DEFAULT_SCAN_CAP } = {}) {
  if (!src) return [];
  let realRoot;
  try { realRoot = fs.realpathSync(src); } catch (_) { return []; }
  const orgKey = orgKeyFor(context);
  const scopes = scope ? [scope] : MEMORY_SCOPES;
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SCAN_CAP;
  const records = [];
  for (const sc of scopes) {
    const dir = path.join(realRoot, orgKey, sc);
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }
    const mdFiles = entries.filter((n) => n.endsWith('.md')).sort().reverse().slice(0, cap);
    for (const name of mdFiles) {
      const mdPath = path.join(dir, name);
      try {
        const rec = parseMemoryFile(fs.readFileSync(mdPath, 'utf8'));
        if (rec.id) records.push({ ...rec, scope: rec.scope || sc, path: mdPath });
      } catch (_) { /* skip an unreadable/half-written file */ }
    }
  }
  return records;
}

module.exports = { writeMemory, readVector, listMemories, sortableStamp, DEFAULT_SCAN_CAP };
