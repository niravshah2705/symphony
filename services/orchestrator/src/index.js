'use strict';

const log = require('@ai-fleet/shared-core/logger');
const { CONFIG } = require('@ai-fleet/shared-core/config');
const {
  HttpStageCommandBus,
  createPubSubStageCommandBus,
} = require('@ai-fleet/shared-core/pipeline/bus');
const { createPipelineRepository } = require('@ai-fleet/shared-core/pipeline/repository');
const { PipelineOrchestrator } = require('./controller');
const { SnapshotPreflight } = require('./preflight');
const { createPipelineCheckpointer } = require('./checkpointer');
const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { SettingsDeploymentApproval } = require('./deployment-approval');

function createStageBus(config, options = {}) {
  const stageValue = (values, stage) => values[stage] || '';
  if (config.messagingMode === 'pubsub') {
    return createPubSubStageCommandBus({
      projectId: config.projectId,
      pubsubFactory: options.pubsubFactory,
      topicForStage: (stage) => stageValue(config.stageTopics, stage),
    });
  }
  return new HttpStageCommandBus({
    fetchImpl: options.fetchImpl || globalThis.fetch,
    endpointForStage: (stage) => stageValue(config.stageEndpoints, stage),
    headers: config.internalApiToken
      ? { 'x-internal-token': config.internalApiToken }
      : {},
  });
}

function createService(options = {}) {
  const config = options.config || loadConfig();
  if (config.production && config.storeBackend !== 'firestore') {
    throw Object.assign(new Error('Production pipeline orchestration requires the Firestore state/checkpoint backend.'), {
      code: 'pipeline_durable_store_required',
    });
  }
  if (config.production && config.messagingMode !== 'pubsub') {
    throw Object.assign(new Error('Production pipeline orchestration requires authenticated Pub/Sub messaging.'), {
      code: 'pipeline_cloud_messaging_required',
    });
  }
  const repository = options.repository || createPipelineRepository({
    backend: config.storeBackend,
    firestoreFactory: options.firestoreFactory,
  });
  const checkpointer = options.checkpointer || createPipelineCheckpointer({
    backend: config.storeBackend,
    firestoreFactory: options.firestoreFactory,
  });
  const bus = options.bus || createStageBus(config, options);
  const preflight = options.preflight || new SnapshotPreflight({
    deploymentEnabled: config.deploymentEnabled,
  });
  const deploymentApproval = options.deploymentApproval || (
    (config.deploymentEnabled || config.requireDeploymentApproval)
      ? new SettingsDeploymentApproval({
          settingsUrl: config.settingsUrl,
          internalToken: config.internalApiToken,
          cloud: config.messagingMode === 'pubsub',
        })
      : null
  );
  const orchestrator = options.orchestrator || new PipelineOrchestrator({
    repository,
    checkpointer,
    bus,
    preflight,
    deploymentApproval,
    requireDeploymentApproval: config.requireDeploymentApproval,
    log: options.logger || log,
  });
  const app = createApp({
    orchestrator,
    config,
    logger: options.logger || log,
    authenticatePush: options.authenticatePush,
    verifyResultToken: options.verifyResultToken,
  });
  return { app, orchestrator, repository, checkpointer, bus, config };
}

function start(options = {}) {
  const service = createService(options);
  if (!service.config.enabled) {
    throw Object.assign(new Error('Pipeline orchestrator is disabled (set PIPELINE_ORCHESTRATOR_ENABLED=true to start it).'), {
      code: 'pipeline_orchestrator_disabled',
    });
  }
  const server = service.app.listen(service.config.port, () => {
    log.info(`AI Fleet orchestrator listening on :${service.config.port} (${service.config.storeBackend}/${service.config.messagingMode})`);
  });
  const shutdown = () => server.close();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { createStageBus, createService, start };
