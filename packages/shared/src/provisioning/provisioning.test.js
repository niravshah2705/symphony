'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { names, urls, assertSlug, atespace } = require('./naming');
const { buildPlan } = require('./plan');
const { provision, teardown } = require('./provisioner');
const { createGcpClients } = require('./index');

const SLUG = 't3f9a1b2c4d5';
const ORG_ID = '3f9a1b2c-4d5e-6f70-8a90-b1c2d3e4f5a6';
const CFG = {
  orgId: ORG_ID,
  projectId: 'proj',
  projectNumber: '123456',
  region: 'us-central1',
  sharedOrgUrl: 'https://org-shared.run.app',
  sharedSettingsUrl: 'https://settings-shared.run.app',
  streamTokenServiceUrl: 'https://stream-token-broker-shared.run.app',
  spaOrigin: 'https://spa.web.app',
  firebaseProjectId: 'proj',
  firebaseApiKey: 'fb-key',
  deadLetterTopic: 'agent-requests-deadletter',
  emailTopic: 'email-delivery',
  orgS2sSigningKey: 'test-org-signing-key-0123456789abcdef',
  serviceAccounts: { gateway: 'gw@sa', orchestrator: 'po@sa', pubsubPush: 'push@sa' },
  sourceServiceNames: { gateway: 'gateway', orchestrator: 'pipeline-orchestrator' },
};

function fakeClients(overrides = {}) {
  const calls = { createService: [], createTopic: [], createPushSubscription: [], createSchedulerJob: [], deletes: [], imageReads: [] };
  const base = {
    calls,
    getServiceImage: async (name) => { calls.imageReads.push(name); return `registry/${name}:sha256abc`; },
    createService: async (spec) => { calls.createService.push(spec); },
    createTopic: async (name) => { calls.createTopic.push(name); },
    createPushSubscription: async (spec) => { calls.createPushSubscription.push(spec); },
    createSchedulerJob: async (spec) => { calls.createSchedulerJob.push(spec); },
    deleteService: async (n) => { calls.deletes.push(['service', n]); },
    deleteTopic: async (n) => { calls.deletes.push(['topic', n]); },
    deleteSubscription: async (n) => { calls.deletes.push(['sub', n]); },
    deleteSchedulerJob: async (n) => { calls.deletes.push(['sched', n]); },
  };
  return { ...base, ...overrides };
}

function alreadyExists() {
  return Object.assign(new Error('already exists'), { code: 6 });
}

function completedOperation(onPromise = () => {}) {
  return {
    async promise() {
      onPromise();
      return [];
    },
  };
}

function envEntries(container) {
  return Object.fromEntries((container.env || []).map((entry) => [entry.name, entry]));
}

// --- naming ------------------------------------------------------------------

test('names + urls are deterministic and Run-safe', () => {
  const n = names(SLUG);
  assert.equal(n.gateway, 'gw-t3f9a1b2c4d5');
  assert.equal(n.orchestrator, 'po-t3f9a1b2c4d5');
  assert.equal(n.plannerTopic, 'planner-t3f9a1b2c4d5');
  assert.equal(n.plannerTick, 'planner-tick-t3f9a1b2c4d5');
  const u = urls(SLUG, CFG);
  assert.equal(u.gateway, 'https://gw-t3f9a1b2c4d5-123456.us-central1.run.app');
  assert.equal(u.orchestrator, 'https://po-t3f9a1b2c4d5-123456.us-central1.run.app');
});

test('assertSlug rejects unsafe / client-shaped values', () => {
  for (const bad of ['', 'abc', 'T3f9', 't3f9_bad', 't3f9/../x', 't3f9 space', 123, null]) {
    assert.throws(() => assertSlug(bad), /invalid deployment slug/);
  }
  assert.equal(assertSlug(SLUG), SLUG);
});

// --- plan --------------------------------------------------------------------

test('plan encodes tenant isolation: STORE_NAMESPACE, per-tenant topics, shared org/settings', () => {
  const plan = buildPlan(SLUG, CFG);
  const u = urls(SLUG, CFG);

  // STORE_NAMESPACE = slug everywhere (the isolation switch).
  for (const svc of [plan.services.gateway, plan.services.orchestrator]) {
    assert.equal(svc.env.STORE_NAMESPACE, SLUG);
    assert.equal(svc.env.MESSAGING_MODE, 'pubsub');
    assert.equal(svc.env.STORE_BACKEND, 'firestore');
    assert.equal(svc.env.PUBSUB_PLANNER_TOPIC, 'planner-' + SLUG);
  }
  assert.equal(plan.services.orchestrator.env.EMAIL_TOPIC, 'email-delivery');
  // Per-tenant topics.
  assert.deepEqual(plan.topics.map((t) => t.name), ['planner-' + SLUG]);
  // Gateway: this tenant's orchestrator surface, SHARED org/settings.
  assert.equal(plan.services.gateway.env.AGENT_URL, u.orchestrator);
  assert.equal(plan.services.gateway.env.ORCHESTRATOR_URL, u.orchestrator);
  assert.equal(plan.services.gateway.env.PLANNER_URL, undefined);
  assert.equal(plan.services.gateway.env.CODER_URL, undefined);
  assert.equal(plan.services.gateway.env.ORG_URL, CFG.sharedOrgUrl);
  assert.equal(plan.services.gateway.env.SETTINGS_URL, CFG.sharedSettingsUrl);
  assert.equal(plan.services.gateway.env.API_BASE_URL, u.gateway);
  assert.equal(plan.services.gateway.env.SPA_ORIGIN, CFG.spaOrigin);
  assert.equal(plan.services.gateway.env.FIREBASE_CUSTOM_DOMAIN, '');
  assert.equal(plan.services.gateway.env.FLEET_ORG_ID, ORG_ID);
  assert.equal(plan.services.gateway.env.TRUST_PROXY_HOPS, '1');
  assert.equal(plan.services.gateway.env.STREAM_TOKEN_SERVICE_URL, CFG.streamTokenServiceUrl);
  assert.equal(plan.services.gateway.env.STREAM_TOKEN_PROXY_URL, undefined);
  assert.equal(plan.services.gateway.env.EGRESS_PROXY_URL, undefined);
  assert.equal(plan.services.gateway.primaryContainerOnly, true);
  assert.equal(plan.services.gateway.sidecarEnv, undefined);
  for (const service of [plan.services.orchestrator]) {
    assert.equal(service.env.EGRESS_PROXY_URL, 'http://127.0.0.1:4030');
    assert.equal(service.requireSecretFreePrimary, true);
    assert.equal(service.requireEgressProxy, true);
    assert.equal(service.sidecarEnv.PROXY_CAPABILITIES, 'egress');
  }
});

// The atespace is a namespace boundary, so the name is decided once, here, from
// the validated slug — and the same helper names the GKE namespace. A tenant that
// could route itself into another tenant's space would not be a tenant.
test('plan pins the tenant substrate atespace derived from the slug', () => {
  const plan = buildPlan(SLUG, CFG);
  assert.equal(atespace(SLUG), 'tenant-t3f9a1b2c4d5');
  for (const svc of [plan.services.gateway, plan.services.orchestrator]) {
    assert.equal(svc.env.SUBSTRATE_ATESPACE, atespace(SLUG));
    assert.equal(svc.env.SUBSTRATE_ALLOWED_ATESPACES, atespace(SLUG));
    // No substrate configured for this tenant: the pattern stays inert rather
    // than pointing at another deployment's control plane.
    assert.equal(svc.env.SUBSTRATE_URL, undefined);
  }
  assert.throws(() => atespace('not-a-slug'), /invalid deployment slug/);
});

test('plan passes the substrate endpoints through when the tenant has them', () => {
  const plan = buildPlan(SLUG, {
    ...CFG,
    substrateUrl: 'https://ateapi.example.com:443',
    substrateIngressUrl: 'https://substrate.example.com',
    substrateWorkerPool: 'pool-acme',
    substratePlannerImage: 'ghcr.io/acme/planner@sha256:aaaa',
  });
  // The substrate control env lives on the tenant orchestrator — nowhere else.
  assert.equal(plan.services.orchestrator.env.SUBSTRATE_URL, 'https://ateapi.example.com:443');
  assert.equal(plan.services.orchestrator.env.SUBSTRATE_INGRESS_URL, 'https://substrate.example.com');
  assert.equal(plan.services.orchestrator.env.SUBSTRATE_WORKER_POOL, 'pool-acme');
  assert.equal(plan.services.orchestrator.env.SUBSTRATE_PLANNER_IMAGE, 'ghcr.io/acme/planner@sha256:aaaa');
  assert.equal(plan.services.orchestrator.env.SUBSTRATE_ACTOR_MODE, undefined);
});

test('plan: passes customDomain as FIREBASE_CUSTOM_DOMAIN to tenant gateway', () => {
  const plan = buildPlan(SLUG, { ...CFG, customDomain: 'platform.archagentix.com' });
  assert.equal(plan.services.gateway.env.FIREBASE_CUSTOM_DOMAIN, 'platform.archagentix.com');
});

test('plan: only gateway is unauthenticated; agents are network-reachable but IAM-gated', () => {
  const plan = buildPlan(SLUG, CFG);
  const u = urls(SLUG, CFG);
  assert.equal(plan.services.gateway.ingress, 'INGRESS_TRAFFIC_ALL');
  assert.equal(plan.services.gateway.allowUnauthenticated, true);
  for (const svc of [plan.services.orchestrator]) {
    assert.equal(svc.ingress, 'INGRESS_TRAFFIC_ALL');
    assert.equal(svc.allowUnauthenticated, false);
    assert.deepEqual(svc.invokers, ['gw@sa', 'push@sa']);
  }
  assert.equal(plan.services.orchestrator.env.PUBSUB_PUSH_AUDIENCE, u.orchestrator);
  // The legacy planner queue now lands on the tenant orchestrator surface.
  const plannerSub = plan.subscriptions.find((s) => s.topic === 'planner-' + SLUG);
  assert.equal(plannerSub.pushEndpoint, u.orchestrator + '/pubsub/planner');
  assert.equal(plannerSub.audience, u.orchestrator);
  assert.equal(plannerSub.oidcServiceAccount, 'push@sa');
});

test('plan labels every resource with tenant + organization for attribution', () => {
  const plan = buildPlan(SLUG, CFG);
  const expectBase = { 'managed-by': 'ai-fleet-provisioner', tenancy: 'dedicated', tenant: SLUG, organization: ORG_ID };

  assert.deepEqual(plan.services.gateway.labels, { ...expectBase, component: 'gateway' });
  assert.deepEqual(plan.services.orchestrator.labels, { ...expectBase, component: 'pipeline-orchestrator' });
  assert.equal(plan.topics[0].name, 'planner-' + SLUG);
  assert.deepEqual(plan.topics[0].labels, { ...expectBase, component: 'planner' });
  assert.deepEqual(plan.subscriptions[0].labels, { ...expectBase, component: 'planner' });
});

test('durable pipeline plan uses dedicated tenant topics and brokered agent services', () => {
  const cfg = {
    ...CFG,
    pipelineOrchestratorEnabled: true,
  };
  const plan = buildPlan(SLUG, cfg);
  const n = names(SLUG);
  const u = urls(SLUG, cfg);

  assert.deepEqual(
    plan.topics.slice(1).map((topic) => topic.name),
    [
      n.pipelinePlanTopic,
      n.pipelineCodeTopic,
      n.pipelineTestTopic,
      n.pipelinePlanResultsTopic,
      n.pipelineCodeResultsTopic,
      n.pipelineTestResultsTopic,
    ],
  );
  assert.equal(plan.services.deployer, undefined);
  assert.equal(plan.topics.some((topic) => /deploy/.test(topic.name)), false);
  assert.notEqual(n.pipelinePlanTopic, n.plannerTopic);
  assert.deepEqual(plan.topics.find((topic) => topic.name === n.pipelinePlanTopic).publishers, ['po@sa']);
  for (const [topic, publisher] of [
    [n.pipelinePlanResultsTopic, 'po@sa'],
    [n.pipelineCodeResultsTopic, 'po@sa'],
    [n.pipelineTestResultsTopic, 'po@sa'],
  ]) {
    assert.deepEqual(plan.topics.find((entry) => entry.name === topic).publishers, [publisher]);
  }
  assert.equal(plan.services.gateway.env.ORCHESTRATOR_URL, u.orchestrator);
  assert.equal(plan.services.orchestrator.env.PIPELINE_STORE_BACKEND, 'firestore');
  assert.equal(plan.services.orchestrator.env.SETTINGS_URL, CFG.sharedSettingsUrl);
  assert.equal(plan.services.orchestrator.env.PIPELINE_STAGE_STORE_BACKEND, 'firestore');
  assert.equal(plan.services.orchestrator.env.PUBSUB_PIPELINE_PLAN_RESULTS_TOPIC, n.pipelinePlanResultsTopic);
  assert.equal(plan.services.orchestrator.env.PUBSUB_PIPELINE_CODE_RESULTS_TOPIC, n.pipelineCodeResultsTopic);
  assert.equal(plan.services.orchestrator.env.PUBSUB_PIPELINE_TEST_RESULTS_TOPIC, n.pipelineTestResultsTopic);
  for (const service of [plan.services.orchestrator]) {
    assert.equal(service.maxInstanceCount, 1);
    assert.equal(service.requestTimeoutSeconds, 3600);
  }
  for (const service of [plan.services.orchestrator]) {
    assert.equal(service.requireSecretFreePrimary, true);
    assert.equal(service.requireEgressProxy, true);
    assert.equal(service.env.EGRESS_PROXY_URL, 'http://127.0.0.1:4030');
    assert.equal(service.sidecarEnv.PROXY_ORG_ID, ORG_ID);
    assert.match(service.sidecarEnv.ORG_INTERNAL_API_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  }
  for (const [stage, topic] of [
    ['plan', n.pipelinePlanResultsTopic],
    ['code', n.pipelineCodeResultsTopic],
    ['test', n.pipelineTestResultsTopic],
  ]) {
    assert.equal(
      plan.subscriptions.find((subscription) => subscription.topic === topic).pushEndpoint,
      `${u.orchestrator}/pubsub/pipeline-stage-results/${stage}`,
    );
  }
  // Stage commands: plan/code/test land on the orchestrator's stage-bound path
  // segments. The deploy stage was retired with the Cloud Run deployer (2026-11)
  // — a tenant plan carries no deploy command or results channel at all.
  for (const stage of ['plan', 'code', 'test']) {
    const topic = n[`pipeline${stage[0].toUpperCase()}${stage.slice(1)}Topic`];
    const sub = plan.subscriptions.find((subscription) => subscription.topic === topic);
    assert.equal(sub.pushEndpoint, `${u.orchestrator}/pubsub/pipeline-stage/${stage}`);
    assert.equal(sub.audience, u.orchestrator);
    assert.equal(sub.ackDeadlineSeconds, 600);
  }
});

test('mandatory per-tenant egress proxy fails closed without an organization signing key', () => {
  assert.throws(
    () => buildPlan(SLUG, {
      ...CFG,
      orgS2sSigningKey: '',
    }),
    /org S2S signing key/,
  );
});

test('per-tenant gateway fails closed without the shared stream-token broker URL', () => {
  assert.throws(
    () => buildPlan(SLUG, {
      ...CFG,
      streamTokenServiceUrl: '',
    }),
    /shared stream-token service URL/,
  );
  assert.throws(
    () => buildPlan(SLUG, {
      ...CFG,
      streamTokenServiceUrl: 'http://stream-token-broker.internal',
    }),
    /HTTPS shared stream-token service URL/,
  );
});

test('organization label is omitted when orgId is absent; slug still labeled', () => {
  const plan = buildPlan(SLUG, { ...CFG, orgId: undefined });
  assert.equal(plan.services.gateway.labels.organization, undefined);
  assert.equal(plan.services.gateway.labels.tenant, SLUG);
  assert.equal(plan.services.gateway.labels.tenancy, 'dedicated');
});

// --- provision ---------------------------------------------------------------

test('GCP adapter reconciles a legacy gateway sidecar down to one brokered container', async () => {
  const plan = buildPlan(SLUG, CFG);
  const parent = `projects/${CFG.projectId}/locations/${CFG.region}`;
  const sourceName = `${parent}/services/${CFG.sourceServiceNames.gateway}`;
  const tenantName = `${parent}/services/${plan.services.gateway.name}`;
  const updates = [];
  let updateCompleted = 0;

  const source = {
    template: {
      scaling: { minInstanceCount: 0, maxInstanceCount: 3 },
      executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
      maxInstanceRequestConcurrency: 80,
      containers: [
        {
          name: 'gateway',
          image: 'registry/gateway@sha256:source',
          env: [{ name: 'SOURCE_ONLY', value: 'must-not-leak' }],
          dependsOn: ['proxy'],
        },
        {
          name: 'proxy',
          image: 'registry/proxy@sha256:source',
          env: [
            { name: 'PROXY_CAPABILITIES', value: 'egress' },
            {
              name: 'STREAM_TOKEN_SECRET',
              valueSource: { secretKeyRef: { secret: 'stream-token-secret', version: 'latest' } },
            },
          ],
        },
      ],
    },
  };
  const services = {
    async getService({ name }) {
      if (name === sourceName) return [source];
      if (name === tenantName) return [{ name: tenantName, etag: 'service-etag-current' }];
      throw new Error(`unexpected service read: ${name}`);
    },
    async createService() {
      return [{ promise: async () => { throw alreadyExists(); } }];
    },
    async updateService(request) {
      updates.push(request);
      return [completedOperation(() => { updateCompleted += 1; })];
    },
    async setIamPolicy() {},
  };
  const clients = createGcpClients(
    { projectId: CFG.projectId, region: CFG.region },
    { run: { services } },
  );

  await clients.createService({
    ...plan.services.gateway,
    image: 'registry/gateway@sha256:source',
  });

  assert.equal(updates.length, 1);
  assert.equal(updateCompleted, 1);
  assert.deepEqual(updates[0].updateMask, { paths: ['ingress', 'labels', 'template'] });
  assert.equal(updates[0].service.name, tenantName);
  assert.equal(updates[0].service.etag, 'service-etag-current');

  assert.equal(updates[0].service.template.containers.length, 1);
  const [primary] = updates[0].service.template.containers;
  const primaryEnv = envEntries(primary);
  assert.equal(primaryEnv.STREAM_TOKEN_SERVICE_URL.value, CFG.streamTokenServiceUrl);
  assert.equal(primaryEnv.STREAM_TOKEN_PROXY_URL, undefined);
  assert.equal(primaryEnv.STREAM_TOKEN_SECRET, undefined);
  assert.equal(primaryEnv.EGRESS_PROXY_URL, undefined);
  assert.equal(primary.dependsOn, undefined);
});

test('provision reuses live images and creates the full stack, returning the deployments map', async () => {
  const clients = fakeClients();
  const result = await provision(SLUG, CFG, { clients });
  const u = urls(SLUG, CFG);

  // Reused the ORIGINAL images from the SHARED services (no rebuild).
  assert.deepEqual(clients.calls.imageReads.sort(), ['gateway', 'pipeline-orchestrator']);
  const byName = Object.fromEntries(clients.calls.createService.map((s) => [s.name, s]));
  assert.equal(byName['gw-' + SLUG].image, 'registry/gateway:sha256abc');
  assert.equal(byName['po-' + SLUG].image, 'registry/pipeline-orchestrator:sha256abc');
  // The executor threads labels through to the create call.
  assert.equal(byName['gw-' + SLUG].labels.organization, ORG_ID);
  assert.equal(byName['gw-' + SLUG].labels.tenant, SLUG);

  // Topics/subs/schedulers created.
  assert.equal(clients.calls.createTopic.length, 1);
  assert.equal(clients.calls.createPushSubscription.length, 1);
  assert.equal(clients.calls.createSchedulerJob.length, 1);

  // Returned deployments map (what Organization.deployments is set to).
  assert.equal(result.status, 'provisioned');
  assert.equal(result.gateway.url, u.gateway);
  assert.equal(result.orchestrator.name, 'po-' + SLUG);
  assert.equal(result.planner, undefined);
  assert.equal(result.coder, undefined);
  assert.equal(result.worker, undefined);
  assert.equal(result.error, null);
  assert.ok(result.updated_at);
});

test('provision is idempotent — already-existing resources do not fail', async () => {
  // Clients that behave as if everything already exists (create resolves cleanly).
  const clients = fakeClients();
  const first = await provision(SLUG, CFG, { clients });
  const second = await provision(SLUG, CFG, { clients });
  assert.equal(first.status, 'provisioned');
  assert.equal(second.status, 'provisioned');
});

test('pipeline provision clones the gateway + orchestrator and writes back their URLs', async () => {
  const clients = fakeClients();
  const cfg = {
    ...CFG,
    pipelineOrchestratorEnabled: true,
  };
  const result = await provision(SLUG, cfg, { clients });
  assert.deepEqual(clients.calls.imageReads.sort(), [
    'gateway', 'pipeline-orchestrator',
  ]);
  assert.equal(clients.calls.createService.length, 2);
  assert.equal(clients.calls.createTopic.length, 7);
  assert.equal(clients.calls.createPushSubscription.length, 7);
  assert.equal(result.orchestrator.url, urls(SLUG, cfg).orchestrator);
  assert.equal(result.deployer, undefined);
});

test('invalid slug is rejected before any client call', async () => {
  const clients = fakeClients();
  await assert.rejects(() => provision('BAD_SLUG', CFG, { clients }), /invalid deployment slug/);
  assert.equal(clients.calls.createService.length, 0);
  assert.equal(clients.calls.createTopic.length, 0);
});

// --- teardown ----------------------------------------------------------------

test('teardown deletes every per-tenant resource', async () => {
  const clients = fakeClients();
  const result = await teardown(SLUG, { clients });
  const kinds = clients.calls.deletes.map((d) => d[0]);
  assert.equal(kinds.filter((k) => k === 'service').length, 2);
  assert.equal(kinds.filter((k) => k === 'sub').length, 7);
  assert.equal(kinds.filter((k) => k === 'topic').length, 7);
  assert.equal(kinds.filter((k) => k === 'sched').length, 1);
  assert.equal(kinds.filter((k) => k === 'job').length, 0);
  assert.equal(result.status, 'torn_down');
});
