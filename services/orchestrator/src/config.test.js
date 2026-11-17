'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG } = require('@ai-fleet/shared-core/config');
const { loadConfig } = require('./config');

test('PIPELINE_ORCHESTRATOR_ENABLED is an explicit rollback switch and defaults off', () => {
  assert.equal(loadConfig({}).enabled, false);
  assert.equal(loadConfig({ PIPELINE_ORCHESTRATOR_ENABLED: 'true' }).enabled, true);
});

test('production defaults to the durable Firestore + Pub/Sub stack with no deploy stage', () => {
  const config = loadConfig({ NODE_ENV: 'production' });
  assert.equal(config.production, true);
  assert.equal(config.storeBackend, 'firestore');
  assert.equal(config.messagingMode, 'pubsub');
  assert.equal('deploymentEnabled' in config, false);
  assert.equal('requireDeploymentApproval' in config, false);
  assert.equal('deploy' in config.stageEndpoints, false);
  assert.equal('deploy' in config.stageTopics, false);
});

test('pipeline messaging uses dedicated StageCommand topics', () => {
  const config = loadConfig({});
  assert.deepEqual(config.stageTopics, {
    plan: 'pipeline-plan-commands',
    code: 'pipeline-code-commands',
    test: 'pipeline-test-commands',
  });
  assert.equal(config.resultsTopic, undefined);
  assert.notEqual(config.stageTopics.plan, CONFIG.GCP.plannerTopic);
  assert.equal(config.stageEndpoints.plan, `${CONFIG.SERVICES.agentUrl}/internal/pipeline/stage/plan`);
});

test('pipeline topic env names and push identity are configurable', () => {
  const config = loadConfig({
    PUBSUB_PIPELINE_PLAN_TOPIC: 'tenant-plan-commands',
    PUBSUB_PIPELINE_CODE_TOPIC: 'tenant-code-commands',
    PUBSUB_PIPELINE_TEST_TOPIC: 'tenant-test-commands',
    PUBSUB_PUSH_SA: 'pubsub@example.iam.gserviceaccount.com',
  });
  assert.deepEqual(config.stageTopics, {
    plan: 'tenant-plan-commands',
    code: 'tenant-code-commands',
    test: 'tenant-test-commands',
  });
  assert.deepEqual(config.resultAllowedEmails, ['pubsub@example.iam.gserviceaccount.com']);
});
