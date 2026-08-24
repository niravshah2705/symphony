'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractText, MAX_EXTRACTED_TEXT_CHARS } = require('./extract');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '__fixtures__', name));

test('extractText(pdf) pulls the golden text out of a real PDF', async () => {
  const { text, truncated } = await extractText(fixture('sample.pdf'), 'pdf');
  assert.match(text, /Hello attachments test/);
  assert.equal(truncated, false);
});

test('extractText(docx) pulls the golden text out of a real DOCX', async () => {
  const { text, truncated } = await extractText(fixture('sample.docx'), 'docx');
  assert.match(text, /Walking on imported air/);
  assert.equal(truncated, false);
});

test('extractText(txt) passes UTF-8 text through verbatim', async () => {
  const { text, truncated } = await extractText(fixture('sample.txt'), 'txt');
  assert.equal(text, 'Hello attachments test\nSecond line.\n');
  assert.equal(truncated, false);
});

test('extractText bounds pathologically large text and marks it truncated', async () => {
  const huge = Buffer.from('a'.repeat(MAX_EXTRACTED_TEXT_CHARS + 500), 'utf8');
  const { text, truncated } = await extractText(huge, 'txt');
  assert.equal(text.length, MAX_EXTRACTED_TEXT_CHARS);
  assert.equal(truncated, true);
});

test('extractText rejects a non-extractable type rather than silently returning empty text', async () => {
  await assert.rejects(() => extractText(Buffer.from(''), 'jpg'), /non-extractable/);
  await assert.rejects(() => extractText(Buffer.from(''), 'doc'), /non-extractable/);
});
