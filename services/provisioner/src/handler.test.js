'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleMessage } = require('./handler');

function deps(overrides = {}) {
  const calls = { provision: [], teardown: [], writeBack: [] };
  return {
    calls,
    cfg: { projectId: 'p' },
    log: { error() {} },
    provisionTenant: async (slug, cfg) => { calls.provision.push({ slug, cfg }); return { status: 'provisioned', slug, gateway: { url: 'https://gw' } }; },
    teardownTenant: async (slug, cfg) => { calls.teardown.push({ slug, cfg }); return {}; },
    writeBack: async (orgId, deployments) => { calls.writeBack.push({ orgId, deployments }); },
    ...overrides,
  };
}

test('provision: calls provisionTenant then writes back the deployments map', async () => {
  const d = deps();
  const r = await handleMessage({ org_id: 'org1', slug: 't3abc', action: 'provision' }, d);
  assert.deepEqual(r, { ok: true, action: 'provision' });
  assert.equal(d.calls.provision[0].slug, 't3abc');
  assert.equal(d.calls.provision[0].cfg.orgId, 'org1'); // threaded for the organization label
  assert.equal(d.calls.writeBack[0].orgId, 'org1');
  assert.equal(d.calls.writeBack[0].deployments.status, 'provisioned');
});

test('action defaults to provision when omitted', async () => {
  const d = deps();
  const r = await handleMessage({ org_id: 'org1', slug: 't3abc' }, d);
  assert.equal(r.action, 'provision');
  assert.equal(d.calls.provision.length, 1);
});

test('teardown: calls teardownTenant then writes back shared', async () => {
  const d = deps();
  const r = await handleMessage({ org_id: 'org1', slug: 't3abc', action: 'teardown' }, d);
  assert.deepEqual(r, { ok: true, action: 'teardown' });
  assert.equal(d.calls.teardown[0].slug, 't3abc');
  assert.equal(d.calls.writeBack[0].deployments.status, 'shared');
});

test('malformed message: no provision, no write-back', async () => {
  const d = deps();
  const r = await handleMessage({ action: 'provision' }, d); // missing org_id/slug
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
  assert.equal(d.calls.provision.length, 0);
  assert.equal(d.calls.writeBack.length, 0);
});

test('provision failure: records status=failed via write-back', async () => {
  const d = deps({ provisionTenant: async () => { throw new Error('quota exceeded'); } });
  const r = await handleMessage({ org_id: 'org1', slug: 't3abc', action: 'provision' }, d);
  assert.equal(r.ok, false);
  assert.match(r.reason, /quota exceeded/);
  assert.equal(d.calls.writeBack[0].deployments.status, 'failed');
  assert.match(d.calls.writeBack[0].deployments.error, /quota exceeded/);
});

test('write-back failure on the failure path is swallowed (no throw)', async () => {
  const d = deps({
    provisionTenant: async () => { throw new Error('boom'); },
    writeBack: async () => { throw new Error('org unreachable'); },
  });
  const r = await handleMessage({ org_id: 'org1', slug: 't3abc' }, d);
  assert.equal(r.ok, false); // does not throw
});
