'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentityService } = require('./app');
const { createInMemoryRepository } = require('./repository');
const { createMockProvider } = require('./provider');

const ctx1 = Object.freeze({ organizationId: 'org1', projectId: 'proj1', userId: 'u1' });
const ctx2 = Object.freeze({ organizationId: 'org1', projectId: 'proj1', userId: 'u2' });

function service() {
  return createIdentityService({
    repository: createInMemoryRepository(),
    provider: createMockProvider({}),
    hashPepper: 'pepper',
    now: () => Date.UTC(2026, 0, 1),
  });
}

test('session completes to normalized public facts without raw claim hashes', async () => {
  const svc = service();
  const created = await svc.createSession(ctx1, ['pan', 'ageProof', 'degree', 'apaar']);
  const completed = await svc.processSession(created.session, 'mock');
  assert.equal(completed.result.pan.status, 'verified');
  assert.equal(completed.result.pan.panLast4, '1234');
  assert.equal(completed.result.pan.panHash, undefined);
  assert.equal(completed.result.academic.apaarIdHash, undefined);
  assert.equal(completed.result.ageProof.ageYears, 31);
});

test('same PAN or APAAR cannot be claimed by another user', async () => {
  const svc = service();
  const first = await svc.createSession(ctx1, ['pan', 'apaar']);
  await svc.processSession(first.session, 'mock');
  const second = await svc.createSession(ctx2, ['pan', 'apaar']);
  await assert.rejects(
    () => svc.processSession(second.session, 'mock'),
    (err) => err && err.status === 409 && err.code === 'identity_claim_conflict'
  );
});

test('same user can rerun verification for an existing PAN claim', async () => {
  const svc = service();
  for (let i = 0; i < 2; i += 1) {
    const created = await svc.createSession(ctx1, ['pan']);
    const done = await svc.processSession(created.session, 'mock');
    assert.equal(done.session.status, 'verified');
  }
});

test('OAuth callback state validation fails closed', async () => {
  const svc = service();
  const created = await svc.createSession(ctx1, ['pan']);
  assert.throws(
    () => svc.validateOauthState(created.session, 'wrong-state'),
    (err) => err && err.status === 400 && err.code === 'invalid_oauth_state'
  );
});
