'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { names, urls, assertSlug } = require('./naming');
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
  spaOrigin: 'https://spa.web.app',
  firebaseProjectId: 'proj',
  firebaseApiKey: 'fb-key',
  deadLetterTopic: 'agent-requests-deadletter',
  emailTopic: 'email-delivery',
  orgS2sSigningKey: 'test-org-signing-key-0123456789abcdef',
  serviceAccounts: { gateway: 'gw@sa', planner: 'pl@sa', coder: 'cc@sa', pubsubPush: 'push@sa' },
  sourceServiceNames: { gateway: 'gateway', planner: 'planner', coder: 'coder-control', worker: 'coder-worker' },
};

function fakeClients(overrides = {}) {
  const calls = { createService: [], createJob: [], createTopic: [], createPushSubscription: [], createSchedulerJob: [], deletes: [], imageReads: [] };
  const base = {
    calls,
    getServiceImage: async (name) => { calls.imageReads.push(name); return `registry/${name}:sha256abc`; },
    getJobImage: async (name) => { calls.imageReads.push(name); return `registry/${name}:sha256abc`; },
    createService: async (spec) => { calls.createService.push(spec); },
    createJob: async (spec) => { calls.createJob.push(spec); },
    createTopic: async (name) => { calls.createTopic.push(name); },
    createPushSubscription: async (spec) => { calls.createPushSubscription.push(spec); },
    createSchedulerJob: async (spec) => { calls.createSchedulerJob.push(spec); },
    deleteService: async (n) => { calls.deletes.push(['service', n]); },
    deleteJob: async (n) => { calls.deletes.push(['job', n]); },
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
  assert.equal(n.planner, 'pl-t3f9a1b2c4d5');
  assert.equal(n.coder, 'cc-t3f9a1b2c4d5');
  assert.equal(n.worker, 'cw-t3f9a1b2c4d5');
  assert.equal(n.plannerTopic, 'planner-t3f9a1b2c4d5');
  const u = urls(SLUG, CFG);
  assert.equal(u.gateway, 'https://gw-t3f9a1b2c4d5-123456.us-central1.run.app');
  assert.equal(u.planner, 'https://pl-t3f9a1b2c4d5-123456.us-central1.run.app');
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
  for (const svc of [plan.services.gateway, plan.services.planner, plan.services.coder, plan.worker]) {
    assert.equal(svc.env.STORE_NAMESPACE, SLUG);
    assert.equal(svc.env.MESSAGING_MODE, 'pubsub');
    assert.equal(svc.env.STORE_BACKEND, 'firestore');
    assert.equal(svc.env.PUBSUB_PLANNER_TOPIC, 'planner-' + SLUG);
  }
  assert.equal(plan.services.planner.env.EMAIL_TOPIC, 'email-delivery');
  // Per-tenant topics.
  assert.deepEqual(plan.topics.map((t) => t.name), ['planner-' + SLUG, 'coder-' + SLUG]);
  // Gateway: this tenant's planner/coder, SHARED org/settings.
  assert.equal(plan.services.gateway.env.PLANNER_URL, u.planner);
  assert.equal(plan.services.gateway.env.CODER_URL, u.coder);
  assert.equal(plan.services.gateway.env.ORG_URL, CFG.sharedOrgUrl);
  assert.equal(plan.services.gateway.env.SETTINGS_URL, CFG.sharedSettingsUrl);
  assert.equal(plan.services.gateway.env.API_BASE_URL, u.gateway);
  assert.equal(plan.services.gateway.env.FLEET_ORG_ID, ORG_ID);
  assert.equal(plan.services.gateway.env.TRUST_PROXY_HOPS, '1');
  assert.equal(plan.services.gateway.env.STREAM_TOKEN_PROXY_URL, 'http://127.0.0.1:4030');
  assert.equal(plan.services.gateway.env.EGRESS_PROXY_URL, undefined);
  for (const service of [plan.services.planner, plan.services.coder, plan.worker]) {
    assert.equal(service.env.EGRESS_PROXY_URL, 'http://127.0.0.1:4030');
    assert.equal(service.requireSecretFreePrimary, true);
    assert.equal(service.requireEgressProxy, true);
    assert.equal(service.sidecarEnv.PROXY_CAPABILITIES, 'egress');
  }
});

test('plan: only gateway is unauthenticated; agents are network-reachable but IAM-gated', () => {
  const plan = buildPlan(SLUG, CFG);
  const u = urls(SLUG, CFG);
  assert.equal(plan.services.gateway.ingress, 'INGRESS_TRAFFIC_ALL');
  assert.equal(plan.services.gateway.allowUnauthenticated, true);
  for (const svc of [plan.services.planner, plan.services.coder]) {
    assert.equal(svc.ingress, 'INGRESS_TRAFFIC_ALL');
    assert.equal(svc.allowUnauthenticated, false);
    assert.deepEqual(svc.invokers, ['gw@sa', 'push@sa']);
  }
  assert.equal(plan.services.planner.env.PUBSUB_PUSH_AUDIENCE, u.planner);
  assert.equal(plan.services.coder.env.PUBSUB_PUSH_AUDIENCE, u.coder);
  assert.equal(plan.services.coder.env.CODER_JOB_NAME, 'cw-' + SLUG);
  // Subs + scheduler point at each service's own endpoint + audience.
  const plannerSub = plan.subscriptions.find((s) => s.topic === 'planner-' + SLUG);
  assert.equal(plannerSub.pushEndpoint, u.planner + '/pubsub/planner');
  assert.equal(plannerSub.audience, u.planner);
  assert.equal(plannerSub.oidcServiceAccount, 'push@sa');
});

test('plan labels every resource with tenant + organization for attribution', () => {
  const plan = buildPlan(SLUG, CFG);
  const expectBase = { 'managed-by': 'ai-fleet-provisioner', tenancy: 'dedicated', tenant: SLUG, organization: ORG_ID };

  assert.deepEqual(plan.services.gateway.labels, { ...expectBase, component: 'gateway' });
  assert.deepEqual(plan.services.planner.labels, { ...expectBase, component: 'planner' });
  assert.deepEqual(plan.services.coder.labels, { ...expectBase, component: 'coder-control' });
  assert.deepEqual(plan.worker.labels, { ...expectBase, component: 'coder-worker' });
  assert.equal(plan.topics[0].name, 'planner-' + SLUG);
  assert.deepEqual(plan.topics[0].labels, { ...expectBase, component: 'planner' });
  assert.deepEqual(plan.subscriptions[0].labels, { ...expectBase, component: 'planner' });
});

test('durable pipeline plan uses dedicated tenant topics and brokered agent services', () => {
  const cfg = {
    ...CFG,
    pipelineOrchestratorEnabled: true,
    pipelineDeploymentEnabled: false,
    serviceAccounts: {
      ...CFG.serviceAccounts,
      orchestrator: 'po@sa',
      tester: 'pt@sa',
      deployer: 'pd@sa',
    },
    sourceServiceNames: {
      ...CFG.sourceServiceNames,
      orchestrator: 'pipeline-orchestrator',
      tester: 'pipeline-tester',
      deployer: 'pipeline-deployer',
    },
  };
  const plan = buildPlan(SLUG, cfg);
  const n = names(SLUG);
  const u = urls(SLUG, cfg);

  assert.deepEqual(
    plan.topics.slice(2).map((topic) => topic.name),
    [
      n.pipelinePlanTopic,
      n.pipelineCodeTopic,
      n.pipelineTestTopic,
      n.pipelineDeployTopic,
      n.pipelinePlanResultsTopic,
      n.pipelineCodeResultsTopic,
      n.pipelineTestResultsTopic,
      n.pipelineDeployResultsTopic,
    ],
  );
  assert.notEqual(n.pipelinePlanTopic, n.plannerTopic);
  assert.notEqual(n.pipelineCodeTopic, n.coderTopic);
  assert.deepEqual(plan.topics.find((topic) => topic.name === n.pipelinePlanTopic).publishers, ['po@sa']);
  for (const [topic, publisher] of [
    [n.pipelinePlanResultsTopic, 'pl@sa'],
    [n.pipelineCodeResultsTopic, 'cc@sa'],
    [n.pipelineTestResultsTopic, 'pt@sa'],
    [n.pipelineDeployResultsTopic, 'pd@sa'],
  ]) {
    assert.deepEqual(plan.topics.find((entry) => entry.name === topic).publishers, [publisher]);
  }
  assert.equal(plan.services.gateway.env.ORCHESTRATOR_URL, u.orchestrator);
  assert.equal(plan.services.orchestrator.env.PIPELINE_STORE_BACKEND, 'firestore');
  assert.equal(plan.services.orchestrator.env.EGRESS_PROXY_URL, undefined);
  assert.equal(plan.services.orchestrator.env.SETTINGS_URL, CFG.sharedSettingsUrl);
  for (const service of [plan.services.planner, plan.services.coder, plan.services.tester, plan.services.deployer]) {
    assert.equal(service.env.PIPELINE_STAGE_STORE_BACKEND, 'firestore');
  }
  assert.equal(plan.services.planner.env.PUBSUB_PIPELINE_PLAN_RESULTS_TOPIC, n.pipelinePlanResultsTopic);
  assert.equal(plan.services.coder.env.PUBSUB_PIPELINE_CODE_RESULTS_TOPIC, n.pipelineCodeResultsTopic);
  assert.equal(plan.services.tester.env.PUBSUB_PIPELINE_TEST_RESULTS_TOPIC, n.pipelineTestResultsTopic);
  assert.equal(plan.services.deployer.env.PUBSUB_PIPELINE_DEPLOY_RESULTS_TOPIC, n.pipelineDeployResultsTopic);
  for (const service of [
    plan.services.planner,
    plan.services.coder,
    plan.services.tester,
    plan.services.deployer,
  ]) {
    assert.equal(service.maxInstanceCount, 1);
    assert.equal(service.requestTimeoutSeconds, 3600);
  }
  for (const service of [plan.services.tester, plan.services.deployer]) {
    assert.equal(service.requireSecretFreePrimary, true);
    assert.equal(service.requireEgressProxy, true);
    assert.equal(service.env.EGRESS_PROXY_URL, 'http://127.0.0.1:4030');
    assert.equal(service.sidecarEnv.PROXY_ORG_ID, ORG_ID);
    assert.match(service.sidecarEnv.ORG_INTERNAL_API_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  }
  assert.equal(
    plan.services.planner.sidecarEnv.ORG_INTERNAL_API_TOKEN,
    plan.services.tester.sidecarEnv.ORG_INTERNAL_API_TOKEN,
  );
  assert.equal(plan.services.deployer.env.PIPELINE_DEPLOYMENT_ENABLED, 'false');
  for (const [stage, topic] of [
    ['plan', n.pipelinePlanResultsTopic],
    ['code', n.pipelineCodeResultsTopic],
    ['test', n.pipelineTestResultsTopic],
    ['deploy', n.pipelineDeployResultsTopic],
  ]) {
    assert.equal(
      plan.subscriptions.find((subscription) => subscription.topic === topic).pushEndpoint,
      `${u.orchestrator}/pubsub/pipeline-stage-results/${stage}`,
    );
  }
  for (const topic of [n.pipelinePlanTopic, n.pipelineCodeTopic, n.pipelineTestTopic, n.pipelineDeployTopic]) {
    assert.equal(plan.subscriptions.find((subscription) => subscription.topic === topic).ackDeadlineSeconds, 600);
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

test('organization label is omitted when orgId is absent; slug still labeled', () => {
  const plan = buildPlan(SLUG, { ...CFG, orgId: undefined });
  assert.equal(plan.services.gateway.labels.organization, undefined);
  assert.equal(plan.services.gateway.labels.tenant, SLUG);
  assert.equal(plan.services.gateway.labels.tenancy, 'dedicated');
});

// --- provision ---------------------------------------------------------------

test('GCP adapter reconciles an existing tenant service with the gateway proxy boundary', async () => {
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
  const jobs = {};
  const clients = createGcpClients(
    { projectId: CFG.projectId, region: CFG.region },
    { run: { services, jobs } },
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

  const [primary, proxy] = updates[0].service.template.containers;
  const primaryEnv = envEntries(primary);
  const proxyEnv = envEntries(proxy);
  assert.equal(primaryEnv.STREAM_TOKEN_PROXY_URL.value, 'http://127.0.0.1:4030');
  assert.equal(primaryEnv.STREAM_TOKEN_SECRET, undefined);
  assert.equal(primaryEnv.EGRESS_PROXY_URL, undefined);
  assert.equal(proxyEnv.PROXY_CAPABILITIES.value, 'stream-token');
  assert.deepEqual(proxyEnv.STREAM_TOKEN_SECRET.valueSource, {
    secretKeyRef: { secret: 'stream-token-secret', version: 'latest' },
  });
});

test('GCP adapter reconciles an existing tenant worker job with sidecar-only egress credentials', async () => {
  const plan = buildPlan(SLUG, CFG);
  const parent = `projects/${CFG.projectId}/locations/${CFG.region}`;
  const sourceName = `${parent}/jobs/${CFG.sourceServiceNames.worker}`;
  const tenantName = `${parent}/jobs/${plan.worker.name}`;
  const updates = [];
  let updateCompleted = 0;

  const source = {
    template: {
      template: {
        executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
        containers: [
          {
            name: 'worker',
            image: 'registry/worker@sha256:source',
            env: [{ name: 'SOURCE_ONLY', value: 'must-not-leak' }],
          },
          {
            name: 'proxy',
            image: 'registry/proxy@sha256:source',
            env: [
              { name: 'PROXY_CAPABILITIES', value: 'old-value' },
              {
                name: 'PROVIDER_CREDENTIAL',
                valueSource: { secretKeyRef: { secret: 'provider-vault', version: 'latest' } },
              },
            ],
          },
        ],
      },
    },
  };
  const services = {};
  const jobs = {
    async getJob({ name }) {
      if (name === sourceName) return [source];
      if (name === tenantName) return [{ name: tenantName, etag: 'job-etag-current' }];
      throw new Error(`unexpected job read: ${name}`);
    },
    async createJob() {
      throw alreadyExists();
    },
    async updateJob(request) {
      updates.push(request);
      return [completedOperation(() => { updateCompleted += 1; })];
    },
  };
  const clients = createGcpClients(
    { projectId: CFG.projectId, region: CFG.region },
    { run: { services, jobs } },
  );

  await clients.createJob({
    ...plan.worker,
    image: 'registry/worker@sha256:source',
  });

  assert.equal(updates.length, 1);
  assert.equal(updateCompleted, 1);
  assert.equal(updates[0].job.name, tenantName);
  assert.equal(updates[0].job.etag, 'job-etag-current');

  const [primary, proxy] = updates[0].job.template.template.containers;
  const primaryEnv = envEntries(primary);
  const proxyEnv = envEntries(proxy);
  assert.equal(primaryEnv.EGRESS_PROXY_URL.value, 'http://127.0.0.1:4030');
  assert.equal(primaryEnv.PROVIDER_CREDENTIAL, undefined);
  assert.equal(primaryEnv.ORG_INTERNAL_API_TOKEN, undefined);
  assert.equal(proxyEnv.PROXY_CAPABILITIES.value, 'egress');
  assert.equal(proxyEnv.PROXY_ORG_ID.value, ORG_ID);
  assert.match(proxyEnv.ORG_INTERNAL_API_TOKEN.value, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(proxyEnv.PROVIDER_CREDENTIAL.valueSource, {
    secretKeyRef: { secret: 'provider-vault', version: 'latest' },
  });
});

test('provision reuses live images and creates the full stack, returning the deployments map', async () => {
  const clients = fakeClients();
  const result = await provision(SLUG, CFG, { clients });
  const u = urls(SLUG, CFG);

  // Reused the ORIGINAL images from the SHARED services (no rebuild).
  assert.deepEqual(clients.calls.imageReads.sort(), ['coder-control', 'coder-worker', 'gateway', 'planner']);
  const byName = Object.fromEntries(clients.calls.createService.map((s) => [s.name, s]));
  assert.equal(byName['gw-' + SLUG].image, 'registry/gateway:sha256abc');
  assert.equal(byName['pl-' + SLUG].image, 'registry/planner:sha256abc');
  assert.equal(byName['cc-' + SLUG].image, 'registry/coder-control:sha256abc');
  // The executor threads labels through to the create call.
  assert.equal(byName['gw-' + SLUG].labels.organization, ORG_ID);
  assert.equal(byName['gw-' + SLUG].labels.tenant, SLUG);
  assert.equal(clients.calls.createJob[0].image, 'registry/coder-worker:sha256abc');
  assert.equal(clients.calls.createJob[0].env.STORE_NAMESPACE, SLUG);

  // Topics/subs/schedulers created.
  assert.equal(clients.calls.createTopic.length, 2);
  assert.equal(clients.calls.createPushSubscription.length, 2);
  assert.equal(clients.calls.createSchedulerJob.length, 2);

  // Returned deployments map (what Organization.deployments is set to).
  assert.equal(result.status, 'provisioned');
  assert.equal(result.gateway.url, u.gateway);
  assert.equal(result.worker.name, 'cw-' + SLUG);
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

test('pipeline provision clones all three shared pipeline services and writes back their URLs', async () => {
  const clients = fakeClients();
  const cfg = {
    ...CFG,
    pipelineOrchestratorEnabled: true,
    serviceAccounts: {
      ...CFG.serviceAccounts,
      orchestrator: 'po@sa', tester: 'pt@sa', deployer: 'pd@sa',
    },
    sourceServiceNames: {
      ...CFG.sourceServiceNames,
      orchestrator: 'pipeline-orchestrator', tester: 'pipeline-tester', deployer: 'pipeline-deployer',
    },
  };
  const result = await provision(SLUG, cfg, { clients });
  assert.deepEqual(clients.calls.imageReads.sort(), [
    'coder-control', 'coder-worker', 'gateway', 'pipeline-deployer',
    'pipeline-orchestrator', 'pipeline-tester', 'planner',
  ]);
  assert.equal(clients.calls.createService.length, 6);
  assert.equal(clients.calls.createTopic.length, 10);
  assert.equal(clients.calls.createPushSubscription.length, 10);
  assert.equal(result.orchestrator.url, urls(SLUG, cfg).orchestrator);
  assert.equal(result.tester.status, 'provisioned');
  assert.equal(result.deployer.status, 'provisioned');
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
  assert.equal(kinds.filter((k) => k === 'service').length, 6);
  assert.equal(kinds.filter((k) => k === 'job').length, 1);
  assert.equal(kinds.filter((k) => k === 'sub').length, 10);
  assert.equal(kinds.filter((k) => k === 'topic').length, 10);
  assert.equal(kinds.filter((k) => k === 'sched').length, 2);
  assert.equal(result.status, 'torn_down');
});
