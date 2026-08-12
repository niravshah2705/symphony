'use strict';

const fs = require('fs');
const path = require('path');
const { KINDS, assertSafePathSegment } = require('./schema');
const { copyTreeFiltered } = require('./secret-filter');

/**
 * Write a normalized registry to a DUAL-format bundle on disk:
 *
 *   <outDir>/<version>/original/     harness-native payloads, copied verbatim
 *                                    (secret-filtered) so a harness can consume the
 *                                    raw plugin/skill exactly as shipped.
 *   <outDir>/<version>/generic/      normalized tree + registry.json — flattened
 *                                    skills (SKILL.md shape), inert hooks, sanitized
 *                                    MCP descriptors.
 *   <outDir>/registry-manifest.json  top-level pointer to the newest version.
 *
 * Security: EVERY copy goes through `copyTreeFiltered` (denylist + symlink-skip +
 * containment) so secrets (`auth.json`, `.env`, keys) and VCS/build dirs never
 * reach either tree; hook files are copied as inert data and never executed; MCP
 * descriptors were already reduced to transport fields by the reader. The
 * build-time-only `payload.sourceDir` is stripped from the published registry.json.
 */

const CURRENT_ISO_UNSET = null;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** Public registry.json: drop build-time `sourceDir`, add generation metadata. */
function toPublicRegistry(registry, { generatedAt, sources }) {
  const entries = registry.entries.map((entry) => {
    const payload = { ...entry.payload };
    delete payload.sourceDir;
    return { ...entry, payload };
  });
  return {
    schemaVersion: registry.schemaVersion,
    version: registry.version,
    generatedAt: generatedAt || CURRENT_ISO_UNSET,
    sources: sources || [],
    entries,
  };
}

/** Copy a single file into `destDir` under guard (used for file-based hooks). */
function copyFileGuarded(fromFile, destDir, realRoot, warnings) {
  const target = path.join(destDir, path.basename(fromFile));
  const w = copyTreeFiltered(fromFile, target, { realRoot });
  warnings.push(...w);
}

function writeSkill(entry, genericDir, originalDir, realRoot, warnings) {
  const src = entry.payload.sourceDir;
  if (!src) return;
  // generic tree (flattened, namespaced)
  warnings.push(...copyTreeFiltered(src, path.join(genericDir, entry.payload.path), { realRoot }));
  // original tree: only vendored (plugin-provided skills already live inside the
  // plugin's original copy).
  if (!entry.payload.providedByPlugin) {
    warnings.push(...copyTreeFiltered(src, path.join(originalDir, 'skills', entry.name), { realRoot }));
  }
}

function writePlugin(entry, genericDir, originalDir, realRoot, warnings) {
  const src = entry.payload.sourceDir;
  if (!src) return;
  // generic/plugins/<mp>/<plugin>/<ver>
  warnings.push(...copyTreeFiltered(src, path.join(genericDir, entry.payload.path), { realRoot }));
  // original/<mp>/<plugin>/<ver> (drop the leading "plugins/" of the logical path)
  const originalRel = entry.payload.path.replace(/^plugins\//, '');
  warnings.push(...copyTreeFiltered(src, path.join(originalDir, originalRel), { realRoot }));
}

function writeHook(entry, genericDir, realRoot, warnings) {
  const destDir = path.join(genericDir, entry.payload.path);
  if (entry.payload.entrypoint) {
    copyFileGuarded(entry.payload.entrypoint, destDir, realRoot, warnings);
    return;
  }
  if (entry.payload.sourceDir) {
    warnings.push(...copyTreeFiltered(entry.payload.sourceDir, destDir, { realRoot }));
  }
}

function writeMcp(entry, genericDir, realRoot) {
  const file = path.join(genericDir, entry.payload.path);
  // Descriptor was already sanitized by the reader; write it as-is.
  writeJson(file, { name: entry.name, ...entry.payload.descriptor, providedByPlugin: entry.payload.providedByPlugin || null });
}

/**
 * @param {{ schemaVersion:string, version:string, entries:object[] }} registry
 * @param {string} outDir bundle root (created if absent)
 * @param {{ generatedAt?:string, sources?:object[] }} [opts]
 * @returns {{ warnings:string[], versionDir:string, genericDir:string, originalDir:string }}
 */
function writeBundle(registry, outDir, opts = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const realRoot = fs.realpathSync(outDir);
  const versionSeg = assertSafePathSegment(registry.version, 'registry version');
  const versionDir = path.join(realRoot, versionSeg);
  const genericDir = path.join(versionDir, 'generic');
  const originalDir = path.join(versionDir, 'original');
  fs.mkdirSync(genericDir, { recursive: true });
  fs.mkdirSync(originalDir, { recursive: true });

  const warnings = [];
  for (const entry of registry.entries) {
    if (entry.kind === KINDS.SKILL) writeSkill(entry, genericDir, originalDir, realRoot, warnings);
    else if (entry.kind === KINDS.PLUGIN) writePlugin(entry, genericDir, originalDir, realRoot, warnings);
    else if (entry.kind === KINDS.HOOK) writeHook(entry, genericDir, realRoot, warnings);
    else if (entry.kind === KINDS.MCP_SERVER) writeMcp(entry, genericDir, realRoot);
  }

  writeJson(path.join(genericDir, 'registry.json'),
    toPublicRegistry(registry, { generatedAt: opts.generatedAt || null, sources: opts.sources }));
  writeJson(path.join(realRoot, 'registry-manifest.json'), {
    schemaVersion: registry.schemaVersion,
    version: registry.version,
    generatedAt: opts.generatedAt || null,
    entryCount: registry.entries.length,
  });

  return { warnings, versionDir, genericDir, originalDir };
}

module.exports = { writeBundle, toPublicRegistry };
