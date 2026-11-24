'use strict';

// Isolate the store on a throwaway data dir BEFORE requiring it: the backend is
// bound at module load from CONFIG (file backend + SOFTWARE_FACTORY_DATA_DIR). Each test
// runs inside its own organization context so seeding has a fresh tenant to
// reason about, the way the gateway routes every request.
const os = require('node:os');
const fs = require('node:fs');

process.env.STORE_BACKEND = 'file';
process.env.SOFTWARE_FACTORY_DATA_DIR = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'wf-seed-'));

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../store.js');
const wf = require('./store.js');

const V1_GRAPH = {
  id: 'v1-legacy', name: 'Legacy flow',
  nodes: [{ id: 'a', kind: 'agent', refId: 'coding', name: 'Code', x: 0, y: 0 }],
  edges: [],
};

const inOrg = (organizationId, fn) => core.runWithWorkspaceContext({ organizationId }, fn);

function putStore(changes) {
  core.writeStore({ ...core.readStore(), ...changes });
}

test('a tenant seeds platform graphs once and stays empty after deleting them all', () => {
  inOrg('seed-once', () => {
    const first = wf.seedTenantFromDefaults();
    assert.equal(first.seeded.workflows, true);
    const ids = wf.listWorkflows().map((workflow) => workflow.id);
    assert.ok(ids.length > 1, 'the platform ships example graphs');

    for (const id of ids) wf.deleteWorkflow(id);
    assert.equal(wf.listWorkflows().length, 0, 'deleting every graph is a state the operator can reach');

    const again = wf.seedTenantFromDefaults();
    assert.equal(again.seeded.workflows, false, 'an emptied collection is a choice, not a missing seed');
    assert.equal(wf.listWorkflows().length, 0, 'the next read must not resurrect what was just deleted');
  });
});

test('a tenant that already had graphs is marked seeded on the first read', () => {
  // Pre-marker installs: the collection is non-empty but nothing records when
  // it started. Stamping on observation is what makes delete-all stick for them.
  inOrg('legacy-tenant', () => {
    putStore({ workflows: [{ id: 'old', name: 'Old', schemaVersion: 2, nodes: [], edges: [] }], workflowGraphsSeededAt: null });
    wf.seedTenantFromDefaults();
    assert.ok(core.readStore().workflowGraphsSeededAt, 'existing graphs count as an initialized collection');

    wf.deleteWorkflow('old');
    wf.seedTenantFromDefaults();
    assert.equal(wf.listWorkflows().length, 0, 'the platform examples do not move back in');
  });
});

test('a migration read leaves an unseeded tenant empty so the v1 import has somewhere to land', () => {
  inOrg('migrate-first', () => {
    const deferred = wf.seedTenantFromDefaults({ seedGraphs: false });
    assert.equal(deferred.seeded.workflows, false, 'deferring must not copy the examples');
    assert.equal(wf.listWorkflows().length, 0, 'the tenant reports its real emptiness to the migrating client');
    assert.equal(core.readStore().workflowGraphsSeededAt, null, 'a deferred read is not an initialization');
    assert.ok(core.readStore().personaGrants.length, 'grants still seed: the read merges the defaults either way');

    const imported = wf.importV1Workflows([V1_GRAPH]);
    assert.equal(imported.ok, true);
    assert.ok(core.readStore().workflowGraphsSeededAt, 'the import is the initialization it replaced');

    wf.deleteWorkflow(imported.workflows[0].id);
    wf.seedTenantFromDefaults();
    assert.equal(wf.listWorkflows().length, 0, 'after migrating, the examples never overwrite the imported graph');
  });
});

test('a seeded tenant refuses the v1 import and keeps its graphs', () => {
  inOrg('migrate-after-seed', () => {
    wf.seedTenantFromDefaults();
    const before = wf.listWorkflows().map((workflow) => workflow.id);
    const imported = wf.importV1Workflows([V1_GRAPH]);
    assert.equal(imported.ok, false);
    assert.equal(imported.skipped, true, 'a two-tab race cannot duplicate the imported graphs');
    assert.deepEqual(wf.listWorkflows().map((workflow) => workflow.id), before);
  });
});

test('a reset re-initializes the tenant and marks the collection seeded', () => {
  inOrg('reset-org', () => {
    putStore({ workflows: [], workflowGraphsSeededAt: null });
    const { workflows } = wf.resetTenantToDefaults({ actor: 'admin@t.test' });
    assert.ok(workflows.length, 'reset restores the platform graphs');
    assert.ok(core.readStore().workflowGraphsSeededAt, 'reset is the initialization this tenant asked for');

    for (const workflow of wf.listWorkflows()) wf.deleteWorkflow(workflow.id);
    wf.seedTenantFromDefaults();
    assert.equal(wf.listWorkflows().length, 0, 'deleting the restored graphs is again a deliberate empty');
  });
});
