'use strict';

const express = require('express');
const { CONFIG } = require('@ai-fleet/shared/config');
const log = require('@ai-fleet/shared/logger');
const store = require('@ai-fleet/shared/store');
const { runWithWorkspaceContext } = require('@ai-fleet/shared/store/workspace-context');
const { executeTestingStage } = require('@ai-fleet/shared/agent/pipeline-stage-runtime');
const { projectStageResult } = require('@ai-fleet/shared/agent/pipeline-labels');
const {
  createStageCommandHandler,
  createStageResultPublisher,
  pipelineStageAuth,
  safeError,
} = require('@ai-fleet/shared/agent/pipeline-stage-service');

function inCommandWorkspace(operation, initStore = store.initStore) {
  return (command, ...args) => runWithWorkspaceContext({
    organizationId: command.organizationId,
    projectId: command.projectId,
  }, async () => {
    await initStore();
    return operation(command, ...args);
  });
}

function createApp(options = {}) {
  const logger = options.logger || log;
  const initStore = options.initStore || store.initStore;
  const execute = inCommandWorkspace(options.execute || executeTestingStage, initStore);
  const projectResult = inCommandWorkspace(options.projectResult || projectStageResult, initStore);
  const publish = options.publish || createStageResultPublisher(options.publisherOptions);
  const handler = createStageCommandHandler({
    stage: 'test',
    execute,
    publish,
    projectResult,
    log: logger,
    executionStore: options.executionStore,
    env: options.env,
    now: options.now,
    firestoreFactory: options.firestoreFactory,
  });
  const internalAuth = options.internalAuth || pipelineStageAuth({ mode: 'direct' });
  const pushMiddleware = options.pushAuth || pipelineStageAuth({ mode: CONFIG.MESSAGING_MODE });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: require('@ai-fleet/shared-core/pipeline/bus').MAX_STAGE_COMMAND_PUSH_BODY_BYTES }));
  app.get('/healthz', (req, res) => res.json({ status: 'ok', stage: 'test' }));
  app.get('/readyz', (req, res) => res.json({ status: 'ready', stage: 'test' }));
  app.post('/internal/pipeline/stage', internalAuth, handler);
  app.post('/pubsub/pipeline-stage', pushMiddleware, handler);
  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    if (error && error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Stage command envelope exceeds the transport budget.' });
    }
    logger.error(`tester stage request failed: ${safeError(error).message}`);
    return res.status(503).json({ error: 'Tester stage completion could not be delivered.' });
  });
  return app;
}

module.exports = { createApp, inCommandWorkspace };
