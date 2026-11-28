'use strict';

/**
 * The agent HTTP surface, absorbed from the retired Cloud Run planner service.
 *
 * It is a self-contained express sub-app so the orchestrator keeps its own
 * pipeline-control middleware stack: each route group carries the JSON parser
 * and auth chain it had as a standalone service (1mb for the browser-facing
 * API, the stage-command limit for pipeline pushes, actor JWT inside the
 * substrate actor router). Mount order: pipeline stage router first, then the
 * gateway-authenticated /api routes.
 */

const express = require('express');
const { MAX_STAGE_COMMAND_PUSH_BODY_BYTES } = require('@software-factory/shared/agent/pipeline-stage-service');
const { internalServiceAuth } = require('@software-factory/shared/internal-auth');
const { sendError } = require('@software-factory/shared/util');

const agentRoutes = require('./routes/agent');
const fleetRoutes = require('./routes/fleet');
const settingsRoutes = require('./routes/settings');
const { router: codexRoutes } = require('./routes/codex');
const { router: claudeRoutes } = require('./routes/claude');
const observabilityRoutes = require('./routes/observability');
const localizationRoutes = require('./routes/localization');
const projectsRoutes = require('./routes/projects');
const issuesRoutes = require('./routes/issues');
const businessesRoutes = require('./routes/businesses');
const rolesRoutes = require('./routes/roles');
const globalQuestionsRoutes = require('./routes/global-questions');
const pubsubRoutes = require('./pubsub');
const { createPipelineStageRouter } = require('./pipeline-stage');
const { createStoreContextMiddleware } = require('./store-context');

function createAgentSurface({
  authenticate = internalServiceAuth(),
  bindStoreContext = createStoreContextMiddleware(),
  pipelineRouter = createPipelineStageRouter(),
} = {}) {
  const app = express();
  app.disable('x-powered-by');

  const stageJson = express.json({ limit: MAX_STAGE_COMMAND_PUSH_BODY_BYTES });
  app.use(['/internal/pipeline/stage', '/pubsub/pipeline-stage'], stageJson);
  app.use(pipelineRouter);

  // Retired board-monitor surface. The gateway still owns the /api/coder
  // route (auth + POST /run admission into the durable pipeline); this keeps
  // GET status honest: there is no monitor and no in-flight queue any more,
  // coding runs as substrate actors under the pipeline.
  app.get('/api/coder', (req, res) => res.json({
    running: false, paused: false, inFlight: [], backend: 'substrate',
  }));
  app.post('/api/coder/monitor', (req, res) => res.status(410).json({
    error: 'The coder board monitor is retired; the durable pipeline owns coding dispatch.',
    code: 'coder_monitor_retired',
  }));

  const apiJson = express.json({ limit: '1mb' });
  app.use('/pubsub', apiJson, pubsubRoutes);

  // Every browser-facing route below stays internal-only and is reached through
  // the gateway: the gateway keeps the public URL and authorization boundary.
  // global-questions is mounted before the general /api/agent router so these
  // paths are not swallowed by it.
  const api = [apiJson, authenticate, bindStoreContext];
  app.use('/api/agent/global-questions', ...api, globalQuestionsRoutes);
  // Fleet reads mount before the general /api/agent router so these exact
  // paths are not swallowed by it. Tenancy comes from req.fleetContext (bound
  // by bindStoreContext below), never from raw headers.
  app.use('/api/agent/fleet', ...api, fleetRoutes);
  app.use('/api/agent', ...api, agentRoutes);
  app.use('/api/settings/codex', ...api, codexRoutes);
  app.use('/api/settings/claude', ...api, claudeRoutes);
  app.use('/api/settings', ...api, settingsRoutes);
  app.use('/api/observability', ...api, observabilityRoutes);
  app.use('/api/locale', ...api, localizationRoutes);
  app.use('/api/projects', ...api, projectsRoutes);
  app.use('/api/issues', ...api, issuesRoutes);
  app.use('/api/businesses', ...api, businessesRoutes);
  app.use('/api/roles', ...api, rolesRoutes);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    sendError(res, err);
  });
  return app;
}

module.exports = { createAgentSurface };
