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

module.exports = { buildAnnotations, withAnnotations };
