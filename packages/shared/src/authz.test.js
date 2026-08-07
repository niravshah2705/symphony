'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLE_PERMISSIONS,
  PUBLIC_PERMISSIONS,
  requiredLevel,
  permitted,
  permissionsForRole,
  resolveRole,
} = require('./authz');

test('requiredLevel: safe methods read, mutations write', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) assert.equal(requiredLevel(m), 'read');
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(requiredLevel(m), 'write');
});

test('permitted: write satisfies read, read does not satisfy write, absent denies', () => {
  assert.equal(permitted({ workspace: 'write' }, 'workspace', 'read'), true);
  assert.equal(permitted({ workspace: 'write' }, 'workspace', 'write'), true);
  assert.equal(permitted({ workspace: 'read' }, 'workspace', 'write'), false);
  assert.equal(permitted({ workspace: 'read' }, 'workspace', 'read'), true);
  assert.equal(permitted({ workspace: 'read' }, 'planning', 'read'), false);
  assert.equal(permitted(null, 'workspace', 'read'), false);
});

test('roles: admin writes everything, operator can read (not write) settings, viewer read-only', () => {
  assert.equal(ROLE_PERMISSIONS.admin.settings, 'write');
  assert.equal(ROLE_PERMISSIONS.operator.planning, 'write');
  assert.equal(ROLE_PERMISSIONS.operator.settings, 'read');
  for (const d of ['workspace', 'planning', 'insights', 'settings']) {
    assert.equal(ROLE_PERMISSIONS.viewer[d], 'read');
  }
  assert.deepEqual(PUBLIC_PERMISSIONS, { workspace: 'read' });
});

test('permissionsForRole: unknown role falls back to viewer (least privilege)', () => {
  assert.equal(permissionsForRole('nope'), ROLE_PERMISSIONS.viewer);
  assert.equal(permissionsForRole('admin'), ROLE_PERMISSIONS.admin);
});

test('resolveRole precedence: admin email > valid claim > default', () => {
  const config = { adminEmails: ['boss@corp.com'], defaultRole: 'viewer' };
  // bootstrap admin email wins even over a lower claim
  assert.equal(resolveRole({ email: 'boss@corp.com', role: 'viewer' }, config), 'admin');
  // valid claim honored
  assert.equal(resolveRole({ email: 'a@corp.com', role: 'operator' }, config), 'operator');
  // unknown claim → default (never elevates)
  assert.equal(resolveRole({ email: 'a@corp.com', role: 'superuser' }, config), 'viewer');
  // no claim → default
  assert.equal(resolveRole({ email: 'a@corp.com' }, config), 'viewer');
  // default falls back to viewer when config omits it
  assert.equal(resolveRole({ email: 'a@corp.com' }, {}), 'viewer');
});
