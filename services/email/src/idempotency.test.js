'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryIdempotencyStore, documentId } = require('./idempotency');

test('document ids are stable hashes and never expose the caller key', () => {
  const id = documentId('invite:org:user@example.com');
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(id.includes('user'), false);
  assert.equal(id, documentId('invite:org:user@example.com'));
});

test('a completed key is deduplicated for the retention window', async () => {
  const store = new MemoryIdempotencyStore({ leaseMs: 100, retentionMs: 1000 });
  const claim = await store.claim('key', 1000);
  assert.equal(claim.acquired, true);
  assert.deepEqual(await store.claim('key', 1001), { acquired: false, state: 'in_progress' });
  await store.complete('key', claim.claimId, 1010);
  assert.deepEqual(await store.claim('key', 1500), { acquired: false, state: 'sent' });
  assert.equal((await store.claim('key', 2011)).acquired, true);
});

test('a failed claim can be released and retried', async () => {
  const store = new MemoryIdempotencyStore();
  const first = await store.claim('key');
  await store.release('key', first.claimId);
  const retry = await store.claim('key');
  assert.equal(retry.acquired, true);
  assert.notEqual(retry.claimId, first.claimId);
});
