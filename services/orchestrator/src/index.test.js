'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FirestorePipelineStore } = require('@ai-fleet/shared-core/pipeline/storage');
const { createService, createStageBus } = require('./index');
const { FirestoreCheckpointBackend } = require('./checkpointer');

function config(overrides = {}) {
  return {
    enabled: true,
    production: false,
    port: 4070,
    storeBackend: 'file',
    messagingMode: 'direct',
    projectId: 'project-1',
    deploymentEnabled: false,
    requireDeploymentApproval: false,
    settingsUrl: 'http://settings',
    internalApiToken: '',
    resultAudience: '',
    resultAllowedEmails: [],
    stageEndpoints: { plan: 'http://planner/internal/pipeline/stage' },
    stageTopics: { plan: 'planner-requests' },
    ...overrides,
  };
}

test('direct stage routing uses authenticated internal HTTP endpoints', async () => {
  const requests = [];
  const bus = createStageBus(config({ internalApiToken: 'local-internal-token' }), {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 204, headers: { get: () => null } };
    },
  });
  // Validation is owned by the shared-core adapter; this assertion only checks
  // the selected endpoint without reaching a real stage service.
  bus.endpointForStage('plan');
  assert.equal(bus.endpointForStage('plan'), 'http://planner/internal/pipeline/stage');
  assert.equal(bus.headers['x-internal-token'], 'local-internal-token');
  assert.deepEqual(requests, []);
});

test('cloud service construction pairs Firestore run state with a Firestore LangGraph checkpointer', () => {
  const fakeFirestore = { collection() { throw new Error('Firestore remains lazy during construction.'); } };
  const bus = { dispatch: async () => ({ messageId: 'test', transport: 'test' }) };
  const service = createService({
    config: config({ storeBackend: 'firestore', messagingMode: 'pubsub' }),
    firestoreFactory: () => fakeFirestore,
    bus,
    authenticatePush: (req, res, next) => next(),
  });

  assert.equal(service.repository.store instanceof FirestorePipelineStore, true);
  assert.equal(service.checkpointer.backend instanceof FirestoreCheckpointBackend, true);
  assert.equal(service.repository.store.db, null);
  assert.equal(service.checkpointer.backend.db, null);
});

test('production construction refuses ephemeral run/checkpoint state', () => {
  assert.throws(() => createService({
    config: config({ production: true, storeBackend: 'file', messagingMode: 'pubsub' }),
    bus: { dispatch: async () => ({}) },
  }), (error) => error.code === 'pipeline_durable_store_required');
});

test('production construction refuses unauthenticated direct stage messaging', () => {
  assert.throws(() => createService({
    config: config({ production: true, storeBackend: 'firestore', messagingMode: 'direct' }),
    bus: { dispatch: async () => ({}) },
  }), (error) => error.code === 'pipeline_cloud_messaging_required');
});

test('deployment approval client inherits the service URL, token, and messaging mode', () => {
  const service = createService({
    config: config({
      requireDeploymentApproval: true,
      settingsUrl: 'https://settings.example.test',
      internalApiToken: 'internal-token',
      messagingMode: 'direct',
    }),
    bus: { dispatch: async () => ({}) },
  });
  assert.equal(service.orchestrator.deploymentApproval.settingsUrl, 'https://settings.example.test');
  assert.equal(service.orchestrator.deploymentApproval.internalToken, 'internal-token');
  assert.equal(service.orchestrator.deploymentApproval.cloud, false);
});

test('enabling deployment constructs the production approval client even without the all-environment flag', () => {
  const service = createService({
    config: config({
      deploymentEnabled: true,
      requireDeploymentApproval: false,
      settingsUrl: 'https://settings.example.test',
      internalApiToken: 'internal-token',
    }),
    bus: { dispatch: async () => ({}) },
  });

  assert.equal(service.orchestrator.deploymentApproval.settingsUrl, 'https://settings.example.test');
});
