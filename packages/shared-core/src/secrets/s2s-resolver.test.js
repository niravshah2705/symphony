'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest } = require('./s2s-resolver');

test('per-org path is chosen when org id + org internal token are present', () => {
  const req = buildRequest({
    organizationId: 'acme',
    projectId: 'p-1',
    orgInternalToken: 'orgtok',
    internalToken: 'tok',
  });
  assert.equal(req.path, '/api/v1/internal/s2s/orgs/acme/secrets?project_id=p-1');
  assert.deepEqual(req.headers, { 'x-org-internal-token': 'orgtok' });
});

test('shared managed path is used when only the internal token is present', () => {
  const req = buildRequest({ organizationId: '', internalToken: 'tok' });
  assert.equal(req.path, '/api/v1/internal/s2s/managed-secrets');
  assert.deepEqual(req.headers, { 'x-internal-token': 'tok' });
});

test('no request when neither credential is available (fails closed)', () => {
  assert.equal(buildRequest({ organizationId: 'acme', orgInternalToken: '', internalToken: '' }), null);
});
