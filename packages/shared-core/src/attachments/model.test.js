'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AttachmentError,
  sanitizeFilename,
  newAttachmentId,
  newChunkId,
  validateUploadRequest,
  revalidateUploadedObject,
  isValidAttachmentId,
} = require('./model');
const { MAX_ATTACHMENT_BYTES } = require('./types');

test('sanitizeFilename strips path separators and control characters, bounds length', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitizeFilename('a\\b/c.pdf'), 'a_b_c.pdf');
  assert.equal(sanitizeFilename(`bad${String.fromCharCode(1)}name.txt`), 'badname.txt');
  assert.equal(sanitizeFilename('  spaced.txt  '), 'spaced.txt');
  assert.equal(sanitizeFilename('y'.repeat(300)).length, 255);
  assert.equal(sanitizeFilename(null), '');
});

test('newAttachmentId/newChunkId produce distinct, prefixed, pattern-valid ids', () => {
  const a = newAttachmentId();
  const b = newAttachmentId();
  assert.notEqual(a, b);
  assert.match(a, /^att_/);
  assert.ok(isValidAttachmentId(a));
  assert.match(newChunkId(), /^chunk_/);
});

test('validateUploadRequest accepts a well-formed pdf request', () => {
  const result = validateUploadRequest({ filename: 'revenue.pdf', mimeType: 'application/pdf', size: 1024 });
  assert.equal(result.filename, 'revenue.pdf');
  assert.equal(result.typeKey, 'pdf');
  assert.equal(result.kind, 'text');
  assert.equal(result.extractable, true);
});

test('validateUploadRequest rejects missing filename', () => {
  assert.throws(() => validateUploadRequest({ filename: '', mimeType: 'application/pdf', size: 1 }), AttachmentError);
});

test('validateUploadRequest rejects unsupported type', () => {
  assert.throws(
    () => validateUploadRequest({ filename: 'archive.zip', mimeType: 'application/zip', size: 1 }),
    /not a supported attachment type/
  );
});

test('validateUploadRequest rejects non-positive or non-numeric size', () => {
  assert.throws(() => validateUploadRequest({ filename: 'a.pdf', mimeType: 'application/pdf', size: 0 }), /positive number/);
  assert.throws(() => validateUploadRequest({ filename: 'a.pdf', mimeType: 'application/pdf', size: 'nope' }), /positive number/);
});

test('validateUploadRequest rejects a file over the size limit', () => {
  assert.throws(
    () => validateUploadRequest({ filename: 'a.pdf', mimeType: 'application/pdf', size: MAX_ATTACHMENT_BYTES + 1 }),
    /exceeds the 20MB limit/
  );
});

test('revalidateUploadedObject accepts an object matching declared metadata', () => {
  const declared = { filename: 'revenue.pdf', mimeType: 'application/pdf' };
  const result = revalidateUploadedObject(declared, { size: 2048, contentType: 'application/pdf' });
  assert.equal(result.typeKey, 'pdf');
  assert.equal(result.size, 2048);
});

test('revalidateUploadedObject rejects an object whose actual content type does not match', () => {
  const declared = { filename: 'revenue.pdf', mimeType: 'application/pdf' };
  assert.throws(
    () => revalidateUploadedObject(declared, { size: 2048, contentType: 'image/png' }),
    /content type is not supported/
  );
});

test('revalidateUploadedObject rejects an object over the size limit even if declared size was smaller', () => {
  const declared = { filename: 'revenue.pdf', mimeType: 'application/pdf' };
  assert.throws(
    () => revalidateUploadedObject(declared, { size: MAX_ATTACHMENT_BYTES + 1, contentType: 'application/pdf' }),
    /exceeds the 20MB limit/
  );
});

test('revalidateUploadedObject rejects a missing/invalid reported size', () => {
  const declared = { filename: 'revenue.pdf', mimeType: 'application/pdf' };
  assert.throws(() => revalidateUploadedObject(declared, { contentType: 'application/pdf' }), /could not be verified/);
});

test('isValidAttachmentId rejects malformed ids', () => {
  assert.equal(isValidAttachmentId('att_short'), false);
  assert.equal(isValidAttachmentId('not-att-prefixed_12345678'), false);
  assert.equal(isValidAttachmentId(''), false);
  assert.equal(isValidAttachmentId(null), false);
});
