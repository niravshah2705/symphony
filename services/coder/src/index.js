'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared/config');
const { sendError } = require('@ai-fleet/shared/util');
const log = require('@ai-fleet/shared/logger');
const coderMonitor = require('@ai-fleet/shared/agent/coder-orchestrator');

const coderRoutes = require('./routes/coder');

/**
 * Coder agent service — the isolated code-writer. It owns the /api/coder
 * surface (monitor status, run one ticket, start/stop the board monitor) and
 * runs the board monitor in-process. The gateway proxies browser requests here;
 * this service is not exposed to the browser directly.
 *
 * On boot it starts the board monitor so that once the planner marks a project
 * `aiplanned`, its coding tasks are picked up automatically (idempotent; each
 * poll self-guards on missing keys), mirroring the monolith's boot behaviour.
 */
const app = express();

app.use(express.json({ limit: '1mb' }));

app.use('/api/coder', coderRoutes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  sendError(res, err);
});

app.listen(CONFIG.SERVICES.coderPort, () => {
  log.info(`AI Fleet coder service running at http://localhost:${CONFIG.SERVICES.coderPort}`);
  coderMonitor.start();
});

module.exports = app;
