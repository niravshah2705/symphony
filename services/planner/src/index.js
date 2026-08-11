'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared/config');
const { sendError } = require('@ai-fleet/shared/util');
const log = require('@ai-fleet/shared/logger');
const { initStore } = require('@ai-fleet/shared/store');
const scheduler = require('@ai-fleet/shared/agent/scheduler');

const agentRoutes = require('./routes/agent');
const pubsubRoutes = require('./pubsub');
const { createStoreContextMiddleware } = require('./store-context');

/**
 * Planner agent service — the isolated software-design planner. It owns the
 * /api/agent surface (config, status, candidates, jobs, run-now) and receives
 * on-demand requests + cadence ticks on /pubsub/*. The gateway proxies browser
 * reads here and publishes requests via Pub/Sub; this service is not exposed to
 * the browser directly.
 *
 * Locally the in-process scheduler loop runs (mirroring the monolith). In the
 * cloud (MESSAGING_MODE=pubsub) the service scales to zero and Cloud Scheduler
 * drives the cadence via /pubsub/planner-tick, so the setTimeout loop is skipped.
 */
const app = express();

app.use(express.json({ limit: '1mb' }));

app.use('/pubsub', pubsubRoutes);
app.use('/api/agent', createStoreContextMiddleware(), agentRoutes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  sendError(res, err);
});

initStore()
  .then(() => {
    app.listen(CONFIG.SERVICES.plannerPort, () => {
      log.info(`AI Fleet planner service running at http://localhost:${CONFIG.SERVICES.plannerPort}`);
      if (CONFIG.MESSAGING_MODE !== 'pubsub') scheduler.startScheduler();
    });
  })
  .catch((err) => {
    log.error(`planner failed to initialize store: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });

module.exports = app;
