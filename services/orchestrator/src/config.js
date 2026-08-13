'use strict';

const { CONFIG } = require('@ai-fleet/shared-core/config');

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function stageEndpoint(base, override) {
  if (override) return String(override).trim();
  return base ? `${String(base).replace(/\/$/, '')}/internal/pipeline/stage` : '';
}

function loadConfig(env = process.env) {
  const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  return Object.freeze({
    production,
    enabled: bool(env.PIPELINE_ORCHESTRATOR_ENABLED, false),
    port: Number(env.ORCHESTRATOR_SERVICE_PORT) || CONFIG.SERVICES.orchestratorPort || 4070,
    storeBackend: String(
      env.PIPELINE_STORE_BACKEND || env.STORE_BACKEND || (production ? 'firestore' : CONFIG.STORE_BACKEND || 'file'),
    ).trim().toLowerCase(),
    messagingMode: String(env.MESSAGING_MODE || (production ? 'pubsub' : CONFIG.MESSAGING_MODE || 'direct')).trim().toLowerCase(),
    projectId: env.GCP_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || CONFIG.GCP.projectId || '',
    deploymentEnabled: bool(env.PIPELINE_DEPLOYMENT_ENABLED, false),
    requireDeploymentApproval: bool(env.PIPELINE_REQUIRE_DEPLOYMENT_APPROVAL, production),
    settingsUrl: String(env.SETTINGS_URL || CONFIG.SERVICES.settingsUrl || '').replace(/\/+$/, ''),
    internalApiToken: String(env.INTERNAL_API_TOKEN || '').trim(),
    resultAudience: String(
      env.PIPELINE_RESULTS_AUDIENCE
      || env.PUBSUB_PUSH_AUDIENCE
      || CONFIG.GCP.pushAudience
      || CONFIG.SERVICES.orchestratorUrl
      || '',
    ).trim(),
    resultAllowedEmails: csv(
      env.PIPELINE_RESULTS_ALLOWED_EMAILS || env.PUBSUB_PUSH_SA || CONFIG.GCP.pushServiceAccount,
    ),
    stageEndpoints: Object.freeze({
      plan: stageEndpoint(CONFIG.SERVICES.plannerUrl, env.PIPELINE_PLAN_URL),
      code: stageEndpoint(CONFIG.SERVICES.coderUrl, env.PIPELINE_CODE_URL),
      test: stageEndpoint(CONFIG.SERVICES.testerUrl, env.PIPELINE_TEST_URL),
      deploy: stageEndpoint(CONFIG.SERVICES.deployerUrl, env.PIPELINE_DEPLOY_URL),
    }),
    stageTopics: Object.freeze({
      plan: String(env.PUBSUB_PIPELINE_PLAN_TOPIC || CONFIG.GCP.pipelinePlanTopic).trim(),
      code: String(env.PUBSUB_PIPELINE_CODE_TOPIC || CONFIG.GCP.pipelineCodeTopic).trim(),
      test: String(env.PUBSUB_PIPELINE_TEST_TOPIC || CONFIG.GCP.pipelineTestTopic).trim(),
      deploy: String(env.PUBSUB_PIPELINE_DEPLOY_TOPIC || CONFIG.GCP.pipelineDeployTopic).trim(),
    }),
  });
}

module.exports = { loadConfig };
