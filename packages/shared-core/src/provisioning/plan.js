'use strict';

const crypto = require('crypto');
const { names, urls } = require('./naming');

const ORG_S2S_TOKEN_CONTEXT = 'ai-fleet-org-s2s-v1\0';

function deriveOrgInternalToken(signingKey, orgId) {
  const key = String(signingKey || '');
  const scope = String(orgId || '').trim();
  if (!key || !scope) return '';
  return crypto
    .createHmac('sha256', key)
    .update(`${ORG_S2S_TOKEN_CONTEXT}${scope}`, 'utf8')
    .digest('base64url');
}

/** Coerce a value into a GCP-label-safe value: lowercase [a-z0-9_-], <=63 chars. */
function labelValue(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 63);
}

/**
 * Build the full per-tenant resource inventory (plain data) for a deployment
 * slug. This mirrors deploy/gcp/terraform/{cloud_run,pubsub,scheduler}.tf but for
 * ONE tenant, composed at runtime. It is pure — the executor turns it into GCP
 * API calls; tests assert the wiring here without touching GCP.
 *
 * Tenant-isolation invariants encoded here:
 *   - STORE_NAMESPACE = slug on every service/job → isolated Firestore store +
 *     SSE events (see packages/shared/src/config.js namespaceCollection).
 *   - PER-TENANT Pub/Sub topics (planner-<slug>/coder-<slug>) — never shared,
 *     which would fan a tenant's messages to every tenant.
 *   - ORG_URL/SETTINGS_URL = the SHARED control-plane services (org/settings stay
 *     shared); PLANNER_URL/CODER_URL = this tenant's own services.
 *   - planner/coder/pipeline services have no allUsers binding; their IAM
 *     invokers are the gateway and/or push SA. Ingress defaults to ALL so the
 *     run.app path works without VPC egress, while IAM remains fail-closed.
 *     ONLY the gateway is unauthenticated at Cloud Run — app-auth guards it.
 *
 * @param {string} slug
 * @param {object} cfg
 * @param {string} cfg.projectId
 * @param {string|number} cfg.projectNumber
 * @param {string} cfg.region
 * @param {string} cfg.sharedOrgUrl        SHARED org service URL
 * @param {string} cfg.sharedSettingsUrl   SHARED settings service URL
 * @param {string} cfg.spaOrigin           SPA origin(s) for the tenant gateway CORS
 * @param {string} cfg.firebaseProjectId
 * @param {string} cfg.firebaseApiKey
 * @param {string} cfg.deadLetterTopic     shared dead-letter topic id
 * @param {string} cfg.emailTopic          shared transactional email topic id
 * @param {object} cfg.serviceAccounts     { gateway, planner, coder, pubsubPush } emails
 */
function buildPlan(slug, cfg) {
  const n = names(slug);
  const u = urls(slug, cfg);
  const sa = cfg.serviceAccounts || {};
  const pipelineEnabled = cfg.pipelineOrchestratorEnabled === true;
  const orgInternalToken = deriveOrgInternalToken(cfg.orgS2sSigningKey, cfg.orgId);
  if (cfg.orgId && !orgInternalToken) {
    throw new Error('per-tenant egress proxy requires the org S2S signing key');
  }
  // run.app calls from the tenant gateway require network-reachable ingress;
  // Cloud Run IAM (never allUsers) is the authorization boundary. Operators
  // with Direct VPC egress may explicitly choose INTERNAL_ONLY.
  const internalIngress = cfg.internalIngress || 'INGRESS_TRAFFIC_ALL';
  // The SHARED services whose image + secret env + resources each tenant service
  // is cloned from (the GCP adapter reads these; "reuse original builds").
  const srcNames = cfg.sourceServiceNames || {};

  // GCP labels stamped on every per-tenant resource so an org's stack is
  // filterable/attributable in the console + billing export (and safe to
  // identify for teardown). `organization` is the actual org id; `tenant` is the
  // opaque slug. Label values must be [a-z0-9_-], <=63 chars — sanitized here.
  const baseLabels = {
    'managed-by': 'ai-fleet-provisioner',
    tenancy: 'dedicated',
    tenant: slug,
    ...(cfg.orgId ? { organization: labelValue(cfg.orgId) } : {}),
  };
  const withComponent = (component) => ({ ...baseLabels, component });

  // Env shared by every per-tenant Node service/job (cloud profile).
  const commonEnv = {
    NODE_ENV: 'production',
    GCP_PROJECT_ID: cfg.projectId,
    STORE_BACKEND: 'firestore',
    MESSAGING_MODE: 'pubsub',
    EVENTS_BACKEND: 'firestore',
    AUTH_MODE: 'firebase',
    FIREBASE_PROJECT_ID: cfg.firebaseProjectId || cfg.projectId,
    FIREBASE_API_KEY: cfg.firebaseApiKey || '',
    AI_FLEET_DATA_DIR: '/tmp',
    // The isolation switch — this tenant's own Firestore store + SSE namespace.
    STORE_NAMESPACE: slug,
    PUBSUB_PLANNER_TOPIC: n.plannerTopic,
    PUBSUB_CODER_TOPIC: n.coderTopic,
    PIPELINE_ORCHESTRATOR_ENABLED: String(pipelineEnabled),
    PIPELINE_DEPLOYMENT_ENABLED: String(cfg.pipelineDeploymentEnabled === true),
    ...(pipelineEnabled ? {
      PUBSUB_PIPELINE_PLAN_TOPIC: n.pipelinePlanTopic,
      PUBSUB_PIPELINE_CODE_TOPIC: n.pipelineCodeTopic,
      PUBSUB_PIPELINE_TEST_TOPIC: n.pipelineTestTopic,
      PUBSUB_PIPELINE_DEPLOY_TOPIC: n.pipelineDeployTopic,
      PIPELINE_STAGE_STORE_BACKEND: 'firestore',
    } : {}),
    ...(cfg.orgId ? { FLEET_ORG_ID: cfg.orgId } : {}),
  };

  // Credential-bearing workloads always use their co-located egress proxy.
  // Gateway and orchestrator deliberately do not inherit this URL: gateway has
  // a separate stream-token broker and orchestrator has no provider egress.
  const agentEnv = {
    ...commonEnv,
    EGRESS_PROXY_URL: 'http://127.0.0.1:4030',
  };

  // Per-tenant patch overlaid onto the cloned egress-proxy SIDECAR container
  // (planner/coder/worker). It needs this tenant's store namespace (to read the
  // tenant's OAuth token sets) and org id + derived bearer (to resolve only that
  // tenant's encrypted vault). The derivation root remains in settings and the
  // provisioner; it is never cloned into an agent or proxy container.
  const sidecarEnv = {
    PROXY_CAPABILITIES: 'egress',
    GCP_PROJECT_ID: cfg.projectId,
    STORE_BACKEND: 'firestore',
    MESSAGING_MODE: 'pubsub',
    STORE_NAMESPACE: slug,
    ...(cfg.orgId ? { PROXY_ORG_ID: cfg.orgId } : {}),
    ...(orgInternalToken ? { ORG_INTERNAL_API_TOKEN: orgInternalToken } : {}),
  };

  const gateway = {
    name: n.gateway,
    sourceName: srcNames.gateway,
    labels: withComponent('gateway'),
    url: u.gateway,
    ingress: 'INGRESS_TRAFFIC_ALL',
    allowUnauthenticated: true, // public origin, app-auth (Firebase) guarded
    port: 8080,
    serviceAccount: sa.gateway,
    sidecarEnv: { PROXY_CAPABILITIES: 'stream-token' },
    requireProxySidecar: true,
    forbidProviderSecretsOnPrimary: true,
    env: {
      ...commonEnv,
      STREAM_TOKEN_PROXY_URL: 'http://127.0.0.1:4030',
      AUTH_MODE: 'firebase',
      TRUST_PROXY_HOPS: '1',
      SPA_ORIGIN: cfg.spaOrigin || '',
      API_BASE_URL: u.gateway,
      PLANNER_URL: u.planner, // this tenant's planner
      CODER_URL: u.coder, //     this tenant's coder-control
      ...(pipelineEnabled ? { ORCHESTRATOR_URL: u.orchestrator } : {}),
      ORG_URL: cfg.sharedOrgUrl, //       SHARED
      SETTINGS_URL: cfg.sharedSettingsUrl, // SHARED
      FIREBASE_PROJECT_ID: cfg.firebaseProjectId || cfg.projectId,
      FIREBASE_API_KEY: cfg.firebaseApiKey || '',
    },
  };

  const planner = {
    name: n.planner,
    sourceName: srcNames.planner,
    labels: withComponent('planner'),
    url: u.planner,
    ingress: internalIngress,
    allowUnauthenticated: false,
    port: 8080,
    serviceAccount: sa.planner,
    ...(pipelineEnabled ? { maxInstanceCount: 1, requestTimeoutSeconds: 3600 } : {}),
    invokers: [sa.gateway, sa.pubsubPush].filter(Boolean),
    sidecarEnv,
    requireSecretFreePrimary: true,
    requireEgressProxy: true,
    env: {
      ...agentEnv,
      PLANNER_PORT: '8080',
      // Transactional email stays shared; tenant planners publish billing
      // alerts to the allow-listed queue rather than cloning an SMTP service.
      EMAIL_TOPIC: cfg.emailTopic || 'email-delivery',
      PUBSUB_PUSH_AUDIENCE: u.planner,
      PUBSUB_PUSH_SA: sa.pubsubPush || '',
      ...(pipelineEnabled ? { PUBSUB_PIPELINE_PLAN_RESULTS_TOPIC: n.pipelinePlanResultsTopic } : {}),
    },
  };

  const coder = {
    name: n.coder,
    sourceName: srcNames.coder,
    labels: withComponent('coder-control'),
    url: u.coder,
    ingress: internalIngress,
    allowUnauthenticated: false,
    port: 8080,
    serviceAccount: sa.coder,
    ...(pipelineEnabled ? { maxInstanceCount: 1, requestTimeoutSeconds: 3600 } : {}),
    invokers: [sa.gateway, sa.pubsubPush].filter(Boolean),
    sidecarEnv,
    requireSecretFreePrimary: true,
    requireEgressProxy: true,
    env: {
      ...agentEnv,
      CODER_SERVICE_PORT: '8080',
      CODER_ROLE: 'control',
      CODER_JOB_NAME: n.worker, // launches this tenant's worker job
      PUBSUB_PUSH_AUDIENCE: u.coder,
      PUBSUB_PUSH_SA: sa.pubsubPush || '',
      ...(pipelineEnabled ? { PUBSUB_PIPELINE_CODE_RESULTS_TOPIC: n.pipelineCodeResultsTopic } : {}),
    },
  };

  const worker = {
    name: n.worker,
    sourceName: srcNames.worker,
    labels: withComponent('coder-worker'),
    serviceAccount: sa.coder,
    sidecarEnv,
    requireSecretFreePrimary: true,
    requireEgressProxy: true,
    env: {
      ...agentEnv,
      CODER_ROLE: 'worker',
      HOME: '/tmp',
      CODER_WORKSPACE_ROOT: '/tmp/coder-workspaces',
      CODER_PLANNED_WORKSPACE_ROOT: '/tmp/coder-git-workspace',
    },
  };

  const orchestrator = pipelineEnabled ? {
    name: n.orchestrator,
    sourceName: srcNames.orchestrator,
    labels: withComponent('pipeline-orchestrator'),
    url: u.orchestrator,
    ingress: internalIngress,
    allowUnauthenticated: false,
    port: 8080,
    serviceAccount: sa.orchestrator,
    invokers: [sa.gateway, sa.pubsubPush].filter(Boolean),
    env: {
      ...commonEnv,
      ORCHESTRATOR_SERVICE_PORT: '8080',
      ORCHESTRATOR_URL: u.orchestrator,
      SETTINGS_URL: cfg.sharedSettingsUrl,
      PIPELINE_STORE_BACKEND: 'firestore',
      PIPELINE_RESULTS_AUDIENCE: u.orchestrator,
      PIPELINE_RESULTS_ALLOWED_EMAILS: sa.pubsubPush || '',
      PUBSUB_PUSH_AUDIENCE: u.orchestrator,
      PUBSUB_PUSH_SA: sa.pubsubPush || '',
    },
  } : null;

  const tester = pipelineEnabled ? {
    name: n.tester,
    sourceName: srcNames.tester,
    labels: withComponent('pipeline-tester'),
    url: u.tester,
    ingress: internalIngress,
    allowUnauthenticated: false,
    port: 8080,
    serviceAccount: sa.tester,
    maxInstanceCount: 1,
    requestTimeoutSeconds: 3600,
    invokers: [sa.pubsubPush].filter(Boolean),
    sidecarEnv,
    requireSecretFreePrimary: true,
    requireEgressProxy: true,
    env: {
      ...agentEnv,
      TESTER_SERVICE_PORT: '8080',
      SETTINGS_URL: cfg.sharedSettingsUrl,
      ORG_URL: cfg.sharedOrgUrl,
      ORCHESTRATOR_URL: u.orchestrator,
      PUBSUB_PIPELINE_TEST_RESULTS_TOPIC: n.pipelineTestResultsTopic,
      PUBSUB_PUSH_AUDIENCE: u.tester,
      PUBSUB_PUSH_SA: sa.pubsubPush || '',
    },
  } : null;

  const deployer = pipelineEnabled ? {
    name: n.deployer,
    sourceName: srcNames.deployer,
    labels: withComponent('pipeline-deployer'),
    url: u.deployer,
    ingress: internalIngress,
    allowUnauthenticated: false,
    port: 8080,
    serviceAccount: sa.deployer,
    maxInstanceCount: 1,
    requestTimeoutSeconds: 3600,
    invokers: [sa.pubsubPush].filter(Boolean),
    sidecarEnv,
    requireSecretFreePrimary: true,
    requireEgressProxy: true,
    env: {
      ...agentEnv,
      DEPLOYER_SERVICE_PORT: '8080',
      SETTINGS_URL: cfg.sharedSettingsUrl,
      ORG_URL: cfg.sharedOrgUrl,
      ORCHESTRATOR_URL: u.orchestrator,
      PUBSUB_PIPELINE_DEPLOY_RESULTS_TOPIC: n.pipelineDeployResultsTopic,
      PUBSUB_PUSH_AUDIENCE: u.deployer,
      PUBSUB_PUSH_SA: sa.pubsubPush || '',
    },
  } : null;

  const topics = [
    { name: n.plannerTopic, labels: withComponent('planner'), publishers: [sa.gateway].filter(Boolean) },
    { name: n.coderTopic, labels: withComponent('coder-control'), publishers: [sa.gateway].filter(Boolean) },
    ...(pipelineEnabled ? [
      { name: n.pipelinePlanTopic, labels: withComponent('pipeline-plan'), publishers: [sa.orchestrator].filter(Boolean) },
      { name: n.pipelineCodeTopic, labels: withComponent('pipeline-code'), publishers: [sa.orchestrator].filter(Boolean) },
      { name: n.pipelineTestTopic, labels: withComponent('pipeline-test'), publishers: [sa.orchestrator].filter(Boolean) },
      { name: n.pipelineDeployTopic, labels: withComponent('pipeline-deploy'), publishers: [sa.orchestrator].filter(Boolean) },
      { name: n.pipelinePlanResultsTopic, labels: withComponent('pipeline-plan-results'), publishers: [sa.planner].filter(Boolean) },
      { name: n.pipelineCodeResultsTopic, labels: withComponent('pipeline-code-results'), publishers: [sa.coder].filter(Boolean) },
      { name: n.pipelineTestResultsTopic, labels: withComponent('pipeline-test-results'), publishers: [sa.tester].filter(Boolean) },
      { name: n.pipelineDeployResultsTopic, labels: withComponent('pipeline-deploy-results'), publishers: [sa.deployer].filter(Boolean) },
    ] : []),
  ];
  const deadLetterSubscriber = cfg.projectNumber
    ? `service-${cfg.projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`
    : '';
  const subscriptions = [
    {
      name: n.plannerPushSub,
      topic: n.plannerTopic,
      labels: withComponent('planner'),
      pushEndpoint: `${u.planner}/pubsub/planner`,
      audience: u.planner,
      oidcServiceAccount: sa.pubsubPush,
      deadLetterTopic: cfg.deadLetterTopic,
      deadLetterSubscriber,
    },
    {
      name: n.coderPushSub,
      topic: n.coderTopic,
      labels: withComponent('coder-control'),
      pushEndpoint: `${u.coder}/pubsub/coder`,
      audience: u.coder,
      oidcServiceAccount: sa.pubsubPush,
      deadLetterTopic: cfg.deadLetterTopic,
      deadLetterSubscriber,
    },
    ...(pipelineEnabled ? [
      {
        name: n.pipelinePlanPushSub,
        topic: n.pipelinePlanTopic,
        labels: withComponent('pipeline-plan'),
        pushEndpoint: `${u.planner}/pubsub/pipeline-stage`,
        audience: u.planner,
        oidcServiceAccount: sa.pubsubPush,
        deadLetterTopic: cfg.deadLetterTopic,
        deadLetterSubscriber,
        ackDeadlineSeconds: 600,
      },
      {
        name: n.pipelineCodePushSub,
        topic: n.pipelineCodeTopic,
        labels: withComponent('pipeline-code'),
        pushEndpoint: `${u.coder}/pubsub/pipeline-stage`,
        audience: u.coder,
        oidcServiceAccount: sa.pubsubPush,
        deadLetterTopic: cfg.deadLetterTopic,
        deadLetterSubscriber,
        ackDeadlineSeconds: 600,
      },
      {
        name: n.pipelineTestPushSub,
        topic: n.pipelineTestTopic,
        labels: withComponent('pipeline-test'),
        pushEndpoint: `${u.tester}/pubsub/pipeline-stage`,
        audience: u.tester,
        oidcServiceAccount: sa.pubsubPush,
        deadLetterTopic: cfg.deadLetterTopic,
        deadLetterSubscriber,
        ackDeadlineSeconds: 600,
      },
      {
        name: n.pipelineDeployPushSub,
        topic: n.pipelineDeployTopic,
        labels: withComponent('pipeline-deploy'),
        pushEndpoint: `${u.deployer}/pubsub/pipeline-stage`,
        audience: u.deployer,
        oidcServiceAccount: sa.pubsubPush,
        deadLetterTopic: cfg.deadLetterTopic,
        deadLetterSubscriber,
        ackDeadlineSeconds: 600,
      },
      ...[
        ['plan', n.pipelinePlanResultsTopic, n.pipelinePlanResultsPushSub],
        ['code', n.pipelineCodeResultsTopic, n.pipelineCodeResultsPushSub],
        ['test', n.pipelineTestResultsTopic, n.pipelineTestResultsPushSub],
        ['deploy', n.pipelineDeployResultsTopic, n.pipelineDeployResultsPushSub],
      ].map(([stage, topic, name]) => ({
        name,
        topic,
        labels: withComponent(`pipeline-${stage}-results`),
        pushEndpoint: `${u.orchestrator}/pubsub/pipeline-stage-results/${stage}`,
        audience: u.orchestrator,
        oidcServiceAccount: sa.pubsubPush,
        deadLetterTopic: cfg.deadLetterTopic,
        deadLetterSubscriber,
      })),
    ] : []),
  ];
  const schedulers = [
    { name: n.plannerTick, uri: `${u.planner}/pubsub/planner-tick`, schedule: '*/5 * * * *', oidcServiceAccount: sa.pubsubPush, audience: u.planner },
    { name: n.coderTick, uri: `${u.coder}/pubsub/coder-tick`, schedule: '*/2 * * * *', oidcServiceAccount: sa.pubsubPush, audience: u.coder },
  ];

  return {
    slug,
    services: {
      gateway,
      planner,
      coder,
      ...(pipelineEnabled ? { orchestrator, tester, deployer } : {}),
    },
    worker,
    topics,
    subscriptions,
    schedulers,
    // Convenience view the org registry (Organization.deployments) is written from.
    deploymentUrls: {
      gateway: u.gateway,
      planner: u.planner,
      coder: u.coder,
      worker: n.worker,
      ...(pipelineEnabled ? {
        orchestrator: u.orchestrator,
        tester: u.tester,
        deployer: u.deployer,
      } : {}),
    },
  };
}

module.exports = { buildPlan, deriveOrgInternalToken };
