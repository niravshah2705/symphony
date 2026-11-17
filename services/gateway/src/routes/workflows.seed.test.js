'use strict';

// Tenant-seeding behaviour over HTTP, on its own throwaway store dir: these
// tests rewrite the seeded/marker state between requests, so they must not
// share a data dir with the rest of the workflow route suite.
const os = require('node:os');
const fs = require('node:fs');

process.env.STORE_BACKEND = 'file';
process.env.AI_FLEET_DATA_DIR = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'gw-workflows-seed-'));

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const core = require('@ai-fleet/shared-core/store');
const { createWorkflowsRouter } = require('./workflows');

const IDENTITY = {
  authenticated: true, mode: 'firebase', role: 'operator',
  user: { sub: 'uid-seed', email: 'seed@t.test' },
};

function putStore(changes) {
  core.writeStore({ ...core.readStore(), ...changes });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = IDENTITY; next(); });
  app.use('/api/workflows', createWorkflowsRouter());
  return app;
}

async function start(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function call(base, method, path, { body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('GET / seeds once: graphs the operator deleted are not restored by the next read', async () => {
  const app = buildApp();
  const { server, url } = await start(app);
  try {
    putStore({ workflows: [], workflowGraphsSeededAt: null });
    const seeded = await call(url, 'GET', '/api/workflows');
    assert.equal(seeded.status, 200);
    assert.ok(seeded.body.workflows.some((workflow) => workflow.id === 'default-adlc'), 'a new tenant gets the platform examples');

    for (const workflow of seeded.body.workflows) {
      assert.equal((await call(url, 'DELETE', `/api/workflows/${workflow.id}`)).status, 200);
    }
    const after = await call(url, 'GET', '/api/workflows');
    assert.deepEqual(after.body.workflows, [], 'emptiness is now the tenant state, not a missing seed');
  } finally { server.close(); }
});

test('GET /?migrate=1 leaves an unseeded tenant empty so localStorage graphs can be imported', async () => {
  const app = buildApp();
  const { server, url } = await start(app);
  try {
    putStore({ workflows: [], workflowGraphsSeededAt: null });
    const deferred = await call(url, 'GET', '/api/workflows?migrate=1');
    assert.equal(deferred.status, 200);
    assert.deepEqual(deferred.body.workflows, [], 'lazy seeding would fill the collection the import refuses to write into');
    assert.equal(deferred.body.persona, 'builder', 'deferring graphs must not defer the rest of the context');
    assert.equal(deferred.body.gateTemplate.cards.length, 6);

    const imported = await call(url, 'POST', '/api/workflows/import', {
      body: { workflows: [{ id: 'v1-mine', name: 'My old flow', nodes: [{ id: 'a', kind: 'agent', refId: 'coding', name: 'Code', x: 0, y: 0 }], edges: [] }] },
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.imported, 1);

    const after = await call(url, 'GET', '/api/workflows');
    assert.deepEqual(after.body.workflows.map((workflow) => workflow.id), ['v1-mine'], 'the migrated graph is the tenant, not one more example');
  } finally { server.close(); }
});

test('GET /?migrate=1 on a seeded tenant answers normally, marker or no marker', async () => {
  const app = buildApp();
  const { server, url } = await start(app);
  try {
    putStore({ workflows: [], workflowGraphsSeededAt: null });
    await call(url, 'GET', '/api/workflows');
    const marked = core.readStore().workflowGraphsSeededAt;
    assert.ok(marked, 'seeding records the initialization');
    const again = await call(url, 'GET', '/api/workflows?migrate=1');
    assert.ok(again.body.workflows.length, 'a tenant that already has graphs keeps them across a migration read');

    putStore({ workflowGraphsSeededAt: null });
    const unmarked = await call(url, 'GET', '/api/workflows?migrate=1');
    assert.ok(unmarked.body.workflows.length, 'deferring only ever applies to an empty collection');
    assert.ok(core.readStore().workflowGraphsSeededAt, 'reading graphs that exist marks the collection initialized');
  } finally { server.close(); }
});
