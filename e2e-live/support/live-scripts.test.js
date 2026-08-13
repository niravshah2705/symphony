'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { atomicWriteStorageState, parseCaptureArgs } = require('../scripts/capture-auth');
const { noElevatedClaims, normalizeRepository, validateIdentity, writeAudit } = require('../scripts/audit');

const TENANT = Object.freeze({
  organizationId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
});
const OPERATOR_PERMISSIONS = Object.freeze({
  workspace: 'write', planning: 'write', insights: 'write', settings: 'read', org: 'write',
});

test('capture arguments support sequential defaults or one explicit tenant', () => {
  assert.deepEqual(parseCaptureArgs([]), { tenant: '', output: '', help: false });
  const parsed = parseCaptureArgs(['--tenant', 'b', '--output', './private-b.json']);
  assert.equal(parsed.tenant, 'b');
  assert.equal(parsed.output, path.resolve('./private-b.json'));
  assert.throws(() => parseCaptureArgs(['--output', 'state.json']), /requires --tenant/);
  assert.throws(() => parseCaptureArgs(['--tenant', 'customer']), /must be a or b/);
});

test('capture and audit writers create private, parseable JSON artifacts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-writers-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'auth', 'tenant.json');
  atomicWriteStorageState(statePath, {
    cookies: [{ name: 'session', value: 'not-printed', domain: 'qa.example.test', path: '/' }],
    origins: [],
  });
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).cookies.length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(statePath).mode & 0o077, 0);

  const auditPath = path.join(directory, 'evidence', 'audit.json');
  writeAudit(auditPath, { result: 'passed', checks: { health: { status: 'passed', httpStatus: 200 } } });
  assert.equal(JSON.parse(fs.readFileSync(auditPath, 'utf8')).result, 'passed');
  if (process.platform !== 'win32') assert.equal(fs.statSync(auditPath).mode & 0o077, 0);
});

test('identity validation rejects admin/super identities and accepts least-privilege operator', () => {
  const context = {
    user: { is_super_admin: false },
    organizations: [{ id: TENANT.organizationId, projects: [{ id: TENANT.projectId }] }],
  };
  assert.equal(validateIdentity({
    authenticated: true,
    role: 'operator',
    permissions: OPERATOR_PERMISSIONS,
  }, context, TENANT, 'operator'), 'operator');
  assert.throws(() => validateIdentity({
    authenticated: true,
    role: 'admin',
    permissions: { ...OPERATOR_PERMISSIONS, settings: 'write' },
  }, context, TENANT, 'operator'), /admin or super-user/);
  assert.throws(() => noElevatedClaims({ customClaims: { superAdmin: true } }), /super-user claim/);
});

test('repository normalization compares configured URL and OWNER/REPO safely', () => {
  assert.equal(normalizeRepository('https://github.com/Owner/Repo.git'), 'owner/repo');
  assert.equal(normalizeRepository('OWNER/REPO'), 'owner/repo');
});
