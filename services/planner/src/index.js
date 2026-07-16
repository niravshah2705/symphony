'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared/config');
const { sendError } = require('@ai-fleet/shared/util');
const log = require('@ai-fleet/shared/logger');
const scheduler = require('@ai-fleet/shared/agent/scheduler');

const agentRoutes = require('./routes/agent');

/**
 * Planner agent service — the isolated software-design planner. It owns the
 * /api/agent surface (config, status, candidates, jobs, run-now) and runs the
 * enrichment scheduler in-process. The gateway proxies browser requests here;
 * this service is not exposed to the browser directly.
 *
 * On boot it starts the scheduler (which also reconciles jobs interrupted by a
 * restart), mirroring the monolith's boot behaviour for this agent.
 */
const app = express();

app.use(express.json({ limit: '1mb' }));

app.use('/api/agent', agentRoutes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  sendError(res, err);
});

app.listen(CONFIG.SERVICES.plannerPort, () => {
  log.info(`AI Fleet planner service running at http://localhost:${CONFIG.SERVICES.plannerPort}`);
  scheduler.startScheduler();
});

module.exports = app;
