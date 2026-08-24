'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeFakeStorage, makeFakeFirestore } = require('./__fixtures__/fakes');
const service = require('./service');
const { AttachmentError } = require('./model');

const IDS = { orgId: 'org1', projectId: 'proj1', conversationId: 'conv1' };

function fakeEmbedFetch(dimension = 768) {
  return async (_url, init) => {
    const requests = JSON.parse(init.body).requests;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: requests.map((r, i) => {
          // Deterministic-but-distinct vectors so similarity ranking is meaningful in tests.
          const seed = r.content.parts[0].text.length + i;
          return { values: new Array(dimension).fill(0).map((_, j) => Math.sin(seed + j)) };
        }),
      }),
    };
  };
}

async function uploadFixture({ filename, mimeType, buffer, size }) {
  const fake = makeFakeStorage();
  const { db } = makeFakeFirestore();
  const deps = {
    storageFactory: fake.storageFactory,
    bucketNameOverride: 'test-bucket',
    firestoreFactory: () => db,
    fetchImpl: fakeEmbedFetch(),
    embeddingApiKey: 'test-key',
  };

  const minted = await service.mintUpload({ ...IDS, filename, mimeType, size: size ?? buffer.length }, deps);
  // Simulate the browser's PUT by placing the object directly in the fake bucket.
  fake.objects[minted.gcsPath] = { size: buffer.length, contentType: mimeType, buffer };

  const completed = await service.completeUpload({ ...IDS, attachmentId: minted.attachmentId }, deps);
  return { minted, completed, deps, db };
}

test('mintUpload rejects an unsupported type before touching storage', async () => {
  const fake = makeFakeStorage();
  await assert.rejects(
    () => service.mintUpload({ ...IDS, filename: 'a.zip', mimeType: 'application/zip', size: 10 }, { storageFactory: fake.storageFactory, bucketNameOverride: 'test-bucket', firestoreFactory: () => makeFakeFirestore().db }),
    AttachmentError
  );
  assert.equal(fake.calls.getSignedUrl.length, 0);
});

test('mint -> PUT -> complete ingests a pdf: extracts, chunks, embeds, and marks ready', async () => {
  const buffer = fs.readFileSync(path.join(__dirname, '__fixtures__', 'sample.pdf'));
  const { completed } = await uploadFixture({ filename: 'report.pdf', mimeType: 'application/pdf', buffer });
  assert.equal(completed.status, 'ready');
  assert.ok(completed.extractedChars > 0);
  assert.equal(completed.truncated, false);
});

test('mint -> PUT -> complete for an image skips extraction and marks ready immediately', async () => {
  const buffer = Buffer.from('fake-jpeg-bytes');
  const { completed } = await uploadFixture({ filename: 'photo.jpg', mimeType: 'image/jpeg', buffer });
  assert.equal(completed.status, 'ready');
  assert.equal(completed.extractedChars, 0);
});

test('mint -> PUT -> complete for a legacy .doc is accepted but marked unsupported, never indexed', async () => {
  const buffer = Buffer.from('legacy word binary bytes');
  const { completed, db } = await uploadFixture({ filename: 'legacy.doc', mimeType: 'application/msword', buffer });
  assert.equal(completed.status, 'unsupported');
  const results = await service.searchAttachments(
    { conversationId: IDS.conversationId, query: 'anything' },
    { firestoreFactory: () => db, fetchImpl: fakeEmbedFetch(), embeddingApiKey: 'k' }
  );
  assert.equal(results.length, 0);
});

test('completeUpload rejects when the browser never actually uploaded the object', async () => {
  const fake = makeFakeStorage();
  const { db } = makeFakeFirestore();
  const deps = { storageFactory: fake.storageFactory, bucketNameOverride: 'test-bucket', firestoreFactory: () => db };
  const minted = await service.mintUpload({ ...IDS, filename: 'a.txt', mimeType: 'text/plain', size: 10 }, deps);
  // Note: fake.objects[minted.gcsPath] is never set — nothing was actually uploaded.
  await assert.rejects(() => service.completeUpload({ ...IDS, attachmentId: minted.attachmentId }, deps), /not found in storage/);
});

test('completeUpload rejects a declared type mismatch against the actual uploaded object', async () => {
  const fake = makeFakeStorage();
  const { db } = makeFakeFirestore();
  const deps = { storageFactory: fake.storageFactory, bucketNameOverride: 'test-bucket', firestoreFactory: () => db };
  const minted = await service.mintUpload({ ...IDS, filename: 'a.pdf', mimeType: 'application/pdf', size: 10 }, deps);
  // The browser actually PUT a PNG despite declaring a PDF at mint time.
  fake.objects[minted.gcsPath] = { size: 10, contentType: 'image/png', buffer: Buffer.from('x') };
  await assert.rejects(() => service.completeUpload({ ...IDS, attachmentId: minted.attachmentId }, deps), /content type is not supported/);
});

test('completeUpload marks status failed (not thrown) when extraction blows up, and does not index partial chunks', async () => {
  const fake = makeFakeStorage();
  const { db } = makeFakeFirestore();
  const deps = { storageFactory: fake.storageFactory, bucketNameOverride: 'test-bucket', firestoreFactory: () => db };
  const minted = await service.mintUpload({ ...IDS, filename: 'broken.pdf', mimeType: 'application/pdf', size: 5 }, deps);
  // Not a real PDF — pdf-parse will throw during extraction.
  fake.objects[minted.gcsPath] = { size: 5, contentType: 'application/pdf', buffer: Buffer.from('nope!') };

  const completed = await service.completeUpload({ ...IDS, attachmentId: minted.attachmentId }, deps);
  assert.equal(completed.status, 'failed');
  assert.ok(completed.error);

  const results = await service.searchAttachments(
    { conversationId: IDS.conversationId, query: 'anything' },
    { firestoreFactory: () => db, fetchImpl: fakeEmbedFetch(), embeddingApiKey: 'k' }
  );
  assert.equal(results.length, 0);
});

test('searchAttachments never crosses conversation boundaries even within the same org/project', async () => {
  const buffer = fs.readFileSync(path.join(__dirname, '__fixtures__', 'sample.txt'));
  const { db } = await uploadFixture({ filename: 'sample.txt', mimeType: 'text/plain', buffer });

  const otherConvResults = await service.searchAttachments(
    { conversationId: 'a-totally-different-conversation', query: 'attachments test' },
    { firestoreFactory: () => db, fetchImpl: fakeEmbedFetch(), embeddingApiKey: 'k' }
  );
  assert.equal(otherConvResults.length, 0);

  const sameConvResults = await service.searchAttachments(
    { conversationId: IDS.conversationId, query: 'attachments test' },
    { firestoreFactory: () => db, fetchImpl: fakeEmbedFetch(), embeddingApiKey: 'k' }
  );
  assert.ok(sameConvResults.length > 0);
});

test('removeAttachment deletes the GCS object and the Firestore doc, and is idempotent', async () => {
  const buffer = Buffer.from('hello world');
  const { minted, deps, db } = await uploadFixture({ filename: 'note.txt', mimeType: 'text/plain', buffer });

  await service.removeAttachment({ ...IDS, attachmentId: minted.attachmentId }, deps);
  const remaining = await service.listAttachments(IDS, { firestoreFactory: () => db });
  assert.equal(remaining.length, 0);

  // Deleting again must not throw.
  await service.removeAttachment({ ...IDS, attachmentId: minted.attachmentId }, deps);
});

test('removeAllAttachmentsForConversation clears every attachment for that conversation, and only that conversation', async () => {
  const fake = makeFakeStorage();
  const { db } = makeFakeFirestore();
  const deps = { storageFactory: fake.storageFactory, bucketNameOverride: 'test-bucket', firestoreFactory: () => db };
  const otherConv = { ...IDS, conversationId: 'conv-other' };

  const one = await service.mintUpload({ ...IDS, filename: 'one.txt', mimeType: 'text/plain', size: 3 }, deps);
  fake.objects[one.gcsPath] = { size: 3, contentType: 'text/plain', buffer: Buffer.from('one') };
  await service.completeUpload({ ...IDS, attachmentId: one.attachmentId }, deps);

  const two = await service.mintUpload({ ...IDS, filename: 'two.txt', mimeType: 'text/plain', size: 3 }, deps);
  fake.objects[two.gcsPath] = { size: 3, contentType: 'text/plain', buffer: Buffer.from('two') };
  await service.completeUpload({ ...IDS, attachmentId: two.attachmentId }, deps);

  const otherAttachment = await service.mintUpload({ ...otherConv, filename: 'other.txt', mimeType: 'text/plain', size: 3 }, deps);
  fake.objects[otherAttachment.gcsPath] = { size: 3, contentType: 'text/plain', buffer: Buffer.from('other') };
  await service.completeUpload({ ...otherConv, attachmentId: otherAttachment.attachmentId }, deps);

  await service.removeAllAttachmentsForConversation(IDS, deps);

  assert.equal((await service.listAttachments(IDS, deps)).length, 0);
  assert.equal((await service.listAttachments(otherConv, deps)).length, 1);
});
