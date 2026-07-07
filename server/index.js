'use strict';

const express = require('express');
const path = require('path');
const { CONFIG } = require('./config');
const { sendError } = require('./util');
const log = require('./logger');

const settingsRoutes = require('./routes/settings');
const projectsRoutes = require('./routes/projects');
const issuesRoutes = require('./routes/issues');
const businessesRoutes = require('./routes/businesses');
const rolesRoutes = require('./routes/roles');
const agentRoutes = require('./routes/agent');
const coderRoutes = require('./routes/coder');
const { router: codexRoutes, callback: codexCallback } = require('./routes/codex');
const { router: claudeRoutes } = require('./routes/claude');
const scheduler = require('./agent/scheduler');
const coderMonitor = require('./agent/coder-orchestrator');

const app = express();

app.use(express.json({ limit: '1mb' }));

// API routes.
app.use('/api/settings', settingsRoutes);
app.use('/api/settings/codex', codexRoutes);
app.use('/api/settings/claude', claudeRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/issues', issuesRoutes);
app.use('/api/businesses', businessesRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/coder', coderRoutes);

// Codex OAuth redirect target — must be registered before the SPA fallback.
app.get('/auth/callback', codexCallback);

// Static frontend.
app.use(express.static(CONFIG.PUBLIC_DIR));

// SPA fallback for any non-API GET request.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(CONFIG.PUBLIC_DIR, 'index.html'));
});

// Central JSON error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  sendError(res, err);
});

app.listen(CONFIG.PORT, () => {
  log.info(`AI Fleet running at http://localhost:${CONFIG.PORT}`);
  // Start the enrichment scheduler (reconciles interrupted jobs on boot).
  scheduler.startScheduler();
  // Start the code-writer board monitor so that once the planner marks a project
  // `aiplanned`, its coding tasks are picked up automatically (no manual
  // /api/coder/monitor start). Idempotent; each poll self-guards on missing keys.
  coderMonitor.start();
});

module.exports = app;
