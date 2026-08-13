'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG } = require('@ai-fleet/shared-core/config');
const { loadConfig } = require('./config');

test('PIPELINE_ORCHESTRATOR_ENABLED is an explicit rollback switch and defaults off', () => {
  assert.equal(loadConfig({}).enabled, false);
  assert.equal(loadConfig({ PIPELINE_ORCHESTRATOR_ENABLED: 'true' }).enabled, true);
});

test('production defaults deployment approval on while deployment itself stays off', () => {
  const config = loadConfig({ NODE_ENV: 'production' });
  assert.equal(config.production, true);
  assert.equal(config.storeBackend, 'firestore');
  assert.equal(config.messagingMode, 'pubsub');
  assert.equal(config.deploymentEnabled, false);
  assert.equal(config.requireDeploymentApproval, true);
});

test('settings approval service URL is explicit and normalized', () => {
  assert.equal(loadConfig({ SETTINGS_URL: 'https://settings.example.test/' }).settingsUrl,
    'https://settings.example.test');
});

test('pipeline messaging uses dedicated StageCommand topics', () => {
  const config = loadConfig({});
  assert.deepEqual(config.stageTopics, {
    plan: 'pipeline-plan-commands',
    code: 'pipeline-code-commands',
    test: 'pipeline-test-commands',
    deploy: 'pipeline-deploy-commands',
  });
  assert.equal(config.resultsTopic, undefined);
  assert.notEqual(config.stageTopics.plan, CONFIG.GCP.plannerTopic);
  assert.notEqual(config.stageTopics.code, CONFIG.GCP.coderTopic);
  assert.equal(config.stageEndpoints.plan, `${CONFIG.SERVICES.plannerUrl}/internal/pipeline/stage`);
});

test('pipeline topic env names and push identity are configurable', () => {
  const config = loadConfig({
    PUBSUB_PIPELINE_PLAN_TOPIC: 'tenant-plan-commands',
    PUBSUB_PIPELINE_CODE_TOPIC: 'tenant-code-commands',
    PUBSUB_PIPELINE_TEST_TOPIC: 'tenant-test-commands',
    PUBSUB_PIPELINE_DEPLOY_TOPIC: 'tenant-deploy-commands',
    PUBSUB_PUSH_SA: 'pubsub@example.iam.gserviceaccount.com',
  });
  assert.deepEqual(config.stageTopics, {
    plan: 'tenant-plan-commands',
    code: 'tenant-code-commands',
    test: 'tenant-test-commands',
    deploy: 'tenant-deploy-commands',
  });
  assert.deepEqual(config.resultAllowedEmails, ['pubsub@example.iam.gserviceaccount.com']);
});
