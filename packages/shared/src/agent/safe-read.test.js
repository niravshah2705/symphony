'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sanitizeReadResult, isModelSafeMime, looksLikeText, installSafeRead } = require('./safe-read');

const bin = (arr) => new Uint8Array(arr);

test('isModelSafeMime accepts text, json, pdf and supported images only', () => {
  // Arrange / Act / Assert
  for (const m of ['text/plain', 'text/markdown', 'application/json', 'application/javascript',
    'image/svg+xml', 'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    assert.strictEqual(isModelSafeMime(m), true, `${m} should be safe`);
  }
  for (const m of ['application/octet-stream', 'image/heic', 'image/heif', 'audio/mpeg',
    'video/mp4', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '']) {
    assert.strictEqual(isModelSafeMime(m), false, `${m} should be unsafe`);
  }
});

test('looksLikeText rejects buffers with NUL bytes', () => {
  assert.strictEqual(looksLikeText(Buffer.from('FROM node:20\nRUN echo hi\n')), true);
  assert.strictEqual(looksLikeText(bin([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), false); // PNG header + NUL
});

test('passes through text results untouched', () => {
  const result = { content: 'const x = 1;', mimeType: 'text/plain' };
  assert.deepStrictEqual(sanitizeReadResult(result, 'a.ts'), result);
});

test('passes through PDF and supported image results untouched', () => {
  const pdf = { content: bin([0x25, 0x50, 0x44, 0x46]), mimeType: 'application/pdf' };
  assert.strictEqual(sanitizeReadResult(pdf, 'doc.pdf'), pdf);
  const png = { content: bin([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' };
  assert.strictEqual(sanitizeReadResult(png, 'logo.png'), png);
});

test('passes through error results untouched', () => {
  const err = { error: "File 'x' not found" };
  assert.strictEqual(sanitizeReadResult(err, 'x'), err);
});

test('decodes text-looking octet-stream (e.g. Dockerfile) to utf-8 text', () => {
  // Arrange: extensionless file → deepagents returns octet-stream binary
  const bytes = Buffer.from('FROM node:20-alpine\nWORKDIR /app\nCOPY . .\n');
  const result = { content: new Uint8Array(bytes), mimeType: 'application/octet-stream' };
  // Act
  const out = sanitizeReadResult(result, 'Dockerfile');
  // Assert
  assert.strictEqual(out.mimeType, 'text/plain');
  assert.strictEqual(out.content, 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\n');
});

test('replaces true binary (non-PDF) with a text placeholder', () => {
  const result = { content: bin([0x00, 0x01, 0x02, 0xff, 0xfe]), mimeType: 'image/x-icon' };
  const out = sanitizeReadResult(result, 'favicon.ico');
  assert.strictEqual(out.mimeType, 'text/plain');
  assert.match(out.content, /binary file not shown: favicon\.ico/);
  assert.match(out.content, /image\/x-icon/);
});

test('replaces unsupported image type (heic) with a placeholder', () => {
  const result = { content: bin([0x00, 0x00, 0x00, 0x18]), mimeType: 'image/heic' };
  const out = sanitizeReadResult(result, 'photo.heic');
  assert.strictEqual(out.mimeType, 'text/plain');
  assert.match(out.content, /binary file not shown/);
});

test('tags non-safe string content (empty-file warning) as text/plain', () => {
  const result = { content: 'System reminder: File exists but has empty contents', mimeType: 'application/octet-stream' };
  const out = sanitizeReadResult(result, 'empty.bin');
  assert.strictEqual(out.mimeType, 'text/plain');
  assert.match(out.content, /empty contents/);
});

test('installSafeRead patches read() idempotently and downgrades binary', async () => {
  // Arrange: a fake backend whose read returns an unsupported binary block
  let calls = 0;
  const backend = {
    async read() {
      calls++;
      return { content: bin([0x00, 0x01, 0x02]), mimeType: 'application/octet-stream' };
    },
  };
  // Act
  installSafeRead(backend);
  installSafeRead(backend); // second call must not double-wrap
  const out = await backend.read('mystery.bin', 0, 100);
  // Assert
  assert.strictEqual(calls, 1);
  assert.strictEqual(out.mimeType, 'text/plain');
  assert.match(out.content, /binary file not shown: mystery\.bin/);
});
