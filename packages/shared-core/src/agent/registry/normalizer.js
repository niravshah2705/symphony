'use strict';

const {
  REGISTRY_SCHEMA_VERSION,
  KINDS,
  isSafePathSegment,
  normalizeVersion,
  reconcileVersions,
  makeEntry,
} = require('./schema');

/**
 * Turn raw native records (from native-reader) into the canonical generic
 * registry: dedupe by logical identity, merge provenance, reconcile versions, and
 * promote every plugin-provided skill / hook / MCP server to its own linked entry.
 *
 * A plugin-provided skill is namespaced `<plugin>__<skill>` so two plugins that
 * each ship a `raven` skill do not collide, while a repo-vendored core skill keeps
 * its bare name. Each entry carries `payload.sourceDir` (an absolute build-time
 * path the bundle-writer copies from) — the writer STRIPS it before emitting
 * registry.json, so it never leaks into the published artifact.
 */

/** Coerce a string to a single safe path segment (for version/dir names). */
function toSegment(value, fallback = 'unknown') {
  const s = value == null ? '' : String(value);
  if (isSafePathSegment(s)) return s;
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || fallback;
}

/** Flatten top-level records + each plugin's provides into per-kind buckets. */
function flatten(rawRecords) {
  const skills = [];
  const plugins = [];
  const hooks = [];
  const mcps = [];
  for (const rec of rawRecords || []) {
    if (!rec) continue;
    if (rec.kind === KINDS.SKILL) {
      skills.push({ ...rec, genericName: rec.name, pluginName: null, localName: rec.name });
    } else if (rec.kind === KINDS.HOOK) {
      hooks.push({ ...rec, genericName: rec.name, pluginName: null, localName: rec.name });
    } else if (rec.kind === KINDS.MCP_SERVER) {
      mcps.push(rec);
    } else if (rec.kind === KINDS.PLUGIN) {
      plugins.push(rec);
      const provides = rec.provides || {};
      for (const s of provides.skills || []) {
        skills.push({ ...s, genericName: `${rec.name}__${s.name}`, pluginName: rec.name, localName: s.name });
      }
      for (const h of provides.hooks || []) {
        hooks.push({ ...h, genericName: `${rec.name}__${h.name}`, pluginName: rec.name, localName: h.name });
      }
      for (const m of provides.mcpServers || []) mcps.push(m);
    }
  }
  return { skills, plugins, hooks, mcps };
}

/** Group records by a key function into a Map preserving first-seen order. */
function groupBy(records, keyFn) {
  const map = new Map();
  for (const rec of records) {
    const key = keyFn(rec);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(rec);
  }
  return map;
}

/** Provenance element from a raw record (names/refs only — no payload). */
function provenanceOf(rec) {
  return {
    harness: rec.harness || null,
    marketplace: rec.marketplace || null,
    sourceRepo: rec.sourceRepo || null,
    sourceUrl: rec.sourceUrl || null,
    ref: rec.ref || null,
    scope: rec.scope || 'user',
    rawVersion: rec.version != null ? String(rec.version) : null,
  };
}

function versionFrom(records) {
  return reconcileVersions(records.map((r) => normalizeVersion(r.version)));
}

// --- entry builders ---------------------------------------------------------

function buildSkillEntry(records) {
  const first = records[0];
  const name = first.genericName;
  const adapters = { deepagent: { installVia: 'installSkills', name } };
  if (first.pluginName) {
    const ns = `${first.pluginName}:${first.localName}`;
    adapters['claude-code'] = { skill: ns };
    adapters.codex = { skill: ns };
  } else {
    adapters['claude-code'] = { skill: name };
    adapters.codex = { skill: name };
  }
  return makeEntry({
    kind: KINDS.SKILL,
    name,
    description: first.description || '',
    version: versionFrom(records),
    provenance: records.map(provenanceOf),
    payload: {
      path: `skills/${name}`,
      entrypoint: 'SKILL.md',
      sourceDir: first.sourceDir || null,
      providedByPlugin: first.parentPlugin || null,
    },
    capabilities: first.capabilities || {},
    adapters,
    incomplete: records.some((r) => r.incomplete),
  });
}

function buildPluginEntry(records) {
  const first = records[0];
  const provides = first.provides || {};
  const versionSeg = (() => {
    const v = versionFrom(records);
    return toSegment(v.raw || v.normalized);
  })();
  return makeEntry({
    kind: KINDS.PLUGIN,
    name: first.name,
    marketplace: first.marketplace,
    description: first.description || '',
    version: versionFrom(records),
    provenance: records.map(provenanceOf),
    payload: {
      path: `plugins/${toSegment(first.marketplace)}/${toSegment(first.name)}/${versionSeg}`,
      sourceDir: first.sourceDir || null,
      manifest: 'plugin.json',
      provides: {
        skills: (provides.skills || []).map((s) => `${KINDS.SKILL}:${first.name}__${s.name}`),
        hooks: (provides.hooks || []).map((h) => `${KINDS.HOOK}:${first.name}__${h.name}`),
        mcpServers: (provides.mcpServers || []).map((m) => `${KINDS.MCP_SERVER}:${m.name}`),
        agents: provides.agents || [],
        commands: provides.commands || [],
      },
    },
    adapters: {
      'claude-code': { pluginKey: `${first.name}@${first.marketplace}` },
      codex: { pluginKey: `${first.name}@${first.marketplace}` },
      deepagent: { skills: (provides.skills || []).map((s) => `${first.name}__${s.name}`) },
    },
    incomplete: records.some((r) => r.incomplete),
  });
}

function buildHookEntry(records) {
  const first = records[0];
  const name = first.genericName;
  return makeEntry({
    kind: KINDS.HOOK,
    name,
    description: first.description || '',
    version: versionFrom(records),
    provenance: records.map(provenanceOf),
    payload: {
      path: `hooks/${name}`,
      sourceDir: first.sourceDir || null,
      event: first.event || null,
      entrypoint: first.entrypoint || null,
      providedByPlugin: first.parentPlugin || null,
    },
    adapters: {
      'claude-code': { hook: name, event: first.event || null },
      codex: { hook: name, event: first.event || null },
    },
    incomplete: records.some((r) => r.incomplete),
  });
}

function buildMcpEntry(records) {
  const first = records[0];
  return makeEntry({
    kind: KINDS.MCP_SERVER,
    name: first.name,
    description: first.description || '',
    version: versionFrom(records),
    provenance: records.map(provenanceOf),
    payload: {
      path: `mcp/${toSegment(first.name)}.json`,
      descriptor: first.descriptor || {},
      providedByPlugin: first.parentPlugin || null,
    },
    adapters: { deepagent: { serverName: first.name, loadVia: 'loadMcpTools' } },
    incomplete: records.some((r) => r.incomplete),
  });
}

/**
 * @param {object[]} rawRecords top-level native records (vendored skills + plugins)
 * @param {{ version?: string }} [opts]
 * @returns {{ schemaVersion:string, version:string, entries:object[] }}
 */
function normalize(rawRecords, opts = {}) {
  const { skills, plugins, hooks, mcps } = flatten(rawRecords);

  const entries = [];
  for (const group of groupBy(skills, (r) => r.genericName).values()) entries.push(buildSkillEntry(group));
  for (const group of groupBy(plugins, (r) => `${r.name}@${r.marketplace}`).values()) entries.push(buildPluginEntry(group));
  for (const group of groupBy(hooks, (r) => r.genericName).values()) entries.push(buildHookEntry(group));
  for (const group of groupBy(mcps, (r) => r.name).values()) entries.push(buildMcpEntry(group));

  // Deterministic order (stable published artifact + reviewable diffs).
  entries.sort((a, b) => a.id.localeCompare(b.id, 'en'));

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    version: opts.version || 'v1',
    entries,
  };
}

module.exports = { normalize, flatten, toSegment };
