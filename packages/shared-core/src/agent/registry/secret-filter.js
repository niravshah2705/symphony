'use strict';

const fs = require('fs');
const path = require('path');
const { assertContained, lstatOrNull } = require('./fs-guards');

/**
 * Secret-exclusion policy for copying third-party resource payloads.
 *
 * The converter copies skill/plugin/hook payloads out of cloned marketplace repos
 * (and, for the original tree, verbatim). Those trees can contain credentials
 * (`auth.json`, `.env`, private keys) and version-control internals. This module
 * is the single place that decides what NEVER gets copied, plus a symlink-safe
 * filtered recursive copy the bundle-writer uses for both the `original/` and
 * `generic/` trees.
 *
 * Defense-in-depth (see tribal-knowledge: secret-leakage):
 *   - denylist of secret-ish names + VCS/build dirs (below),
 *   - symlinks are never followed (a link can point at a secret),
 *   - a per-file byte cap prevents copying huge blobs by accident,
 *   - MCP descriptors are reduced to transport/command/args/url — `headers`,
 *     `env`, and any token fields are stripped (the real credential is injected
 *     at connect time by the runtime, never stored in the bundle).
 */

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB — skill/plugin text + small assets

// Exact basenames we refuse to copy (secrets + VCS/build/OS noise). Raw MCP
// config files (`.mcp.json`/`mcp.json`) are denied too: they are where inline
// credentials (`env`, `headers`) live, and the converter republishes them as a
// SANITIZED descriptor under generic/mcp/<server>.json instead of the raw file.
const DENY_EXACT = new Set([
  'auth.json',
  'credentials.json',
  '.netrc',
  '.git',
  '.gitignore',
  'node_modules',
  '.DS_Store',
  '.npmrc',
  '.pypirc',
  '.mcp.json',
  'mcp.json',
]);

// Name patterns that indicate a secret. `token`/`secret`/`credential` must be a
// whole word (boundary-delimited) so legitimate files like `tokenizer.js` copy.
const DENY_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /(^|[-_.])(secret|secrets|token|tokens|credential|credentials|apikey|api[-_]?key)([-_.]|$)/i,
];

/** True when a basename must never be copied into the bundle. */
function isDenied(name) {
  if (DENY_EXACT.has(name)) return true;
  return DENY_PATTERNS.some((re) => re.test(name));
}

/**
 * Recursively copy `from` → `to`, skipping denied names, symlinks, and oversized
 * files. Every destination is containment-checked against `realRoot`. Returns the
 * list of skipped paths (with reasons) for logging.
 *
 * @param {string} from source path
 * @param {string} to destination path
 * @param {{ realRoot: string, maxFileBytes?: number }} opts
 * @returns {string[]} warnings
 */
function copyTreeFiltered(from, to, opts) {
  const { realRoot, maxFileBytes = MAX_FILE_BYTES } = opts || {};
  if (!realRoot) throw new Error('copyTreeFiltered requires a realRoot for containment checks');
  const warnings = [];

  const walk = (src, dest) => {
    const stat = lstatOrNull(src);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      warnings.push(`skipped symlink: ${src}`);
      return;
    }
    if (stat.isDirectory()) {
      assertContained(realRoot, dest);
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        if (isDenied(entry)) {
          warnings.push(`skipped denied entry: ${path.join(src, entry)}`);
          continue;
        }
        walk(path.join(src, entry), path.join(dest, entry));
      }
      return;
    }
    if (!stat.isFile()) {
      warnings.push(`skipped non-regular file: ${src}`);
      return;
    }
    if (stat.size > maxFileBytes) {
      warnings.push(`skipped oversized file (${stat.size} bytes): ${src}`);
      return;
    }
    assertContained(realRoot, dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  };

  if (isDenied(path.basename(from))) {
    warnings.push(`skipped denied root: ${from}`);
    return warnings;
  }
  walk(from, to);
  return warnings;
}

// MCP descriptor fields we KEEP; everything else (headers, env, tokens…) is dropped.
const MCP_KEEP_KEYS = ['type', 'transport', 'command', 'args', 'url', 'cwd'];

/**
 * Reduce a raw MCP server descriptor to its non-secret transport fields.
 * @param {object} raw
 * @returns {object}
 */
function sanitizeMcpDescriptor(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const key of MCP_KEEP_KEYS) {
      if (raw[key] !== undefined) out[key] = raw[key];
    }
  }
  return out;
}

module.exports = {
  MAX_FILE_BYTES,
  isDenied,
  copyTreeFiltered,
  sanitizeMcpDescriptor,
};
