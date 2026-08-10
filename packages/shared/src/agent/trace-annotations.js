'use strict';

/**
 * Business "annotations" for LangSmith runs.
 *
 * Every traced run (planner + coder) is stamped with three business tags so
 * traces are filterable and groupable in LangSmith:
 *   - project  : human-readable business/project name
 *   - task-id  : the tracker task (Linear issue) identifier, e.g. "ENG-123"
 *   - session  : the top-level run id (unique per run). Also emitted as
 *                `session_id`, the metadata key LangSmith's Threads view groups on.
 *
 * Each value is attached BOTH as structured `metadata` (filterable + thread key)
 * and as a flat `tag` (`project:…`, `task:…`, `session:…`) for the runs list.
 * Absent or blank fields are omitted so we never stamp empty annotations.
 */

/** Trimmed string, or '' for null/undefined/blank. */
function clean(value) {
  if (value == null) return '';
  return String(value).trim();
}

/**
 * Build the { metadata, tags } annotation for a business context.
 * @param {{ project?: string, taskId?: string, session?: string }} [business]
 * @returns {{ metadata: Record<string,string>, tags: string[] }}
 */
function buildAnnotations(business = {}) {
  const metadata = {};
  const tags = [];

  const project = clean(business.project);
  if (project) {
    metadata.project = project;
    tags.push(`project:${project}`);
  }

  const taskId = clean(business.taskId);
  if (taskId) {
    metadata['task-id'] = taskId;
    tags.push(`task:${taskId}`);
  }

  const session = clean(business.session);
  if (session) {
    metadata.session = session;
    metadata.session_id = session; // LangSmith Threads grouping key
    tags.push(`session:${session}`);
  }

  return { metadata, tags };
}

/**
 * Merge business annotations into an existing LangChain invoke config,
 * preserving any metadata/tags already present. Returns a NEW config object
 * (never mutates the input). Tags are de-duplicated with order preserved.
 * @param {object} [config] - existing invoke config (may carry metadata/tags)
 * @param {{ project?: string, taskId?: string, session?: string }} [business]
 * @returns {object} new config with annotations merged in
 */
function withAnnotations(config = {}, business = {}) {
  const { metadata, tags } = buildAnnotations(business);
  const mergedTags = [...(config.tags || []), ...tags];
  return {
    ...config,
    metadata: { ...(config.metadata || {}), ...metadata },
    tags: [...new Set(mergedTags)],
  };
}

// ---------------------------------------------------------------------------
// Resource annotations (skills / tools / plugins)
//
// The same metadata + flat-tag convention as buildAnnotations, applied to the
// set of skills, tools, and plugins a run uses. Values are lists of NAMES only
// (never tool args, results, prompts, or secrets). Each category becomes a
// metadata array (+ `<key>_count`) and flat tags `skill:<n>` / `tool:<n>` /
// `plugin:<n>` so runs are filterable and groupable in LangSmith.
// ---------------------------------------------------------------------------

/** Default caps so trace metadata can never grow unbounded. */
const RESOURCE_MAX_ITEMS = 100;
const RESOURCE_MAX_NAME_LEN = 120;

/** Metadata key → its flat-tag singular prefix. */
const RESOURCE_TAG_PREFIX = { skills: 'skill', tools: 'tool', plugins: 'plugin' };

/**
 * Normalize a value (array OR comma-separated string) into a trimmed,
 * de-duplicated, capped list of non-empty name strings. Order is preserved.
 * @param {string[]|string|null|undefined} value
 * @param {{ maxItems?: number, maxLen?: number }} [opts]
 * @returns {string[]}
 */
function cleanList(value, { maxItems = RESOURCE_MAX_ITEMS, maxLen = RESOURCE_MAX_NAME_LEN } = {}) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const name = clean(entry).slice(0, maxLen);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Build the { metadata, tags } annotation for the resources a run uses.
 * Empty categories are omitted so we never stamp empty lists.
 * @param {{ skills?: string[]|string, tools?: string[]|string, plugins?: string[]|string }} [resources]
 * @returns {{ metadata: Record<string, string[]|number>, tags: string[] }}
 */
function buildResourceAnnotations(resources = {}) {
  const metadata = {};
  const tags = [];
  for (const [key, prefix] of Object.entries(RESOURCE_TAG_PREFIX)) {
    const list = cleanList(resources[key]);
    if (!list.length) continue;
    metadata[key] = list;
    metadata[`${key}_count`] = list.length;
    for (const name of list) tags.push(`${prefix}:${name}`);
  }
  return { metadata, tags };
}

/**
 * Merge resource annotations into an existing invoke config, preserving any
 * metadata/tags already present. Returns a NEW config object (never mutates the
 * input). Tags are de-duplicated with order preserved.
 * @param {object} [config]
 * @param {{ skills?: string[]|string, tools?: string[]|string, plugins?: string[]|string }} [resources]
 * @returns {object}
 */
function withResources(config = {}, resources = {}) {
  const { metadata, tags } = buildResourceAnnotations(resources);
  const mergedTags = [...(config.tags || []), ...tags];
  return {
    ...config,
    metadata: { ...(config.metadata || {}), ...metadata },
    tags: [...new Set(mergedTags)],
  };
}

module.exports = {
  buildAnnotations,
  withAnnotations,
  cleanList,
  buildResourceAnnotations,
  withResources,
};
