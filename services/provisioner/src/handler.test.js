'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleMessage } = require('./handler');

function deps(overrides = {}) {
  const calls = { provision: [], teardown: [], writeBack: [], step: [], atespace: [] };
  return {
    calls,
    cfg: { projectId: 'p' },
    log: { error() {} },
    provisionTenant: async (slug, cfg) => { calls.provision.push({ slug, cfg }); return { status: 'provisioned', slug, gateway: { url: 'https://gw' } }; },
    teardownTenant: async (slug, cfg) => { calls.teardown.push({ slug, cfg }); return {}; },
    writeBack: async (orgId, deployments) => { calls.writeBack.push({ orgId, deployments }); },
    checkFundStatus: async () => ({ fundsAvailable: true, fundStatus: 'available' }),
    writeStepStatus: async (orgId, runId, stepKey, body) => { calls.step.push({ orgId, runId, stepKey, ...body }); },
    ensureAtespace: async (input) => { calls.atespace.push(input); return { atespace: input.atespace, created: true, existed: false }; },
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

test('provision blocked when org funds are unavailable', async () => {
  const d = deps({
    checkFundStatus: async () => ({
      fundsAvailable: false,
      fundStatus: 'unavailable',
      reason: 'Low balance',
      sandboxCreationDisabled: true,
    }),
  });
  const r = await handleMessage({ org_id: 'org1', slug: 't3abc', action: 'provision' }, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sandbox_creation_disabled');
  assert.equal(d.calls.provision.length, 0); // did not provision
  assert.equal(d.calls.writeBack.length, 1);
  assert.equal(d.calls.writeBack[0].deployments.status, 'disabled');
  assert.equal(d.calls.writeBack[0].deployments.sandbox_creation_disabled, true);
});

// ── substrate-atespace: the environment-init step the org service hands us ──

const MSG = {
  org_id: 'org1',
  slug: 't3abc',
  action: 'substrate-atespace',
  run_id: 'run1',
  step_key: 'substrate.atespace',
  atespace: 'tenant-t3abc',
};

test('substrate-atespace: creates the namespace the init job named and settles the step', async () => {
  const d = deps({ cfg: { projectId: 'p', substrateUrl: 'https://ate.example' } });
  const r = await handleMessage(MSG, d);
  assert.equal(r.ok, true);
  assert.deepEqual(d.calls.atespace[0], { atespace: 'tenant-t3abc', organizationId: 'org1' });
  assert.equal(d.calls.step[0].status, 'COMPLETED');
  assert.deepEqual(d.calls.step[0].detail, { atespace: 'tenant-t3abc', created: true, existed: false });
  assert.equal(d.calls.provision.length, 0, 'asks for no Cloud Run stack');
});

test('substrate-atespace: SKIPPED with a reason when the deployment has no control plane', async () => {
  const d = deps(); // cfg.substrateUrl unset, and CONFIG.SUBSTRATE.url defaults to empty
  const r = await handleMessage(MSG, d);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(d.calls.atespace.length, 0);
  assert.equal(d.calls.step[0].status, 'SKIPPED');
  assert.match(d.calls.step[0].detail.reason, /no substrate control plane/);
});

test('substrate-atespace: refuses a name the deployment would not resolve to itself', async () => {
  // The message names tenant-t3abc; the deployment routes org1 elsewhere. Creating
  // the requested one anyway would split the tenant across namespaces.
  const d = deps({
    cfg: { projectId: 'p', substrateUrl: 'https://ate.example' },
    ensureAtespace: async () => ({ atespace: 'tenant-a', created: true, existed: false }),
  });
  const r = await handleMessage(MSG, d);
  assert.equal(r.ok, false);
  assert.match(r.reason, /resolves org1 to atespace "tenant-a"/);
  assert.equal(d.calls.step[0].status, 'FAILED');
});

test('substrate-atespace: an ateapi error still settles the step as FAILED', async () => {
  const d = deps({
    cfg: { projectId: 'p', substrateUrl: 'https://ate.example' },
    ensureAtespace: async () => { throw new Error('CreateAtespace failed (14): unavailable'); },
  });
  const r = await handleMessage(MSG, d);
  assert.equal(r.ok, false);
  assert.equal(d.calls.step[0].status, 'FAILED');
  assert.match(d.calls.step[0].detail.error, /unavailable/);
});

test('substrate-atespace: a message without the step address performs nothing', async () => {
  const d = deps({ cfg: { projectId: 'p', substrateUrl: 'https://ate.example' } });
  const r = await handleMessage({ ...MSG, step_key: undefined }, d);
  assert.equal(r.reason, 'malformed');
  assert.equal(d.calls.atespace.length, 0);
  assert.equal(d.calls.step.length, 0);
});
