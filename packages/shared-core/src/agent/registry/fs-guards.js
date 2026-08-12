'use strict';

const fs = require('fs');
const path = require('path');
const { assertSafePathSegment } = require('./schema');

/**
 * Filesystem safety guards for copying agent resources.
 *
 * These MIRROR the containment/symlink/ownership checks that
 * `packages/shared/src/agent/framework.js` `installSkills` relies on. They live in
 * the lowest layer (`shared-core`) so the registry bundle-writer has one audited
 * copy of the security-critical path handling. framework.js keeps its own
 * equivalents for now; a follow-up should migrate it onto this module (validated
 * by `framework.test.js` in the main checkout) so there is a single source.
 * `shared` consumes `shared-core` downward, never the reverse.
 *
 * Threats covered (see tribal-knowledge: path-traversal, secret-leakage):
 *   - path traversal / Zip-Slip — `assertContained` verifies a resolved target
 *     stays under an allowlisted root before any write.
 *   - symlink escape — `assertNoSymlinks` refuses a symlinked dir/file so a
 *     crafted payload can't redirect a copy outside the destination.
 *   - hijacked destination — `claimSkillsDirectory` only reuses a dir that
 *     carries our ownership marker, never a pre-existing project dir.
 */

const SKILLS_DEST_DIRNAME = '.agent-skills';
const SKILLS_OWNER_MARKER = '.tech-symphony-managed';
const SKILLS_OWNER_MARKER_CONTENT = 'tech-symphony-agent-skills-v1\n';

/** lstat that returns null on ENOENT (and rethrows anything else). */
function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** True when `p` is a directory (following symlinks; false on any error). */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/**
 * Reject a resource name that is not a single, separator-free path component.
 * Kept intentionally lenient (basename-equality) to match the framework's
 * long-standing skill-name contract; use `assertSafePathSegment` (charset-strict)
 * for names DERIVED from untrusted upstream manifests.
 */
function validateSkillName(name) {
  if (
    typeof name !== 'string'
    || !name
    || name === '.'
    || name === '..'
    || path.basename(name) !== name
    || name.includes('/')
    || name.includes('\\')
  ) {
    throw new Error(`Invalid skill name: ${String(name)}`);
  }
  return name;
}

/** Throw unless `candidate` resolves to a path contained within `realRoot`. */
function assertContained(realRoot, candidate) {
  const relative = path.relative(realRoot, path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing path outside destination root: ${candidate}`);
  }
}

/** Recursively refuse any symlink at or under `target`. */
function assertNoSymlinks(target) {
  const stat = lstatOrNull(target);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link inside resource destination: ${target}`);
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(target)) {
    assertNoSymlinks(path.join(target, entry));
  }
}

/**
 * Ensure `dest` is a directory we own (creating it if absent). Reuses an existing
 * dir ONLY when it is a real dir contained in `realRoot` carrying our ownership
 * marker — never a symlink, non-dir, or unmarked project directory.
 */
function claimSkillsDirectory(dest, realRoot) {
  const existing = lstatOrNull(dest);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link destination: ${dest}`);
    }
    if (!existing.isDirectory()) {
      throw new Error(`Refusing non-directory destination: ${dest}`);
    }
    assertContained(realRoot, fs.realpathSync(dest));
    assertNoSymlinks(dest);
    const marker = path.join(dest, SKILLS_OWNER_MARKER);
    const markerStat = lstatOrNull(marker);
    if (!markerStat || markerStat.isSymbolicLink() || !markerStat.isFile()) {
      throw new Error(`Refusing project-owned directory without a valid ownership marker: ${dest}`);
    }
    if (fs.readFileSync(marker, 'utf8') !== SKILLS_OWNER_MARKER_CONTENT) {
      throw new Error(`Refusing directory with an invalid ownership marker: ${dest}`);
    }
    return;
  }
  assertContained(realRoot, dest);
  fs.mkdirSync(dest);
  assertContained(realRoot, fs.realpathSync(dest));
  fs.writeFileSync(path.join(dest, SKILLS_OWNER_MARKER), SKILLS_OWNER_MARKER_CONTENT, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

/**
 * Copy `from`→`to` with full guard coverage: both endpoints must be symlink-free,
 * `to` must resolve within `realRoot`, and any prior `to` is removed first.
 * Used by the bundle-writer for every resource payload copy.
 */
function safeCopyDir(from, to, realRoot) {
  assertNoSymlinks(from);
  assertContained(realRoot, to);
  assertNoSymlinks(to);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  assertContained(realRoot, fs.realpathSync(to));
  assertNoSymlinks(to);
}

module.exports = {
  SKILLS_DEST_DIRNAME,
  SKILLS_OWNER_MARKER,
  SKILLS_OWNER_MARKER_CONTENT,
  lstatOrNull,
  isDir,
  validateSkillName,
  assertContained,
  assertNoSymlinks,
  claimSkillsDirectory,
  safeCopyDir,
  assertSafePathSegment,
};
