'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { names, urls, assertSlug } = require('./naming');
const { buildPlan } = require('./plan');
const { provision, teardown } = require('./provisioner');

const SLUG = 't3f9a1b2c4d5';
const CFG = {
  projectId: 'proj',
  projectNumber: '123456',
  region: 'us-central1',
  sharedOrgUrl: 'https://org-shared.run.app',
  sharedSettingsUrl: 'https://settings-shared.run.app',
  spaOrigin: 'https://spa.web.app',
  firebaseProjectId: 'proj',
  firebaseApiKey: 'fb-key',
  deadLetterTopic: 'agent-requests-deadletter',
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
  // Per-tenant topics.
  assert.deepEqual(plan.topics, ['planner-' + SLUG, 'coder-' + SLUG]);
  // Gateway: this tenant's planner/coder, SHARED org/settings.
  assert.equal(plan.services.gateway.env.PLANNER_URL, u.planner);
  assert.equal(plan.services.gateway.env.CODER_URL, u.coder);
  assert.equal(plan.services.gateway.env.ORG_URL, CFG.sharedOrgUrl);
  assert.equal(plan.services.gateway.env.SETTINGS_URL, CFG.sharedSettingsUrl);
  assert.equal(plan.services.gateway.env.API_BASE_URL, u.gateway);
});

test('plan: only the gateway is public; planner/coder internal + IAM invokers; self-audiences', () => {
  const plan = buildPlan(SLUG, CFG);
  const u = urls(SLUG, CFG);
  assert.equal(plan.services.gateway.ingress, 'INGRESS_TRAFFIC_ALL');
  assert.equal(plan.services.gateway.allowUnauthenticated, true);
  for (const svc of [plan.services.planner, plan.services.coder]) {
    assert.equal(svc.ingress, 'INGRESS_TRAFFIC_INTERNAL_ONLY');
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

// --- provision ---------------------------------------------------------------

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
  assert.equal(kinds.filter((k) => k === 'service').length, 3);
  assert.equal(kinds.filter((k) => k === 'job').length, 1);
  assert.equal(kinds.filter((k) => k === 'sub').length, 2);
  assert.equal(kinds.filter((k) => k === 'topic').length, 2);
  assert.equal(kinds.filter((k) => k === 'sched').length, 2);
  assert.equal(result.status, 'torn_down');
});
