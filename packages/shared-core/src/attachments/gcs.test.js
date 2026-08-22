'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { objectPath, mintUploadUrl, getObjectMetadata, deleteObject, readObjectBuffer } = require('./gcs');
const { makeFakeStorage } = require('./__fixtures__/fakes');

test('objectPath is server-derived and includes org/project/conversation/attachment scoping', () => {
  const path = objectPath({ orgId: 'org1', projectId: 'proj1', conversationId: 'conv1', attachmentId: 'att_1', filename: 'report.pdf' });
  assert.equal(path, 'organizations/org1/projects/proj1/conversations/conv1/attachments/att_1-report.pdf');
});

test('mintUploadUrl requests a v4 write-scoped signed URL for the exact object path', async () => {
  const { storageFactory, calls } = makeFakeStorage();
  const { url, expiresAt } = await mintUploadUrl('organizations/org1/.../att_1-a.pdf', {
    contentType: 'application/pdf',
    storageFactory,
    bucketNameOverride: 'test-bucket',
  });
  assert.match(url, /signed=1/);
  assert.equal(calls.getSignedUrl.length, 1);
  assert.equal(calls.getSignedUrl[0].opts.version, 'v4');
  assert.equal(calls.getSignedUrl[0].opts.action, 'write');
  assert.equal(calls.getSignedUrl[0].opts.contentType, 'application/pdf');
  assert.ok(new Date(expiresAt).getTime() > Date.now());
});

test('getObjectMetadata returns null for a non-existent object (never trusts the caller)', async () => {
  const { storageFactory } = makeFakeStorage({ objects: {} });
  const metadata = await getObjectMetadata('missing/path.pdf', { storageFactory, bucketNameOverride: 'test-bucket' });
  assert.equal(metadata, null);
});

test('getObjectMetadata returns the actual size/contentType for an existing object', async () => {
  const { storageFactory } = makeFakeStorage({ objects: { 'a/b.pdf': { size: 2048, contentType: 'application/pdf' } } });
  const metadata = await getObjectMetadata('a/b.pdf', { storageFactory, bucketNameOverride: 'test-bucket' });
  assert.deepEqual(metadata, { size: 2048, contentType: 'application/pdf' });
});

test('deleteObject removes the object and ignores a missing one', async () => {
  const { storageFactory, objects } = makeFakeStorage({ objects: { 'a/b.pdf': { size: 1, contentType: 'text/plain' } } });
  await deleteObject('a/b.pdf', { storageFactory, bucketNameOverride: 'test-bucket' });
  assert.equal(objects['a/b.pdf'], undefined);
});

test('readObjectBuffer returns the raw bytes', async () => {
  const { storageFactory } = makeFakeStorage({ objects: { 'a/b.txt': { size: 5, contentType: 'text/plain', buffer: Buffer.from('hello') } } });
  const buffer = await readObjectBuffer('a/b.txt', { storageFactory, bucketNameOverride: 'test-bucket' });
  assert.equal(buffer.toString('utf8'), 'hello');
});
