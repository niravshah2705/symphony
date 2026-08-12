'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertSafePathSegment } = require('./schema');

/**
 * Fetch a marketplace repository at a PINNED ref into a working directory.
 *
 * Supply-chain posture (see tribal-knowledge: supply-chain): we clone at the exact
 * `ref` recorded in sources.json (a tag or full sha), never a moving branch, and
 * we NEVER run install/postinstall scripts against the clone — the payload is read
 * as inert files. `git` is injected so the pure command-plan is unit-testable and
 * a local marketplace (source_type: local) can be copied instead of cloned.
 *
 * @param {{ repo:(string|null), url:(string|null), ref:string }} mp
 * @param {{ workRoot:string, git?:Function, name?:string }} opts
 * @returns {{ path:string, ref:string, sha:string, url:string }}
 */
function fetchMarketplace(mp, opts) {
  const { workRoot, git = defaultGit, name } = opts || {};
  if (!workRoot) throw new Error('fetchMarketplace requires a workRoot');
  const dirName = assertSafePathSegment(name || safeRepoName(mp), 'marketplace dir');
  const dest = path.join(workRoot, dirName);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const url = resolveMarketplaceUrl(mp);

  // Local marketplace: copy the tree instead of cloning (secret-filter is applied
  // later by the bundle-writer, so a plain copy here is fine).
  if (url.startsWith('file://')) {
    const srcDir = url.slice('file://'.length);
    fs.cpSync(srcDir, dest, { recursive: true });
    return { path: dest, ref: mp.ref, sha: mp.ref, url };
  }

  // Fetch ONLY the pinned ref, shallow, no tags — minimal surface, deterministic.
  git(['init', '-q', dest]);
  git(['-C', dest, 'remote', 'add', 'origin', url]);
  git(['-C', dest, 'fetch', '--depth', '1', '-q', 'origin', mp.ref]);
  git(['-C', dest, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD']);
  let sha = mp.ref;
  try {
    sha = String(git(['-C', dest, 'rev-parse', 'HEAD'])).trim() || mp.ref;
  } catch (_) { /* keep the requested ref if rev-parse is unavailable (test stub) */ }
  return { path: dest, ref: mp.ref, sha, url };
}

/** Derive the clone URL from a `repo` (owner/name) or explicit `url`. */
function resolveMarketplaceUrl(mp) {
  if (mp && typeof mp.url === 'string' && mp.url) return mp.url;
  if (mp && typeof mp.repo === 'string' && mp.repo) return `https://github.com/${mp.repo}.git`;
  throw new Error('marketplace has neither url nor repo');
}

/** A safe directory name for a marketplace clone (from repo or url host/path). */
function safeRepoName(mp) {
  const base = mp && mp.repo ? mp.repo.replace('/', '__') : String((mp && mp.url) || 'marketplace');
  return base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'marketplace';
}

function defaultGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

module.exports = { fetchMarketplace, resolveMarketplaceUrl, safeRepoName };
