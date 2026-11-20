'use strict';

const crypto = require('crypto');
const { names, urls, atespace } = require('./naming');

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
 *   - PER-TENANT Pub/Sub topics (planner-<slug> + pipeline-<stage>-<slug>) —
 *     never shared, which would fan a tenant's messages to every tenant.
 *   - ORG_URL/SETTINGS_URL = the SHARED control-plane services (org/settings stay
 *     shared); AGENT_URL/ORCHESTRATOR_URL = this tenant's own orchestrator, which
 *     hosts both the agent surface (planner browser routes + legacy planner queue)
 *     and the plan/code/test stage handlers.
 *   - orchestrator/pipeline services have no allUsers binding; their IAM
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
 * @param {string} cfg.streamTokenServiceUrl SHARED stream-token broker URL
 * @param {string} cfg.spaOrigin           SPA origin(s) for the tenant gateway CORS
 * @param {string} [cfg.customDomain]      Custom domain(s) for Firebase Hosting / tenant gateway CORS
 * @param {string} cfg.firebaseProjectId
 * @param {string} cfg.firebaseApiKey
 * @param {string} [cfg.substrateUrl]      ateapi control-plane URL for this tenant's substrate
 * @param {string} [cfg.substrateIngressUrl] public actor ingress (router) URL
 * @param {string} [cfg.substrateWorkerPool] worker pool this tenant's actors land on
 * @param {string} [cfg.substratePlannerImage] actor image
 * @param {string} cfg.deadLetterTopic     shared dead-letter topic id
 * @param {string} cfg.emailTopic          shared transactional email topic id
 * @param {object} cfg.serviceAccounts     { gateway, orchestrator, pubsubPush } emails
 */
function buildPlan(slug, cfg) {
  const n = names(slug);
  const u = urls(slug, cfg);
  const sa = cfg.serviceAccounts || {};
  const pipelineEnabled = cfg.pipelineOrchestratorEnabled === true;
  const orgInternalToken = deriveOrgInternalToken(cfg.orgS2sSigningKey, cfg.orgId);
  const streamTokenServiceUrl = String(cfg.streamTokenServiceUrl || '').trim();
  if (cfg.orgId && !orgInternalToken) {
    throw new Error('per-tenant egress proxy requires the org S2S signing key');
  }
  if (!streamTokenServiceUrl) {
    throw new Error('per-tenant gateway requires the shared stream-token service URL');
  }
  let parsedStreamTokenServiceUrl;
  try {
    parsedStreamTokenServiceUrl = new URL(streamTokenServiceUrl);
  } catch (_) {
    parsedStreamTokenServiceUrl = null;
  }
  if (!parsedStreamTokenServiceUrl
      || parsedStreamTokenServiceUrl.protocol !== 'https:'
      || parsedStreamTokenServiceUrl.username
      || parsedStreamTokenServiceUrl.password
      || parsedStreamTokenServiceUrl.search
      || parsedStreamTokenServiceUrl.hash
      || (parsedStreamTokenServiceUrl.pathname && parsedStreamTokenServiceUrl.pathname !== '/')) {
    throw new Error('per-tenant gateway requires an HTTPS shared stream-token service URL');
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
    SOFTWARE_FACTORY_DATA_DIR: '/tmp',
    // The isolation switch — this tenant's own Firestore store + SSE namespace.
    STORE_NAMESPACE: slug,
    PUBSUB_PLANNER_TOPIC: n.plannerTopic,
    PIPELINE_ORCHESTRATOR_ENABLED: String(pipelineEnabled),
    ...(pipelineEnabled ? {
      PUBSUB_PIPELINE_PLAN_TOPIC: n.pipelinePlanTopic,
      PUBSUB_PIPELINE_CODE_TOPIC: n.pipelineCodeTopic,
      PUBSUB_PIPELINE_TEST_TOPIC: n.pipelineTestTopic,
      PIPELINE_STAGE_STORE_BACKEND: 'firestore',
    } : {}),
    ...(cfg.orgId ? { FLEET_ORG_ID: cfg.orgId } : {}),
    // Substrate tenancy, pinned per tenant rather than inferred per call. The
    // atespace is a namespace boundary, so this tenant gets exactly one nameable
    // space and it is derived from the slug the resources are named after — the
    // same helper the GKE tenant step uses to create the namespace. A caller that
    // asks for another tenant's space is then ignored, not honored.
    // URLs are omitted when unset so a stack without a substrate stays inert.
    SUBSTRATE_ATESPACE: atespace(slug),
    SUBSTRATE_ALLOWED_ATESPACES: atespace(slug),
    ...(cfg.substrateUrl ? { SUBSTRATE_URL: cfg.substrateUrl } : {}),
    ...(cfg.substrateIngressUrl ? { SUBSTRATE_INGRESS_URL: cfg.substrateIngressUrl } : {}),
    ...(cfg.substrateWorkerPool ? { SUBSTRATE_WORKER_POOL: cfg.substrateWorkerPool } : {}),
    ...(cfg.substratePlannerImage ? { SUBSTRATE_PLANNER_IMAGE: cfg.substratePlannerImage } : {}),
  };

  // Credential-bearing workloads always use their co-located egress proxy.
  // The orchestrator is credential-bearing now that it hosts the agent surface
  // and the plan/code/test stage handlers. The gateway deliberately is not: it
  // calls the shared stream-token broker and has no provider egress.
  const agentEnv = {
    ...commonEnv,
    EGRESS_PROXY_URL: 'http://127.0.0.1:4030',
  };

  // Per-tenant patch overlaid onto the cloned egress-proxy SIDECAR container
  // (orchestrator). It needs this tenant's store namespace (to read the
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
    // A gateway cloned from the legacy multi-container service must converge to
    // one app container. Stream signing now belongs to the shared IAM-gated
    // broker, never a per-tenant sidecar.
    primaryContainerOnly: true,
    forbidProviderSecretsOnPrimary: true,
    env: {
      ...commonEnv,
      STREAM_TOKEN_SERVICE_URL: parsedStreamTokenServiceUrl.origin,
      AUTH_MODE: 'firebase',
      TRUST_PROXY_HOPS: '1',
      SPA_ORIGIN: cfg.spaOrigin || '',
      FIREBASE_CUSTOM_DOMAIN: cfg.customDomain || '',
      API_BASE_URL: u.gateway,
      AGENT_URL: u.orchestrator, //      this tenant's agent surface (orchestrator)
      ORCHESTRATOR_URL: u.orchestrator, //     + durable pipeline control plane
      ORG_URL: cfg.sharedOrgUrl, //       SHARED
      SETTINGS_URL: cfg.sharedSettingsUrl, // SHARED
      FIREBASE_PROJECT_ID: cfg.firebaseProjectId || cfg.projectId,
      FIREBASE_API_KEY: cfg.firebaseApiKey || '',
    },
  };

  // The orchestrator absorbs the retired planner/coder/tester services: it
  // hosts the browser-facing agent surface, the legacy planner queue, and the
  // plan/code/test stage handlers, alongside the durable pipeline control plane.
  // Its primary container runs agent code in-process, so it is a credential-
  // bearing workload (egress-proxy sidecar, secret-free primary).
  const orchestrator = {
    name: n.orchestrator,
    sourceName: srcNames.orchestrator,
    labels: withComponent('pipeline-orchestrator'),
    url: u.orchestrator,
    ingress: internalIngress,
    allowUnauthenticated: false,
    port: 8080,
    serviceAccount: sa.orchestrator,
    maxInstanceCount: 1,
    requestTimeoutSeconds: 3600,
    invokers: [sa.gateway, sa.pubsubPush].filter(Boolean),
    sidecarEnv,
    requireSecretFreePrimary: true,
    requireEgressProxy: true,
    env: {
      ...agentEnv,
      ORCHESTRATOR_SERVICE_PORT: '8080',
      AGENT_SERVICE_PORT: '8080',
      ORCHESTRATOR_URL: u.orchestrator,
      AGENT_URL: u.orchestrator,
      SETTINGS_URL: cfg.sharedSettingsUrl,
      ORG_URL: cfg.sharedOrgUrl,
      EMAIL_TOPIC: cfg.emailTopic || 'email-delivery',
      PIPELINE_STORE_BACKEND: 'firestore',
      PIPELINE_RESULTS_AUDIENCE: u.orchestrator,
      PIPELINE_RESULTS_ALLOWED_EMAILS: sa.pubsubPush || '',
      PUBSUB_PUSH_AUDIENCE: u.orchestrator,
      PUBSUB_PUSH_SA: sa.pubsubPush || '',
      ...(pipelineEnabled ? {
        PUBSUB_PIPELINE_PLAN_RESULTS_TOPIC: n.pipelinePlanResultsTopic,
        PUBSUB_PIPELINE_CODE_RESULTS_TOPIC: n.pipelineCodeResultsTopic,
        PUBSUB_PIPELINE_TEST_RESULTS_TOPIC: n.pipelineTestResultsTopic,
      } : {}),
    },
  };

  const topics = [
    { name: n.plannerTopic, labels: withComponent('planner'), publishers: [sa.gateway].filter(Boolean) },
    ...(pipelineEnabled ? [
      { name: n.pipelinePlanTopic, labels: withComponent('pipeline-plan'), publishers: [sa.orchestrator].filter(Boolean) },
      { name: n.pipelineCodeTopic, labels: withComponent('pipeline-code'), publishers: [sa.orchestrator].filter(Boolean) },
      { name: n.pipelineTestTopic, labels: withComponent('pipeline-test'), publishers: [sa.orchestrator].filter(Boolean) },
      { name: n.pipelinePlanResultsTopic, labels: withComponent('pipeline-plan-results'), publishers: [sa.orchestrator].filter(Boolean) },
      { name: n.pipelineCodeResultsTopic, labels: withComponent('pipeline-code-results'), publishers: [sa.orchestrator].filter(Boolean) },
      { name: n.pipelineTestResultsTopic, labels: withComponent('pipeline-test-results'), publishers: [sa.orchestrator].filter(Boolean) },
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
      pushEndpoint: `${u.orchestrator}/pubsub/planner`,
      audience: u.orchestrator,
      oidcServiceAccount: sa.pubsubPush,
      deadLetterTopic: cfg.deadLetterTopic,
      deadLetterSubscriber,
    },
    ...(pipelineEnabled ? [
      ...[
        ['plan', n.pipelinePlanTopic, n.pipelinePlanPushSub],
        ['code', n.pipelineCodeTopic, n.pipelineCodePushSub],
        ['test', n.pipelineTestTopic, n.pipelineTestPushSub],
      ].map(([stage, topic, name]) => ({
        name,
        topic,
        labels: withComponent(`pipeline-${stage}`),
        // Stage-bound path segments, one per stage: a shared plain path on one
        // handler would let a wrong-stage command be silently 204-acked.
        pushEndpoint: `${u.orchestrator}/pubsub/pipeline-stage/${stage}`,
        audience: u.orchestrator,
        oidcServiceAccount: sa.pubsubPush,
        deadLetterTopic: cfg.deadLetterTopic,
        deadLetterSubscriber,
        ackDeadlineSeconds: 600,
      })),
      ...[
        ['plan', n.pipelinePlanResultsTopic, n.pipelinePlanResultsPushSub],
        ['code', n.pipelineCodeResultsTopic, n.pipelineCodeResultsPushSub],
        ['test', n.pipelineTestResultsTopic, n.pipelineTestResultsPushSub],
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
    { name: n.plannerTick, uri: `${u.orchestrator}/pubsub/planner-tick`, schedule: '*/5 * * * *', oidcServiceAccount: sa.pubsubPush, audience: u.orchestrator },
  ];

  return {
    slug,
    services: {
      gateway,
      orchestrator,
    },
    topics,
    subscriptions,
    schedulers,
    // Convenience view the org registry (Organization.deployments) is written from.
    deploymentUrls: {
      gateway: u.gateway,
      orchestrator: u.orchestrator,
    },
  };
}

module.exports = { buildPlan, deriveOrgInternalToken };
