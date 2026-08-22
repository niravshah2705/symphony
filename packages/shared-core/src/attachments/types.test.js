'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAttachmentType, SUPPORTED_ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, extensionOf } = require('./types');

test('resolveAttachmentType accepts every declared extension/mimeType pair, case-insensitively', () => {
  for (const [typeKey, def] of Object.entries(SUPPORTED_ATTACHMENT_TYPES)) {
    for (const ext of def.extensions) {
      const resolved = resolveAttachmentType(`file${ext.toUpperCase()}`, def.mimeTypes[0]);
      assert.equal(resolved.typeKey, typeKey, `expected ${ext} to resolve to ${typeKey}`);
    }
  }
});

test('resolveAttachmentType rejects a mismatched extension/mimeType pair', () => {
  assert.equal(resolveAttachmentType('report.pdf', 'image/png'), null);
  assert.equal(resolveAttachmentType('photo.png', 'application/pdf'), null);
});

test('resolveAttachmentType rejects unknown extensions and missing filenames', () => {
  assert.equal(resolveAttachmentType('archive.zip', 'application/zip'), null);
  assert.equal(resolveAttachmentType('', 'application/pdf'), null);
  assert.equal(resolveAttachmentType(null, null), null);
});

test('extensionOf lowercases and extracts the trailing extension only', () => {
  assert.equal(extensionOf('Report.PDF'), '.pdf');
  assert.equal(extensionOf('archive.tar.gz'), '.gz');
  assert.equal(extensionOf('noextension'), '');
});

test('images and legacy .doc are marked non-extractable; pdf/docx/txt are extractable', () => {
  assert.equal(SUPPORTED_ATTACHMENT_TYPES.jpg.extractable, false);
  assert.equal(SUPPORTED_ATTACHMENT_TYPES.png.extractable, false);
  assert.equal(SUPPORTED_ATTACHMENT_TYPES.doc.extractable, false);
  assert.equal(SUPPORTED_ATTACHMENT_TYPES.pdf.extractable, true);
  assert.equal(SUPPORTED_ATTACHMENT_TYPES.docx.extractable, true);
  assert.equal(SUPPORTED_ATTACHMENT_TYPES.txt.extractable, true);
});

test('MAX_ATTACHMENT_BYTES is 20MB', () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024);
});
