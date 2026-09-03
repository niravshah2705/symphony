'use strict';

/**
 * Path resolution for the on-disk (gcsfuse "managed disk") memory store.
 *
 * The store lives on a GCS bucket mounted READ-WRITE via gcsfuse at MEMORY_ROOT
 * (mirrors the read-only skills mount: SKILLS_ROOT/SKILLS_VERSION). A version
 * subdirectory (MEMORY_VERSION) lets published layouts coexist. On-disk layout,
 * tenant-isolated by workspaceOrganizationKey (`org_<sha256>` / `legacy`):
 *
 *   $MEMORY_ROOT/$MEMORY_VERSION/<orgKey>/<scope>/<stamp>__<id>.md   (frontmatter + text)
 *   $MEMORY_ROOT/$MEMORY_VERSION/<orgKey>/<scope>/<stamp>__<id>.f32  (768×float32 LE)
 *
 * This module reads MEMORY_ROOT/MEMORY_VERSION from env DIRECTLY (not via
 * config.js) so the shared-layer store never has to import a not-yet-published
 * shared-core config addition — keeping it self-contained and unit-testable.
 * When MEMORY_ROOT is unset, resolveMemorySrc returns null (feature dormant) and
 * the backend selector falls back to the Firestore/file `memories` store.
 */

const path = require('path');
const { workspaceOrganizationKey } = require('@ai-fleet/shared-core/store/workspace-context');
const { MEMORY_SCOPES } = require('../memory');

/** MEMORY_VERSION forms a filesystem path segment — validate it (defense-in-depth). */
function assertSafeMemoryVersion(version) {
  if (version === '') return version;
  if (version === '.' || version === '..' || !/^[A-Za-z0-9._-]+$/.test(version)) {
    throw new Error(`MEMORY_VERSION must be a single path segment (got: ${version})`);
  }
  return version;
}

/**
 * Absolute source directory the disk store reads/writes, or null when disabled.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
function resolveMemorySrc(env = process.env) {
  const root = String(env.MEMORY_ROOT || '').trim();
  if (!root) return null;
  const version = assertSafeMemoryVersion(String(env.MEMORY_VERSION || '').trim());
  return version ? path.join(root, version) : root;
}

/** Stable, path-safe, non-reversible tenant key for the workspace selection. */
function orgKeyFor(context) {
  return workspaceOrganizationKey(context);
}

module.exports = {
  MEMORY_SCOPES,
  assertSafeMemoryVersion,
  resolveMemorySrc,
  orgKeyFor,
};
