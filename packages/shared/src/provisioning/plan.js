'use strict';

const { names, urls } = require('./naming');

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
 *   - planner/coder ingress INTERNAL + IAM invoker = [gateway SA, push SA] only;
 *     ONLY the gateway is public (allUsers) — app-auth guarded.
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
 * @param {object} cfg.serviceAccounts     { gateway, planner, coder, pubsubPush } emails
 */
function buildPlan(slug, cfg) {
  const n = names(slug);
  const u = urls(slug, cfg);
  const sa = cfg.serviceAccounts || {};
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
    GCP_PROJECT_ID: cfg.projectId,
    STORE_BACKEND: 'firestore',
    MESSAGING_MODE: 'pubsub',
    EVENTS_BACKEND: 'firestore',
    // The isolation switch — this tenant's own Firestore store + SSE namespace.
    STORE_NAMESPACE: slug,
    PUBSUB_PLANNER_TOPIC: n.plannerTopic,
    PUBSUB_CODER_TOPIC: n.coderTopic,
  };

  // Per-tenant patch overlaid onto the cloned egress-proxy SIDECAR container
  // (planner/coder/worker). It needs this tenant's store namespace (to read the
  // tenant's OAuth token sets) and org id (to resolve the tenant's encrypted
  // vault). The proxy's managed keys + SETTINGS_URL + INTERNAL_API_TOKEN are
  // cloned from the shared source sidecar's own env.
  const sidecarEnv = {
    GCP_PROJECT_ID: cfg.projectId,
    STORE_BACKEND: 'firestore',
    MESSAGING_MODE: 'pubsub',
    STORE_NAMESPACE: slug,
    ...(cfg.orgId ? { PROXY_ORG_ID: cfg.orgId } : {}),
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
    env: {
      ...commonEnv,
      AUTH_MODE: 'firebase',
      SPA_ORIGIN: cfg.spaOrigin || '',
      API_BASE_URL: u.gateway,
      PLANNER_URL: u.planner, // this tenant's planner
      CODER_URL: u.coder, //     this tenant's coder-control
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
    ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
    allowUnauthenticated: false,
    port: 8080,
    serviceAccount: sa.planner,
    invokers: [sa.gateway, sa.pubsubPush].filter(Boolean),
    sidecarEnv,
    env: {
      ...commonEnv,
      PLANNER_PORT: '8080',
      PUBSUB_PUSH_AUDIENCE: u.planner,
      PUBSUB_PUSH_SA: sa.pubsubPush || '',
    },
  };

  const coder = {
    name: n.coder,
    sourceName: srcNames.coder,
    labels: withComponent('coder-control'),
    url: u.coder,
    ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
    allowUnauthenticated: false,
    port: 8080,
    serviceAccount: sa.coder,
    invokers: [sa.gateway, sa.pubsubPush].filter(Boolean),
    sidecarEnv,
    env: {
      ...commonEnv,
      CODER_SERVICE_PORT: '8080',
      CODER_ROLE: 'control',
      CODER_JOB_NAME: n.worker, // launches this tenant's worker job
      PUBSUB_PUSH_AUDIENCE: u.coder,
      PUBSUB_PUSH_SA: sa.pubsubPush || '',
    },
  };

  const worker = {
    name: n.worker,
    sourceName: srcNames.worker,
    labels: withComponent('coder-worker'),
    serviceAccount: sa.coder,
    sidecarEnv,
    env: {
      ...commonEnv,
      CODER_ROLE: 'worker',
      HOME: '/tmp',
      CODER_WORKSPACE_ROOT: '/tmp/coder-workspaces',
      CODER_PLANNED_WORKSPACE_ROOT: '/tmp/coder-git-workspace',
    },
  };

  const topics = [
    { name: n.plannerTopic, labels: withComponent('planner') },
    { name: n.coderTopic, labels: withComponent('coder-control') },
  ];
  const subscriptions = [
    {
      name: n.plannerPushSub,
      topic: n.plannerTopic,
      labels: withComponent('planner'),
      pushEndpoint: `${u.planner}/pubsub/planner`,
      audience: u.planner,
      oidcServiceAccount: sa.pubsubPush,
      deadLetterTopic: cfg.deadLetterTopic,
    },
    {
      name: n.coderPushSub,
      topic: n.coderTopic,
      labels: withComponent('coder-control'),
      pushEndpoint: `${u.coder}/pubsub/coder`,
      audience: u.coder,
      oidcServiceAccount: sa.pubsubPush,
      deadLetterTopic: cfg.deadLetterTopic,
    },
  ];
  const schedulers = [
    { name: n.plannerTick, uri: `${u.planner}/pubsub/planner-tick`, schedule: '*/5 * * * *', oidcServiceAccount: sa.pubsubPush, audience: u.planner },
    { name: n.coderTick, uri: `${u.coder}/pubsub/coder-tick`, schedule: '*/2 * * * *', oidcServiceAccount: sa.pubsubPush, audience: u.coder },
  ];

  return {
    slug,
    services: { gateway, planner, coder },
    worker,
    topics,
    subscriptions,
    schedulers,
    // Convenience view the org registry (Organization.deployments) is written from.
    deploymentUrls: { gateway: u.gateway, planner: u.planner, coder: u.coder, worker: n.worker },
  };
}

module.exports = { buildPlan };
