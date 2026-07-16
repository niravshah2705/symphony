'use strict';

const express = require('express');
const { getApiKey } = require('@ai-fleet/shared/store');
const {
  getProjects,
  getProjectMilestones,
  getTeams,
} = require('@ai-fleet/shared/linear');
const { asyncHandler } = require('@ai-fleet/shared/util');

const router = express.Router();

// GET /api/projects — all Linear projects.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const projects = await getProjects(getApiKey());
    res.json({ projects });
  })
);

// GET /api/projects/teams — teams (used when creating a project for a business).
router.get(
  '/teams',
  asyncHandler(async (req, res) => {
    const teams = await getTeams(getApiKey());
    res.json({ teams });
  })
);

// GET /api/projects/:id/milestones — the milestone planning view.
router.get(
  '/:id/milestones',
  asyncHandler(async (req, res) => {
    const { project, milestones } = await getProjectMilestones(getApiKey(), req.params.id);
    res.json({ project, milestones });
  })
);

module.exports = router;
