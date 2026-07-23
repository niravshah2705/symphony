'use strict';

const express = require('express');
const { getApiKey } = require('@ai-fleet/shared/store');
const linear = require('@ai-fleet/shared/linear');
const { asyncHandler } = require('@ai-fleet/shared/util');

const router = express.Router();
const taskRequests = new Map();
const MAX_TASK_REQUESTS = 500;

// Order in which Linear workflow-state types appear as board columns.
const STATE_TYPE_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];

function stateRank(type) {
  const idx = STATE_TYPE_ORDER.indexOf(type);
  return idx === -1 ? STATE_TYPE_ORDER.length : idx;
}

/** Build ordered board columns from the states actually present on the issues. */
function buildColumns(issues) {
  const byState = new Map();
  for (const issue of issues) {
    const state = issue.state;
    if (!state) continue;
    if (!byState.has(state.id)) {
      byState.set(state.id, { ...state, issues: [] });
    }
    byState.get(state.id).issues.push(issue);
  }
  return [...byState.values()].sort((a, b) => {
    const rankDiff = stateRank(a.type) - stateRank(b.type);
    if (rankDiff !== 0) return rankDiff;
    return (a.position || 0) - (b.position || 0);
  });
}

class ProjectTaskError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ProjectTaskError';
    this.status = status;
  }
}

function boundedText(value, label, max, { required = true } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new ProjectTaskError(`${label} is required.`);
  if (text.length > max) throw new ProjectTaskError(`${label} must be ${max.toLocaleString()} characters or fewer.`);
  return text;
}

function normalizeProjectTask(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const priority = source.priority === undefined ? 2 : Number(source.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new ProjectTaskError('priority must be an integer from 0 to 4.');
  }
  const idempotencyKey = boundedText(source.idempotencyKey, 'idempotencyKey', 160);
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(idempotencyKey)) {
    throw new ProjectTaskError('idempotencyKey must contain only letters, numbers, colons, underscores, or hyphens.');
  }
  return {
    projectId: boundedText(source.projectId, 'projectId', 160),
    title: boundedText(source.title, 'title', 255),
    description: boundedText(source.description, 'description', 20_000, { required: false }),
    priority,
    idempotencyKey,
  };
}

function pruneTaskRequests() {
  while (taskRequests.size > MAX_TASK_REQUESTS) {
    taskRequests.delete(taskRequests.keys().next().value);
  }
}

// POST /api/issues — create one confirmed implementation task in a selected
// project. The server derives the team and owns the Linear mutation; the model
// and browser never receive a raw GraphQL write capability.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const task = normalizeProjectTask(req.body);
    const requestKey = `${task.projectId}:${task.idempotencyKey}`;
    const fingerprint = JSON.stringify([task.title, task.description, task.priority]);
    const existing = taskRequests.get(requestKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ProjectTaskError('This idempotency key was already used for different task content.', 409);
      }
      const issue = await existing.promise;
      return res.status(200).json({ issue, replayed: true });
    }

    const promise = (async () => {
      const { team } = await linear.getProjectTeam(getApiKey(), task.projectId);
      return linear.createIssue(getApiKey(), {
        teamId: team.id,
        projectId: task.projectId,
        title: task.title,
        description: task.description,
        priority: task.priority,
      });
    })();
    taskRequests.set(requestKey, { fingerprint, promise });
    pruneTaskRequests();
    try {
      const issue = await promise;
      res.status(201).json({ issue, replayed: false });
    } catch (error) {
      taskRequests.delete(requestKey);
      throw error;
    }
  })
);

// GET /api/issues/board/:projectId — issues grouped into board columns.
router.get(
  '/board/:projectId',
  asyncHandler(async (req, res) => {
    const project = await linear.getProjectIssues(getApiKey(), req.params.projectId);
    const issues = project.issues.nodes;
    res.json({
      project: { id: project.id, name: project.name },
      columns: buildColumns(issues),
    });
  })
);

// PATCH /api/issues/:id/state — move an issue to another workflow state (board drag).
router.patch(
  '/:id/state',
  asyncHandler(async (req, res) => {
    const stateId = req.body && req.body.stateId ? String(req.body.stateId) : '';
    if (!stateId) return res.status(400).json({ error: 'stateId is required.' });
    const issue = await linear.updateIssueState(getApiKey(), req.params.id, stateId);
    res.json({ issue });
  })
);

module.exports = router;
module.exports.ProjectTaskError = ProjectTaskError;
module.exports.normalizeProjectTask = normalizeProjectTask;
module.exports.taskRequests = taskRequests;
