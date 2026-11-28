'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('@software-factory/shared/store');
const wfStore = require('@software-factory/shared-core/workflow/store');
const substrateAccess = require('./substrate-access');

const FLEET_PATH = require.resolve('./fleet');

function routeHandler(router, path) {
  const layer = router.stack.find((c) => c.route && c.route.path === path);
  assert.ok(layer, `${path} route must exist`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// Invoke a handler capturing status + body; supports async rejects via the
// asyncHandler → next(err) seam (surfaced here as a rejection).
function call(handler, req = {}) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200 };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { resolve({ status: res.statusCode, body }); return res; };
    Promise.resolve().then(() => handler(req, res, reject)).catch(reject);
  });
}

function loadFleet(stubs) {
  Object.assign(store, stubs.store || {});
  Object.assign(substrateAccess, stubs.substrateAccess || {});
  delete require.cache[FLEET_PATH];
  return require(FLEET_PATH);
}

const ACTOR_SESSIONS = [
  { id: 'as1', orgId: 'orgA', projectId: 'p1', status: 'RUNNING', durationSeconds: 30 },
  { id: 'as2', orgId: 'orgA', projectId: 'p2', status: 'CLOSED', durationSeconds: 60 },
  { id: 'as3', orgId: 'orgB', projectId: 'p1', status: 'CLOSED', durationSeconds: 120 },
];

const USAGE_RECORDS = [
  { id: 'u1', orgId: 'orgA', projectId: 'p1', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, costTokenCredits: 3, notionalCostTokenCredits: 0 },
  { id: 'u2', orgId: 'orgA', projectId: 'p2', usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 }, costTokenCredits: 5, notionalCostTokenCredits: 0 },
  { id: 'u3', orgId: 'orgB', projectId: 'p1', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }, costTokenCredits: 7, notionalCostTokenCredits: 0 },
  // org-attributed but not project-attributed: an org-wide listing must keep it.
  { id: 'u4', orgId: 'orgA', projectId: null, usage: { inputTokens: 40, outputTokens: 0, totalTokens: 40 }, costTokenCredits: 1, notionalCostTokenCredits: 0 },
];

test('fleet agents lists the tenant profiles from the workflow store', async (t) => {
  const originals = { listAgentProfiles: wfStore.listAgentProfiles };
  t.after(() => { Object.assign(wfStore, originals); delete require.cache[FLEET_PATH]; });
  wfStore.listAgentProfiles = () => [{ id: 'planner' }, { id: 'coder' }];
  const router = loadFleet({});

  const res = await call(routeHandler(router, '/agents'), { fleetContext: { organizationId: 'orgA', projectId: 'p1' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 2);
  assert.deepEqual(res.body.agents.map((a) => a.id), ['planner', 'coder']);
});

test('fleet actors delegates to the shared substrate accessor', async (t) => {
  const originals = { listRunningActors: substrateAccess.listRunningActors };
  t.after(() => { Object.assign(substrateAccess, originals); delete require.cache[FLEET_PATH]; });
  let seenReq;
  substrateAccess.listRunningActors = async (req) => { seenReq = req; return { configured: true, actors: [{ name: 'plan-p1-1', state: 'RUNNING' }] }; };
  const router = loadFleet({});

  const req = { fleetContext: { organizationId: 'orgA', projectId: 'p1' }, query: { projectId: 'p1' } };
  const res = await call(routeHandler(router, '/actors'), req);
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, true);
  assert.equal(res.body.actors.length, 1);
  assert.equal(seenReq, req, 'actors route must forward the request untouched');
});

test('fleet actors passes a substrate context-mismatch 404 through the error seam', async (t) => {
  const originals = { listRunningActors: substrateAccess.listRunningActors };
  t.after(() => { Object.assign(substrateAccess, originals); delete require.cache[FLEET_PATH]; });
  substrateAccess.listRunningActors = async () => { const err = new Error('context_not_found'); err.status = 404; throw err; };
  const router = loadFleet({});

  await assert.rejects(
    () => call(routeHandler(router, '/actors'), { fleetContext: { organizationId: 'orgA', projectId: 'p1' }, query: {} }),
    (err) => err.status === 404,
  );
});

test('actor usage is scoped by organization, then narrowed by project when selected', async (t) => {
  const originals = { listActorSessions: store.listActorSessions };
  t.after(() => { Object.assign(store, originals); delete require.cache[FLEET_PATH]; });
  store.listActorSessions = () => ACTOR_SESSIONS.slice();
  const router = loadFleet({});

  const orgOnly = await call(routeHandler(router, '/actors/usage'), { fleetContext: { organizationId: 'orgA', projectId: '' }, query: {} });
  assert.deepEqual(orgOnly.body.actorUsage.map((s) => s.id), ['as1', 'as2']);
  assert.deepEqual(orgOnly.body.totals, { sessions: 2, running: 1, seconds: 90 });

  const scoped = await call(routeHandler(router, '/actors/usage'), { fleetContext: { organizationId: 'orgA', projectId: 'p1' }, query: {} });
  assert.deepEqual(scoped.body.actorUsage.map((s) => s.id), ['as1']);
  assert.deepEqual(scoped.body.totals, { sessions: 1, running: 1, seconds: 30 });

  const running = await call(routeHandler(router, '/actors/usage'), { fleetContext: { organizationId: 'orgA', projectId: '' }, query: { status: 'RUNNING' } });
  assert.deepEqual(running.body.actorUsage.map((s) => s.id), ['as1']);
});

test('token usage aggregates over the scope and hides other orgs', async (t) => {
  const originals = { listUsageRecords: store.listUsageRecords };
  t.after(() => { Object.assign(store, originals); delete require.cache[FLEET_PATH]; });
  store.listUsageRecords = () => USAGE_RECORDS.slice();
  const router = loadFleet({});

  const orgOnly = await call(routeHandler(router, '/tokens/usage'), { fleetContext: { organizationId: 'orgA', projectId: '' }, query: {} });
  assert.deepEqual(orgOnly.body.tokenUsage.map((r) => r.id), ['u1', 'u2', 'u4']);
  assert.equal(orgOnly.body.totals.inputTokens, 340);
  assert.equal(orgOnly.body.totals.outputTokens, 150);
  assert.equal(orgOnly.body.totals.totalTokens, 490);
  assert.equal(orgOnly.body.totals.costTokenCredits, 9);

  const scoped = await call(routeHandler(router, '/tokens/usage'), { fleetContext: { organizationId: 'orgA', projectId: 'p1' }, query: {} });
  assert.deepEqual(scoped.body.tokenUsage.map((r) => r.id), ['u1']);
  assert.equal(scoped.body.totals.totalTokens, 150);
});

test('token usage honors since and limit', async (t) => {
  const originals = { listUsageRecords: store.listUsageRecords };
  t.after(() => { Object.assign(store, originals); delete require.cache[FLEET_PATH]; });
  const dated = [
    { id: 'u1', orgId: 'orgA', projectId: 'p1', createdAt: '2026-01-02T00:00:00Z', usage: { totalTokens: 10 }, costTokenCredits: 1 },
    { id: 'u2', orgId: 'orgA', projectId: 'p1', createdAt: '2026-01-01T00:00:00Z', usage: { totalTokens: 20 }, costTokenCredits: 2 },
  ];
  store.listUsageRecords = () => dated.slice();
  const router = loadFleet({});

  const since = await call(routeHandler(router, '/tokens/usage'), { fleetContext: { organizationId: 'orgA', projectId: 'p1' }, query: { since: '2026-01-02T00:00:00Z' } });
  assert.deepEqual(since.body.tokenUsage.map((r) => r.id), ['u1']);

  const limited = await call(routeHandler(router, '/tokens/usage'), { fleetContext: { organizationId: 'orgA', projectId: 'p1' }, query: { limit: '1' } });
  assert.equal(limited.body.tokenUsage.length, 1);
  assert.equal(limited.body.totals.records, 2, 'totals aggregate the full scope, limit windows only the returned rows');
});

test('no organization header (trusted local profile) lists every row', async (t) => {
  const originals = { listActorSessions: store.listActorSessions, listUsageRecords: store.listUsageRecords };
  t.after(() => { Object.assign(store, originals); delete require.cache[FLEET_PATH]; });
  store.listActorSessions = () => ACTOR_SESSIONS.slice();
  store.listUsageRecords = () => USAGE_RECORDS.slice();
  const router = loadFleet({});

  const actors = await call(routeHandler(router, '/actors/usage'), { fleetContext: {}, query: {} });
  assert.deepEqual(actors.body.actorUsage.map((s) => s.id), ['as1', 'as2', 'as3']);
  const tokens = await call(routeHandler(router, '/tokens/usage'), { fleetContext: {}, query: {} });
  assert.deepEqual(tokens.body.tokenUsage.map((r) => r.id), ['u1', 'u2', 'u3', 'u4']);
});
