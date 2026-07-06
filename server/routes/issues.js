'use strict';

const express = require('express');
const { getApiKey } = require('../store');
const { getProjectIssues, updateIssueState } = require('../linear');
const { asyncHandler } = require('../util');

const router = express.Router();

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

// GET /api/issues/board/:projectId — issues grouped into board columns.
router.get(
  '/board/:projectId',
  asyncHandler(async (req, res) => {
    const project = await getProjectIssues(getApiKey(), req.params.projectId);
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
    const issue = await updateIssueState(getApiKey(), req.params.id, stateId);
    res.json({ issue });
  })
);

module.exports = router;
