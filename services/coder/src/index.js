'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared/config');
const { sendError } = require('@ai-fleet/shared/util');
const log = require('@ai-fleet/shared/logger');
const { initStore } = require('@ai-fleet/shared/store');
const coderMonitor = require('@ai-fleet/shared/agent/coder-orchestrator');

const coderRoutes = require('./routes/coder');
const pubsubRoutes = require('./pubsub');

/**
 * Coder agent service (coder-control). It owns the /api/coder surface (status,
 * run one ticket, start/stop the monitor) and receives on-demand requests +
 * board-poll ticks on /pubsub/*. Long coder work runs as a Cloud Run Job worker
 * (services/coder/src/job.js), not in this process.
 *
 * The CODER_ROLE=worker entrypoint (job.js) is selected in the container; this
 * file is the control-plane service (default role). Locally the in-process board
 * monitor runs; in the cloud (MESSAGING_MODE=pubsub) the service scales to zero
 * and Cloud Scheduler drives polling via /pubsub/coder-tick.
 */
const app = express();

app.use(express.json({ limit: '1mb' }));

app.use('/pubsub', pubsubRoutes);
app.use('/api/coder', coderRoutes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  sendError(res, err);
});

initStore()
  .then(() => {
    app.listen(CONFIG.SERVICES.coderPort, () => {
      log.info(`AI Fleet coder service running at http://localhost:${CONFIG.SERVICES.coderPort}`);
      if (CONFIG.MESSAGING_MODE !== 'pubsub') coderMonitor.start();
    });
  })
  .catch((err) => {
    log.error(`coder failed to initialize store: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });

module.exports = app;
