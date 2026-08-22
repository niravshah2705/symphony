'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAttachment,
  getAttachment,
  updateAttachment,
  listAttachments,
  deleteAttachment,
  addChunks,
  searchAttachmentChunks,
} = require('./store');
const { makeFakeFirestore } = require('./__fixtures__/fakes');

const IDS_A = { orgId: 'org1', projectId: 'proj1', conversationId: 'conv1', attachmentId: 'att_1' };
const IDS_B = { orgId: 'org1', projectId: 'proj1', conversationId: 'conv2', attachmentId: 'att_2' };

test('createAttachment/getAttachment round-trip a record at the nested path', async () => {
  const { db } = makeFakeFirestore();
  const record = { ...IDS_A, filename: 'a.pdf', status: 'pending' };
  await createAttachment(db, record);
  const fetched = await getAttachment(db, IDS_A);
  assert.deepEqual(fetched, record);
});

test('getAttachment returns null for a document that was never created', async () => {
  const { db } = makeFakeFirestore();
  assert.equal(await getAttachment(db, IDS_A), null);
});

test('updateAttachment merges a patch without clobbering other fields', async () => {
  const { db } = makeFakeFirestore();
  await createAttachment(db, { ...IDS_A, filename: 'a.pdf', status: 'pending' });
  const updated = await updateAttachment(db, IDS_A, { status: 'ready' });
  assert.equal(updated.status, 'ready');
  assert.equal(updated.filename, 'a.pdf');
});

test('listAttachments returns only attachments under the given conversation', async () => {
  const { db } = makeFakeFirestore();
  await createAttachment(db, { ...IDS_A, filename: 'a.pdf' });
  await createAttachment(db, { ...IDS_B, filename: 'b.pdf' });
  const listA = await listAttachments(db, IDS_A);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].filename, 'a.pdf');
});

test('deleteAttachment removes the attachment doc and its chunk subcollection', async () => {
  const { db, docs } = makeFakeFirestore();
  await createAttachment(db, { ...IDS_A, filename: 'a.pdf' });
  await addChunks(db, IDS_A, [
    { chunkId: 'chunk_1', text: 'hello', embedding: [1, 0], ...IDS_A },
    { chunkId: 'chunk_2', text: 'world', embedding: [0, 1], ...IDS_A },
  ]);
  assert.equal(docs.size, 3);
  await deleteAttachment(db, IDS_A);
  assert.equal(docs.size, 0);
});

test('searchAttachmentChunks scopes to the given conversationId and ranks by similarity', async () => {
  const { db } = makeFakeFirestore();
  await createAttachment(db, { ...IDS_A, filename: 'a.pdf' });
  await createAttachment(db, { ...IDS_B, filename: 'b.pdf' });
  await addChunks(db, IDS_A, [
    { chunkId: 'chunk_close', text: 'close match', embedding: [1, 0], conversationId: IDS_A.conversationId },
    { chunkId: 'chunk_far', text: 'far match', embedding: [0, 1], conversationId: IDS_A.conversationId },
  ]);
  await addChunks(db, IDS_B, [
    { chunkId: 'chunk_other_conv', text: 'other conversation', embedding: [1, 0], conversationId: IDS_B.conversationId },
  ]);

  const results = await searchAttachmentChunks(db, { conversationId: IDS_A.conversationId, queryVector: [1, 0], limit: 5 });
  assert.equal(results.length, 2);
  assert.equal(results[0].chunkId, 'chunk_close');
  assert.ok(results.every((r) => r.conversationId === IDS_A.conversationId));
});

test('searchAttachmentChunks never returns chunks from a different conversation, even with a matching vector', async () => {
  const { db } = makeFakeFirestore();
  await addChunks(db, IDS_A, [{ chunkId: 'chunk_a', text: 'a', embedding: [1, 0], conversationId: IDS_A.conversationId }]);
  await addChunks(db, IDS_B, [{ chunkId: 'chunk_b', text: 'b', embedding: [1, 0], conversationId: IDS_B.conversationId }]);

  const results = await searchAttachmentChunks(db, { conversationId: IDS_B.conversationId, queryVector: [1, 0], limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].chunkId, 'chunk_b');
});

test('searchAttachmentChunks respects the limit', async () => {
  const { db } = makeFakeFirestore();
  await addChunks(db, IDS_A, [
    { chunkId: 'chunk_1', text: '1', embedding: [1, 0], conversationId: IDS_A.conversationId },
    { chunkId: 'chunk_2', text: '2', embedding: [0.9, 0.1], conversationId: IDS_A.conversationId },
    { chunkId: 'chunk_3', text: '3', embedding: [0.1, 0.9], conversationId: IDS_A.conversationId },
  ]);
  const results = await searchAttachmentChunks(db, { conversationId: IDS_A.conversationId, queryVector: [1, 0], limit: 2 });
  assert.equal(results.length, 2);
});
