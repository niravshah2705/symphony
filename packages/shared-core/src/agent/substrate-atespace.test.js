'use strict';

const os = require('node:os');
const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AI_FLEET_DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/substrate-atespace-');
test.after(() => { try { fs.rmSync(process.env.AI_FLEET_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });

const SUBSTRATE_ENV = [
  'SUBSTRATE_ATESPACE',
  'SUBSTRATE_ALLOWED_ATESPACES',
  'SUBSTRATE_ATESPACE_BY_ORG',
];

// CONFIG is built once from the environment, so each scenario needs a fresh read
// of it. (Same reason attachments/embed.test.js drops the module from the cache.)
function loadWith(env = {}) {
  for (const name of SUBSTRATE_ENV) delete process.env[name];
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('./substrate')];
  return require('./substrate');
}

function restore() {
  for (const name of SUBSTRATE_ENV) delete process.env[name];
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('./substrate')];
}

test.after(restore);

test('a per-tenant stack resolves to the atespace pinned at provision time', () => {
  const s = loadWith({ SUBSTRATE_ATESPACE: 'tenant-t0123456789ab' });
  assert.equal(s.resolveSubstrateAtespace({ organizationId: 'org-1' }), 'tenant-t0123456789ab');
  // With no binding table the operator's own space is the only answer, so a
  // caller that asks for another tenant's namespace is not honored.
  assert.equal(s.resolveSubstrateAtespace({ atespace: 'tenant-other' }), 'tenant-t0123456789ab');
});

test('a shared deployment routes each organization to its bound space', () => {
  const s = loadWith({ SUBSTRATE_ATESPACE_BY_ORG: 'org-acme=tenant-acme,org-bee=tenant-bee' });
  assert.equal(s.resolveSubstrateAtespace({ organizationId: 'org-acme' }), 'tenant-acme');
  assert.equal(s.resolveSubstrateAtespace({ organizationId: 'org-bee' }), 'tenant-bee');
});

// This is the whole point of the binding table. Defaulting an unbound org into the
// shared space is a silent cross-tenant placement: its actor would run inside
// someone else's namespace, with someone else's egress policy.
test('an organization that is not bound refuses instead of taking the default', () => {
  const s = loadWith({ SUBSTRATE_ATESPACE_BY_ORG: 'org-acme=tenant-acme' });
  assert.throws(
    () => s.resolveSubstrateAtespace({ organizationId: 'org-unbound' }),
    /org-unbound is not bound to any atespace/,
  );
});

test('a deployment that declared tenancy but bound no organization refuses', () => {
  const s = loadWith({ SUBSTRATE_ALLOWED_ATESPACES: 'tenant-a,tenant-b' });
  assert.throws(() => s.resolveSubstrateAtespace({}), /no atespace configured/);
});

// The settings value is operator-visible but reachable from a request path, so it
// must name a space the deployment has already declared.
test('a settings atespace outside the declared set is ignored', () => {
  const s = loadWith({ SUBSTRATE_ATESPACE: 'tenant-mine' });
  const store = require('../store');
  store.patchSettings({ substrateAtespace: 'tenant-theirs' });
  assert.equal(s.resolveSubstrateAtespace({ organizationId: 'org-1' }), 'tenant-mine');
  store.patchSettings({ substrateAtespace: 'tenant-mine' });
  assert.equal(s.resolveSubstrateAtespace({}), 'tenant-mine');
  store.patchSettings({ substrateAtespace: '' });
});

test('a malformed binding entry is dropped, not half-applied', () => {
  const { parseOrgAtespaces } = require('../config');
  assert.deepEqual(parseOrgAtespaces('org-1=tenant-a,org-2=,=tenant-b,org-3=Bad Name'), {
    'org-1': 'tenant-a',
  });
});
