'use strict';

const fs = require('fs');
const path = require('path');
const { KINDS } = require('./schema');
const { parseFrontmatter, skillFields } = require('./frontmatter');
const { sanitizeMcpDescriptor } = require('./secret-filter');

/**
 * Read native harness resources out of a cloned marketplace repo (or the repo's
 * own vendored skills) into "raw records" the normalizer later dedupes and
 * converts. Everything read here is INERT DATA — no plugin code is executed; hook
 * files are catalogued, never run.
 *
 * Raw record kinds mirror the generic kinds (skill | plugin | mcpServer | hook).
 * A plugin record carries its discovered `provides` (child skills/hooks/mcp/agents),
 * which the normalizer promotes to their own linked entries.
 *
 * The reader is deliberately TOLERANT: a missing manifest or payload dir yields an
 * `incomplete: true` record rather than throwing, so one bad plugin never fails the
 * whole registry sync (the CLI logs the gaps).
 */

// --- small fs helpers -------------------------------------------------------

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

function readJsonOrNull(file) {
  const text = readTextOrNull(file);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => isDir(path.join(dir, n)));
  } catch (_) {
    return [];
  }
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => {
      try { return fs.statSync(path.join(dir, n)).isFile(); } catch (_) { return false; }
    });
  } catch (_) {
    return [];
  }
}

// --- skills -----------------------------------------------------------------

/** Read one `<dir>/SKILL.md` skill directory into a raw skill record. */
function readSkillDir(skillDir, name, base = {}) {
  const md = readTextOrNull(path.join(skillDir, 'SKILL.md'));
  const fields = md ? skillFields(parseFrontmatter(md).data) : {};
  return {
    kind: KINDS.SKILL,
    name: (fields.name || name),
    description: fields.description || '',
    capabilities: {
      allowedTools: fields.allowedTools || [],
      argumentHint: fields.argumentHint || null,
      userInvocable: fields.userInvocable,
      shortDescription: fields.shortDescription || null,
    },
    sourceDir: skillDir,
    marketplace: base.marketplace || null,
    version: base.version != null ? String(base.version) : null,
    ref: base.ref || null,
    sourceRepo: base.sourceRepo || null,
    sourceUrl: base.sourceUrl || null,
    parentPlugin: base.parentPlugin || null,
    incomplete: md == null,
  };
}

/** Read a repo-vendored skill from `<skillsRoot>/<name>/SKILL.md`. */
function readVendoredSkill(skillsRoot, name) {
  const dir = path.join(skillsRoot, name);
  const record = readSkillDir(dir, name);
  if (!isDir(dir)) record.incomplete = true;
  return record;
}

// --- hooks ------------------------------------------------------------------

/** Infer a pre/post event from a hook key/name (best-effort). */
function inferHookEvent(label) {
  const l = String(label || '').toLowerCase();
  if (l.includes('pre')) return 'pre';
  if (l.includes('post') || l.includes('stop') || l.includes('after')) return 'post';
  return null;
}

/**
 * Discover a plugin's hooks. Sources: a `hooks/` dir of files and/or a `hooks`
 * pointer/map in plugin.json. Each hook is catalogued with an inferred event.
 */
function readHooks(pluginDir, pluginJson, base) {
  const hooks = [];
  const seen = new Set();

  const add = (name, event, dir, entrypoint) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    hooks.push({
      kind: KINDS.HOOK,
      name,
      event: event || inferHookEvent(name),
      // A metadata-only (map-declared) hook has no payload dir/file of its own —
      // its `sourceDir` is null so the bundle-writer copies nothing for it.
      sourceDir: dir || null,
      entrypoint: entrypoint || null,
      marketplace: base.marketplace || null,
      parentPlugin: base.parentPlugin || null,
      ref: base.ref || null,
      sourceRepo: base.sourceRepo || null,
      sourceUrl: base.sourceUrl || null,
      incomplete: false,
    });
  };

  const hooksDir = path.join(pluginDir, 'hooks');
  if (isDir(hooksDir)) {
    for (const sub of listDirs(hooksDir)) add(sub, null, path.join(hooksDir, sub), null);
    for (const file of listFiles(hooksDir)) {
      const stem = file.replace(/\.[^.]+$/, '');
      add(stem, null, hooksDir, path.join(hooksDir, file));
    }
  }

  // plugin.json `hooks` may be a path string or an event→config map. A map key is
  // a declaration only (no file of its own) → sourceDir null, metadata-only entry.
  const decl = pluginJson && pluginJson.hooks;
  if (decl && typeof decl === 'object' && !Array.isArray(decl)) {
    for (const key of Object.keys(decl)) add(key, inferHookEvent(key), null, null);
  }
  return hooks;
}

// --- mcp servers ------------------------------------------------------------

/** Read + sanitize MCP server descriptors from a plugin's `.mcp.json`. */
function readMcpServers(pluginDir, pluginJson, base) {
  const servers = [];
  const files = ['.mcp.json', 'mcp.json'];
  if (pluginJson && typeof pluginJson.mcpServers === 'string') files.unshift(pluginJson.mcpServers);
  let doc = null;
  let sourceFile = null;
  for (const f of files) {
    const candidate = path.isAbsolute(f) ? f : path.join(pluginDir, f);
    doc = readJsonOrNull(candidate);
    if (doc) { sourceFile = candidate; break; }
  }
  const map = (doc && doc.mcpServers) || (pluginJson && typeof pluginJson.mcpServers === 'object' ? pluginJson.mcpServers : null);
  if (map && typeof map === 'object') {
    for (const [name, descriptor] of Object.entries(map)) {
      servers.push({
        kind: KINDS.MCP_SERVER,
        name,
        descriptor: sanitizeMcpDescriptor(descriptor),
        sourceFile,
        marketplace: base.marketplace || null,
        parentPlugin: base.parentPlugin || null,
        ref: base.ref || null,
        sourceRepo: base.sourceRepo || null,
        sourceUrl: base.sourceUrl || null,
        incomplete: false,
      });
    }
  }
  return servers;
}

// --- plugin resolution ------------------------------------------------------

const MARKETPLACE_MANIFESTS = [
  path.join('.claude-plugin', 'marketplace.json'),
  path.join('.codex-plugin', 'marketplace.json'),
  'codex-marketplace.json',
];
const PLUGIN_MANIFESTS = [
  path.join('.claude-plugin', 'plugin.json'),
  path.join('.codex-plugin', 'plugin.json'),
  'plugin.json',
];

/** Extract a plugin's source path from a marketplace manifest entry. */
function pluginSourcePath(entry) {
  if (!entry || !entry.source) return null;
  if (typeof entry.source === 'string') return entry.source;
  if (typeof entry.source === 'object' && typeof entry.source.path === 'string') return entry.source.path;
  return null;
}

/** Resolve the on-disk directory of a named plugin within a clone. */
function resolvePluginDir(cloneDir, name) {
  for (const rel of MARKETPLACE_MANIFESTS) {
    const manifest = readJsonOrNull(path.join(cloneDir, rel));
    const plugins = manifest && Array.isArray(manifest.plugins) ? manifest.plugins : [];
    const entry = plugins.find((p) => p && p.name === name);
    const src = pluginSourcePath(entry);
    if (src) {
      const dir = path.resolve(cloneDir, src);
      if (isDir(dir)) return dir;
    }
  }
  for (const rel of [path.join('plugins', name), name]) {
    const dir = path.join(cloneDir, rel);
    if (isDir(dir)) return dir;
  }
  return null;
}

/** Load the first present plugin manifest for a plugin dir. */
function readPluginManifest(pluginDir) {
  for (const rel of PLUGIN_MANIFESTS) {
    const doc = readJsonOrNull(path.join(pluginDir, rel));
    if (doc) return doc;
  }
  return null;
}

/**
 * Read a selected plugin from a cloned marketplace into a raw plugin record with
 * its discovered `provides`.
 * @param {string} cloneDir marketplace clone root
 * @param {{ name:string, marketplace:string, version:string, ref:string, sourceRepo:(string|null), sourceUrl:(string|null) }} sel
 */
function readPlugin(cloneDir, sel) {
  const pluginDir = resolvePluginDir(cloneDir, sel.name);
  const base = {
    marketplace: sel.marketplace,
    ref: sel.ref || null,
    sourceRepo: sel.sourceRepo || null,
    sourceUrl: sel.sourceUrl || null,
    parentPlugin: `${KINDS.PLUGIN}:${sel.name}@${sel.marketplace}`,
  };
  if (!pluginDir) {
    return {
      kind: KINDS.PLUGIN,
      name: sel.name,
      marketplace: sel.marketplace,
      version: sel.version != null ? String(sel.version) : 'unknown',
      ref: sel.ref || null,
      sourceRepo: sel.sourceRepo || null,
      sourceUrl: sel.sourceUrl || null,
      sourceDir: null,
      description: '',
      provides: { skills: [], hooks: [], mcpServers: [], agents: [], commands: [] },
      incomplete: true,
    };
  }
  const manifest = readPluginManifest(pluginDir) || {};

  const skillsDir = path.join(pluginDir, 'skills');
  const skills = listDirs(skillsDir).map((n) => readSkillDir(path.join(skillsDir, n), n, base));

  return {
    kind: KINDS.PLUGIN,
    name: sel.name,
    marketplace: sel.marketplace,
    version: manifest.version != null ? String(manifest.version) : (sel.version != null ? String(sel.version) : 'unknown'),
    ref: sel.ref || null,
    sourceRepo: sel.sourceRepo || null,
    sourceUrl: sel.sourceUrl || null,
    sourceDir: pluginDir,
    description: manifest.description || '',
    provides: {
      skills,
      hooks: readHooks(pluginDir, manifest, base),
      mcpServers: readMcpServers(pluginDir, manifest, base),
      agents: listDirs(path.join(pluginDir, 'agents')).concat(
        listFiles(path.join(pluginDir, 'agents')).map((f) => f.replace(/\.[^.]+$/, ''))
      ),
      commands: listFiles(path.join(pluginDir, 'commands')).map((f) => f.replace(/\.[^.]+$/, '')),
    },
    incomplete: false,
  };
}

module.exports = {
  readSkillDir,
  readVendoredSkill,
  readPlugin,
  resolvePluginDir,
  inferHookEvent,
};
