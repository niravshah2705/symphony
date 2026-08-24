'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentityService } = require('./app');
const { createFirestoreRepository, documentId } = require('./repository');
const { createMockProvider } = require('./provider');

const ctx1 = Object.freeze({ organizationId: 'org1', projectId: 'proj1', userId: 'u1' });
const ctx2 = Object.freeze({ organizationId: 'org1', projectId: 'proj1', userId: 'u2' });

function makeFakeFirestore() {
  const documents = new Map();
  let transactionCount = 0;

  function snapshot(data) {
    return { exists: data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };
  }

  class DocumentRef {
    constructor(key) { this.key = key; this.id = key.split('/').at(-1); }
    async get() { return snapshot(documents.get(this.key)); }
  }

  class CollectionRef {
    constructor(key) { this.key = key; }
    doc(id) { return new DocumentRef(`${this.key}/${id}`); }
    async getFrom(source) {
      const prefix = `${this.key}/`;
      return {
        docs: [...source.entries()]
          .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
          .map(([key, data]) => ({
            id: key.slice(prefix.length),
            data: () => structuredClone(data),
          })),
      };
    }
    async get() { return this.getFrom(documents); }
  }

  return {
    documents,
    get transactionCount() { return transactionCount; },
    collection(name) { return new CollectionRef(name); },
    async runTransaction(callback) {
      transactionCount += 1;
      const pending = new Map(documents);
      const tx = {
        get: async (ref) => {
          if (ref instanceof CollectionRef) return ref.getFrom(pending);
          return snapshot(pending.get(ref.key));
        },
        set: (ref, value) => { pending.set(ref.key, structuredClone(value)); },
      };
      const out = await callback(tx);
      documents.clear();
      for (const [key, value] of pending) documents.set(key, value);
      return out;
    },
  };
}

function firestoreService(fake) {
  return createIdentityService({
    repository: createFirestoreRepository({
      rootCollection: 'identity_verification_test',
      firestoreFactory: () => fake,
    }),
    provider: createMockProvider({}),
    hashPepper: 'pepper',
    now: () => Date.UTC(2026, 0, 1),
  });
}

test('Firestore repository persists sessions results and hashed claims', async () => {
  const fake = makeFakeFirestore();
  const svc = firestoreService(fake);
  const created = await svc.createSession(ctx1, ['pan', 'apaar']);
  const completed = await svc.processSession(created.session, 'mock');
  const restored = await svc.repository.getResult(completed.result.resultId);

  assert.equal(restored.resultId, completed.result.resultId);
  assert.equal(restored.userId, ctx1.userId);
  assert.equal(fake.transactionCount, 2);
  assert.equal([...fake.documents.keys()].some((key) => key.includes('ABCDE1234F')), false);
  assert.equal([...fake.documents.keys()].some((key) => key.includes('APAAR1234567890')), false);
  assert.equal(
    fake.documents.has(`identity_verification_test__sessions/${documentId(created.session.sessionId)}`),
    true,
  );
});

test('Firestore repository rejects PAN or APAAR already owned by another user', async () => {
  const fake = makeFakeFirestore();
  const svc = firestoreService(fake);
  const first = await svc.createSession(ctx1, ['pan', 'apaar']);
  await svc.processSession(first.session, 'mock');

  const second = await svc.createSession(ctx2, ['pan', 'apaar']);
  await assert.rejects(
    () => svc.processSession(second.session, 'mock'),
    (err) => err && err.status === 409 && err.code === 'identity_claim_conflict',
  );
});

test('Firestore repository lets the same user refresh an existing PAN claim', async () => {
  const fake = makeFakeFirestore();
  const svc = firestoreService(fake);

  const first = await svc.createSession(ctx1, ['pan']);
  await svc.processSession(first.session, 'mock');
  const second = await svc.createSession(ctx1, ['pan']);
  const refreshed = await svc.processSession(second.session, 'mock');

  assert.equal(refreshed.session.status, 'verified');
});
