'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('@ai-fleet/shared/store');

const SUBSTRATE_KEYS = [
  'agentPattern', 'substrateUrl', 'substrateIngressUrl', 'substrateAtespace',
  'substrateWorkerPool', 'substrateActorTemplate', 'substratePlannerImage',
  'substrateTimeoutMs', 'substrateActorTtlMs',
];

function withSettings(t, settings) {
  const originalGet = store.getSettings;
  const originalPatch = store.patchSettings;
  store.getSettings = () => settings;
  store.patchSettings = () => settings;
  const modulePath = require.resolve('./settings');
  delete require.cache[modulePath];
  const router = require('./settings');
  t.after(() => {
    store.getSettings = originalGet;
    store.patchSettings = originalPatch;
    delete require.cache[modulePath];
  });
  return router;
}

function getPublic(router) {
  const layer = router.stack.find((candidate) =>
    candidate.route && candidate.route.path === '/' && candidate.route.methods.get);
  assert.ok(layer, 'GET / route must exist');
  let payload;
  layer.route.stack[0].handle({}, { json: (body) => { payload = body; } });
  return payload;
}

test('GET / exposes the execution substrate so the Settings UI can mark it active', (t) => {
  const router = withSettings(t, {
    agentPattern: 'substrate',
    substrateUrl: 'https://ateapi.internal:8443',
    substrateIngressUrl: 'https://router.internal',
    substrateAtespace: 'tenant-a',
    substrateWorkerPool: 'substrate-worker-pool',
    substrateActorTemplate: 'planner',
    substratePlannerImage: 'ghcr.io/org/planner@sha256:aaa',
    substrateTimeoutMs: 90000,
    substrateActorTtlMs: 30000,
  });
  const body = getPublic(router);
  assert.equal(body.agentPattern, 'substrate');
  assert.equal(body.substrateUrl, 'https://ateapi.internal:8443');
  assert.equal(body.substrateIngressUrl, 'https://router.internal');
  assert.equal(body.substrateAtespace, 'tenant-a');
  assert.equal(body.substrateWorkerPool, 'substrate-worker-pool');
  assert.equal(body.substrateActorTemplate, 'planner');
  assert.equal(body.substratePlannerImage, 'ghcr.io/org/planner@sha256:aaa');
  assert.equal(body.substrateTimeoutMs, 90000);
  assert.equal(body.substrateActorTtlMs, 30000);
});

test('an unset or unknown agentPattern reports cloudrun and every substrate key is present', (t) => {
  const body = getPublic(withSettings(t, {}));
  assert.equal(body.agentPattern, 'cloudrun');
  for (const key of SUBSTRATE_KEYS) assert.ok(key in body, `${key} must be returned`);
  assert.equal(typeof body.substrateTimeoutMs, 'number');
  assert.equal(typeof body.substrateActorTtlMs, 'number');
});

test('substrate exposure carries no credential material', (t) => {
  const body = getPublic(withSettings(t, {
    agentPattern: 'substrate',
    githubToken: 'ghp_secret',
    openrouterApiKey: 'sk-or-secret',
    substrateActorTemplate: 'planner',
  }));
  const json = JSON.stringify(body);
  assert.equal(json.includes('ghp_secret'), false);
  assert.equal(json.includes('sk-or-secret'), false);
});
