'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared/config');
const { sendError } = require('@ai-fleet/shared/util');
const log = require('@ai-fleet/shared/logger');
const { initStore } = require('@ai-fleet/shared/store');
const scheduler = require('@ai-fleet/shared/agent/scheduler');
const { MAX_STAGE_COMMAND_PUSH_BODY_BYTES } = require('@ai-fleet/shared/agent/pipeline-stage-service');
const { internalServiceAuth } = require('@ai-fleet/shared/internal-auth');

const agentRoutes = require('./routes/agent');
const settingsRoutes = require('./routes/settings');
const { router: codexRoutes } = require('./routes/codex');
const { router: claudeRoutes } = require('./routes/claude');
const observabilityRoutes = require('./routes/observability');
const localizationRoutes = require('./routes/localization');
const projectsRoutes = require('./routes/projects');
const issuesRoutes = require('./routes/issues');
const businessesRoutes = require('./routes/businesses');
const rolesRoutes = require('./routes/roles');
const pubsubRoutes = require('./pubsub');
const { createPlannerPipelineRouter } = require('./pipeline-stage');
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

app.use(
  ['/internal/pipeline/stage', '/pubsub/pipeline-stage'],
  express.json({ limit: MAX_STAGE_COMMAND_PUSH_BODY_BYTES }),
);
app.use(createPlannerPipelineRouter());
app.use(express.json({ limit: '1mb' }));
app.use('/pubsub', pubsubRoutes);

// Every browser-facing route below is internal-only and reached through the
// gateway. The gateway keeps the public URL and authorization boundary; the
// planner owns routes whose implementation needs model discovery, OAuth token
// refresh, analytics, runtime diagnostics, localization, or Linear access.
const bindStoreContext = createStoreContextMiddleware();
const authenticateGateway = internalServiceAuth();
app.use('/api/agent', authenticateGateway, bindStoreContext, agentRoutes);
app.use('/api/settings/codex', authenticateGateway, bindStoreContext, codexRoutes);
app.use('/api/settings/claude', authenticateGateway, bindStoreContext, claudeRoutes);
app.use('/api/settings', authenticateGateway, bindStoreContext, settingsRoutes);
app.use('/api/observability', authenticateGateway, bindStoreContext, observabilityRoutes);
app.use('/api/locale', authenticateGateway, bindStoreContext, localizationRoutes);
app.use('/api/projects', authenticateGateway, bindStoreContext, projectsRoutes);
app.use('/api/issues', authenticateGateway, bindStoreContext, issuesRoutes);
app.use('/api/businesses', authenticateGateway, bindStoreContext, businessesRoutes);
app.use('/api/roles', authenticateGateway, bindStoreContext, rolesRoutes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  sendError(res, err);
});

initStore()
  .then(() => {
    app.listen(CONFIG.SERVICES.plannerPort, () => {
      log.info(`AI Fleet planner service running at http://localhost:${CONFIG.SERVICES.plannerPort}`);
      if (CONFIG.MESSAGING_MODE !== 'pubsub' && !CONFIG.PIPELINE.orchestratorEnabled) {
        scheduler.startScheduler();
      }
    });
  })
  .catch((err) => {
    log.error(`planner failed to initialize store: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });

module.exports = app;
