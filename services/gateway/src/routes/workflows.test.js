'use strict';

// Isolate the durable store on a throwaway dir BEFORE requiring anything that
// binds CONFIG: the file backend and the legacy root both live under
// AI_FLEET_DATA_DIR, and every test here asserts through them.
const os = require('node:os');
const fs = require('node:fs');

process.env.STORE_BACKEND = 'file';
process.env.AI_FLEET_DATA_DIR = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'gw-workflows-'));

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const { createWorkflowsRouter } = require('./workflows');
const wfStore = require('@ai-fleet/shared-core/workflow/store');

const IDENTITIES = {
  builder: { authenticated: true, mode: 'firebase', role: 'operator', user: { sub: 'uid-builder', email: 'build@t.test' } },
  designer: { authenticated: true, mode: 'firebase', role: 'viewer', user: { sub: 'uid-designer', email: 'pd@t.test' } },
  admin: { authenticated: true, mode: 'firebase', role: 'admin', user: { sub: 'uid-admin', email: 'admin@t.test' } },
};

function buildApp({ identity = IDENTITIES.builder, kagentAdapter = null, substrateAdapter = null } = {}) {
  const app = express();
  app.use(express.json());
  const state = { identity };
  app.use((req, _res, next) => { req.auth = state.identity; next(); });
  app.use('/api/workflows', createWorkflowsRouter({ kagentAdapter, substrateAdapter }));
  return { app, state };
}

async function start(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function call(base, method, path, { body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function graph(overrides = {}) {
  return {
    id: 'gw-flow', name: 'Gateway flow',
    nodes: [{ id: 'n1', kind: 'agent', refId: 'coding', name: 'Coding', x: 0, y: 0 }],
    edges: [],
    ...overrides,
  };
}

test('GET / lazily seeds the tenant from platform defaults', async () => {
  const { app } = buildApp();
  const { server, url } = await start(app);
  try {
    const first = await call(url, 'GET', '/api/workflows');
    assert.equal(first.status, 200);
    assert.ok(first.body.workflows.some((w) => w.id === 'default-adlc'));
    assert.ok(first.body.agents.some((a) => a.id === 'ideation'));
    assert.equal(first.body.persona, 'builder');
    assert.equal(first.body.gateTemplate.cards.length, 6);
    assert.equal(first.body.canAdminDefaults, false);
    const second = await call(url, 'GET', '/api/workflows');
    assert.deepEqual(second.body.workflows.map((w) => w.id), first.body.workflows.map((w) => w.id), 'seeding is idempotent');
  } finally { server.close(); }
});

test('POST + PUT enforce the optimistic revision with a 409 carrying the server copy', async () => {
  const { app } = buildApp();
  const { server, url } = await start(app);
  try {
    const created = await call(url, 'POST', '/api/workflows', { body: graph() });
    assert.equal(created.status, 201);
    assert.equal(created.body.revision, 1);

    const stale = await call(url, 'PUT', '/api/workflows/gw-flow', {
      body: graph({ name: 'Renamed' }), headers: { 'if-match': '0' },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'revision_conflict');
    assert.equal(stale.body.workflow.name, 'Gateway flow');

    const fresh = await call(url, 'PUT', '/api/workflows/gw-flow', {
      body: graph({ name: 'Renamed' }), headers: { 'if-match': '1' },
    });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.revision, 2);
    assert.equal(fresh.body.name, 'Renamed');
    assert.equal(fresh.body.updatedBy, 'build@t.test');

    const dup = await call(url, 'POST', '/api/workflows', { body: graph() });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'already_exists');
  } finally { server.close(); }
});

test('persona gating is enforced server-side, not just in the palette', async () => {
  const { app, state } = buildApp();
  const { server, url } = await start(app);
  try {
    await call(url, 'GET', '/api/workflows');
    assert.equal((await call(url, 'PUT', '/api/workflows/me/persona', { body: { persona: 'product-designer' } })).status, 200);
    const denied = await call(url, 'POST', '/api/workflows', {
      body: graph({ id: 'pd-denied-flow' }),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'persona_denied');
    assert.match(denied.body.violations[0], /Coding/);

    const me = await call(url, 'GET', '/api/workflows/me');
    assert.equal(me.body.persona, 'product-designer');
    const pdFlow = await call(url, 'POST', '/api/workflows', {
      body: graph({ id: 'pd-flow', nodes: [{ id: 'n1', kind: 'agent', refId: 'requirements', name: 'Reqs', x: 0, y: 0 }] }),
    });
    assert.equal(pdFlow.status, 201);

    await call(url, 'PUT', '/api/workflows/me/persona', { body: { persona: 'org-admin' } });
    assert.equal((await call(url, 'POST', '/api/workflows', { body: graph({ id: 'admin-flow' }) })).status, 201);
    const restored = await call(url, 'PUT', '/api/workflows/me/persona', { body: { persona: 'builder' } });
    assert.equal(restored.body.persona.persona, 'builder');
    state.identity = IDENTITIES.admin;
    assert.equal((await call(url, 'GET', '/api/workflows')).body.canAdminDefaults, true);
  } finally { server.close(); }
});

test('unknown ids 404 and v1 import refuses to clobber existing graphs', async () => {
  const { app } = buildApp();
  const { server, url } = await start(app);
  try {
    assert.equal((await call(url, 'DELETE', '/api/workflows/nope')).status, 404);
    await call(url, 'GET', '/api/workflows');
    const imported = await call(url, 'POST', '/api/workflows/import', {
      body: { workflows: [{ id: 'v1-legacy', name: 'Old', nodes: [{ id: 'a', kind: 'agent', refId: 'coding', name: 'A', x: 0, y: 0 }], edges: [] }] },
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.skipped, true);
    assert.ok(imported.body.workflows.every((w) => w.id !== 'v1-legacy'));
  } finally { server.close(); }
});

test('agent profile CRUD validates kagent specs and guards referenced deletes', async () => {
  const { app } = buildApp();
  const { server, url } = await start(app);
  try {
    const bad = await call(url, 'PUT', '/api/workflows/agents/k-coding', {
      body: { name: 'K Coding', backend: 'kagent', kagent: { skills: [{ name: 's', source: { oci: 'no-pin' } }] } },
    });
    assert.equal(bad.status, 400);

    const ok = await call(url, 'PUT', '/api/workflows/agents/k-coding', {
      body: {
        name: 'K Coding', category: 'Coding', backend: 'kagent', harness: 'claude-code',
        kagent: { modelConfig: { name: 'default-model-config' }, env: [{ name: 'LOG_LEVEL', value: 'info' }] },
      },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.backend, 'kagent');

    await call(url, 'POST', '/api/workflows', { body: graph({ id: 'ref-flow', nodes: [{ id: 'n1', kind: 'agent', refId: 'k-coding', name: 'K', x: 0, y: 0 }] }) });
    const blocked = await call(url, 'DELETE', '/api/workflows/agents/k-coding');
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /ref-flow/);

    const deleteDefault = await call(url, 'DELETE', '/api/workflows/agents/coding');
    assert.equal(deleteDefault.status, 400);
    assert.match(deleteDefault.body.error, /Platform default/);
  } finally { server.close(); }
});

test('kagent capabilities report disabled and publish refuses with 503 until configured', async () => {
  const { app } = buildApp();
  const { server, url } = await start(app);
  try {
    const caps = await call(url, 'GET', '/api/workflows/kagent/capabilities');
    assert.equal(caps.status, 200);
    assert.equal(caps.body.enabled, false);
    assert.equal(caps.body.reason, 'kagent_not_configured');

    await call(url, 'PUT', '/api/workflows/agents/k-coding', {
      body: { name: 'K Coding', category: 'Coding', backend: 'kagent', kagent: { modelConfig: { name: 'default-model-config' } } },
    });
    const publish = await call(url, 'POST', '/api/workflows/agents/k-coding/publish');
    assert.equal(publish.status, 503);
    assert.equal(publish.body.error, 'kagent_not_configured');

    // An unconfigured cluster refuses the node route the same way: the designer
    // can save a kagent binding, but nothing renders until the switch is on.
    await call(url, 'POST', '/api/workflows', {
      body: graph({ id: 'unconfigured-node-flow', nodes: [{ id: 'n1', kind: 'agent', refId: 'coding', name: 'Coding', x: 0, y: 0, backend: 'kagent' }] }),
    });
    const nodePublish = await call(url, 'POST', '/api/workflows/unconfigured-node-flow/nodes/n1/publish');
    assert.equal(nodePublish.status, 503);
    assert.equal(nodePublish.body.error, 'kagent_not_configured');
  } finally { server.close(); }
});

test('publishing a node renders the node binding rather than a copy of the profile', async () => {
  const published = [];
  const kagentAdapter = {
    enabled: () => true,
    capabilities: async () => ({ namespace: 'kagent', harnesses: [], modelConfigs: [], remoteMcpServers: [], agentTemplates: [] }),
    publishProfile: async (node) => {
      published.push(node);
      return { ok: true, name: node.refId, namespace: 'kagent', created: true };
    },
  };
  const { app } = buildApp({ kagentAdapter });
  const { server, url } = await start(app);
  try {
    await call(url, 'POST', '/api/workflows', {
      body: graph({
        id: 'node-binding-flow',
        nodes: [
          {
            id: 'n1', kind: 'agent', refId: 'coding', name: 'Coding', x: 0, y: 0,
            backend: 'kagent', harness: 'claude-code', taskTier: 'complex', systemPrompt: 'Base prompt.',
            kagentSpec: {
              modelConfig: { name: 'default-model-config' },
              env: [{ name: 'LOG_LEVEL', value: 'debug' }],
              tools: [{ kind: 'mcp', server: 'kagent-tool-server', tools: [] }],
            },
          },
          { id: 'n2', kind: 'approval', refId: '', name: 'Sign off', x: 300, y: 0 },
        ],
      }),
    });

    const outcome = await call(url, 'POST', '/api/workflows/node-binding-flow/nodes/n1/publish');
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.backend, 'kagent');
    assert.equal(outcome.body.nodeId, 'n1');
    assert.equal(published.length, 1);
    assert.equal(published[0].id, 'n1', 'the renderer receives the node the canvas saved');
    assert.equal(published[0].refId, 'coding');
    assert.equal(published[0].crdName, 'node-binding-flow-n1', 'the CR is named by where the binding lives, so two graphs with a node called n1 do not overwrite each other');
    assert.equal(published[0].kagentSpec.env[0].name, 'LOG_LEVEL', 'the harness environment the canvas saved reaches the renderer');

    const notAnAgent = await call(url, 'POST', '/api/workflows/node-binding-flow/nodes/n2/publish');
    assert.equal(notAnAgent.status, 400);

    const missingNode = await call(url, 'POST', '/api/workflows/node-binding-flow/nodes/nope/publish');
    assert.equal(missingNode.status, 404);
    const missingGraph = await call(url, 'POST', '/api/workflows/nope-flow/nodes/n1/publish');
    assert.equal(missingGraph.status, 404);
  } finally { server.close(); }
});

test('a substrate node publishes the profile behind it, and the persona gate still applies', async () => {
  const published = [];
  const { app, state } = buildApp({
    substrateAdapter: { publishProfile: async (profile) => { published.push(profile.id); return { ok: true, name: profile.id }; } },
  });
  const { server, url } = await start(app);
  try {
    await call(url, 'POST', '/api/workflows', {
      body: graph({ id: 'node-actor-flow', nodes: [{ id: 'n1', kind: 'agent', refId: 'coding', name: 'Coding', x: 0, y: 0, backend: 'substrate' }] }),
    });

    const allowed = await call(url, 'POST', '/api/workflows/node-actor-flow/nodes/n1/publish');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.backend, 'substrate');
    assert.deepEqual(published, ['coding'], 'an actor runs the curated profile, not the node drawing of it');

    // The persona is a stored record per uid, not the credential: swapping the
    // identity alone would keep publishing as whoever that uid was last set to.
    state.identity = IDENTITIES.designer;
    await call(url, 'GET', '/api/workflows');
    assert.equal((await call(url, 'PUT', '/api/workflows/me/persona', { body: { persona: 'product-designer' } })).status, 200);
    const denied = await call(url, 'POST', '/api/workflows/node-actor-flow/nodes/n1/publish');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'persona_denied');
    assert.match(denied.body.violations[0], /Coding/, 'the node it points at, not the graph, is what the grant is checked against');
    assert.equal(published.length, 1, 'a denied publish never reached the runtime');
  } finally { server.close(); }
});

test('a live kagent adapter receives publishes and surfaces capabilities', async () => {
  const published = [];
  const kagentAdapter = {
    enabled: () => true,
    capabilities: async () => ({ harnesses: ['my-first-harness'], modelConfigs: ['default-model-config'], remoteMcpServers: ['kagent-tool-server'], agentTemplates: [] }),
    publishProfile: async (profile) => { published.push(profile.id); return { ok: true, name: profile.id }; },
  };
  const { app } = buildApp({ kagentAdapter });
  const { server, url } = await start(app);
  try {
    const caps = await call(url, 'GET', '/api/workflows/kagent/capabilities');
    assert.deepEqual(caps.body.harnesses, ['my-first-harness']);
    await call(url, 'PUT', '/api/workflows/agents/k-coding', {
      body: { name: 'K Coding', category: 'Coding', backend: 'kagent', kagent: { modelConfig: { name: 'default-model-config' } } },
    });
    const publish = await call(url, 'POST', '/api/workflows/agents/k-coding/publish');
    assert.equal(publish.status, 200);
    assert.deepEqual(published, ['k-coding']);
  } finally { server.close(); }
});

test('platform defaults are readable by members but only writable by global admins', async () => {
  const { app, state } = buildApp();
  const { server, url } = await start(app);
  try {
    const read = await call(url, 'GET', '/api/workflows/defaults');
    assert.equal(read.status, 200);
    assert.equal(read.body.tenant.defaultPersona, 'builder');

    const denied = await call(url, 'PUT', '/api/workflows/defaults/gate', { body: { value: wfStore.effectiveWorkflowDefaults().gateTemplate } });
    assert.equal(denied.status, 403);

    state.identity = IDENTITIES.admin;
    const gate = wfStore.effectiveWorkflowDefaults().gateTemplate;
    const written = await call(url, 'PUT', '/api/workflows/defaults/gate', { body: { value: { ...gate, cards: gate.cards.map((c) => ({ ...c, threshold: 70 })) } } });
    assert.equal(written.status, 200);
    assert.equal(written.body.defaults.gateTemplate.cards[0].threshold, 70);
    const bad = await call(url, 'PUT', '/api/workflows/defaults/nonsense', { body: { value: {} } });
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});

test('reset re-copies the platform defaults over tenant edits', async () => {
  const { app } = buildApp();
  const { server, url } = await start(app);
  try {
    await call(url, 'GET', '/api/workflows');
    await call(url, 'POST', '/api/workflows', { body: graph() });
    const reset = await call(url, 'POST', '/api/workflows/reset');
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.body.workflows.map((w) => w.id).sort(), ['default-adlc', 'default-quickstart']);
    assert.equal(wfStore.getWorkflow('gw-flow'), null);
  } finally { server.close(); }
});
