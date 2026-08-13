'use strict';

const linear = require('../linear');
const store = require('../store');

const LABEL_TRANSITIONS = Object.freeze({
  test: Object.freeze({
    from: 'aidone',
    succeeded: 'aitested',
    failed: 'aitestfail',
  }),
  deploy: Object.freeze({
    from: 'aitested',
    succeeded: 'aideployed',
    failed: 'aideployfail',
  }),
});

function cleanId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(id) ? id : '';
}

/** Resolve a Linear project id without confusing it with the native project
 * scope carried by StageCommand.projectId. New callers should use workItem's
 * linearProjectId/projectId; request.projectId remains a legacy fallback. */
function linearProjectId(command) {
  const request = (command && command.input && command.input.request) || {};
  const workItem = (command && command.preflight && command.preflight.workItem) || request.workItem || {};
  return cleanId(
    workItem.linearProjectId
      || workItem.projectId
      || request.linearProjectId
      || request.projectId,
  );
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Best-effort terminal-label projection. It swaps only the expected prior
 * terminal label and preserves unrelated labels. Missing source labels are a
 * no-op: Linear is a visibility/recovery projection, never the control bus.
 */
async function projectStageResult(command, result, dependencies = {}) {
  const transition = LABEL_TRANSITIONS[command && command.stage];
  if (!transition) return { projected: false, skipped: 'unsupported-stage' };
  if (!result || !['succeeded', 'failed'].includes(result.status)) {
    return { projected: false, skipped: 'non-projectable-status' };
  }
  const projectId = linearProjectId(command);
  if (!projectId) return { projected: false, skipped: 'missing-linear-project' };
  const storeImpl = dependencies.store || store;
  const linearImpl = dependencies.linear || linear;
  const settings = dependencies.settings || storeImpl.getSettings();
  const apiKey = String(settings.linearApiKey || '');
  if (!apiKey) return { projected: false, skipped: 'missing-linear-key' };

  const projects = await linearImpl.getProjects(apiKey);
  const project = (projects || []).find((candidate) => candidate && candidate.id === projectId);
  if (!project) return { projected: false, skipped: 'project-not-found' };
  const current = (project.labels && project.labels.nodes) || [];
  const currentNames = new Set(current.map((label) => lower(label.name)));
  const targetName = result.status === 'succeeded' ? transition.succeeded : transition.failed;
  if (currentNames.has(targetName)) return { projected: false, duplicate: true, label: targetName };
  if (!currentNames.has(transition.from)) {
    return { projected: false, skipped: 'source-label-missing', expected: transition.from };
  }

  const target = await linearImpl.getOrCreateProjectLabel(apiKey, targetName);
  const terminalNames = new Set([transition.from, transition.succeeded, transition.failed]);
  const labelIds = current
    .filter((label) => !terminalNames.has(lower(label.name)))
    .map((label) => label.id)
    .filter(Boolean);
  labelIds.push(target.id);
  await linearImpl.setProjectLabels(apiKey, projectId, [...new Set(labelIds)]);
  return { projected: true, label: targetName };
}

module.exports = {
  LABEL_TRANSITIONS,
  linearProjectId,
  projectStageResult,
};
