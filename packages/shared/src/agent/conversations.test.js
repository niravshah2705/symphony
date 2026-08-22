'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMessages,
  deriveTitle,
  normalizeTitle,
  summarizeConversation,
  ConversationError,
  MAX_MESSAGES_PER_REQUEST,
  MAX_ATTACHMENTS_PER_MESSAGE,
} = require('./conversations');

test('normalizeMessages keeps only allowlisted fields per role (no mass assignment)', () => {
  const out = normalizeMessages([
    { role: 'user', text: 'assess a saas idea', id: 'x', extra: 1 },
    { role: 'assistant', intent: 'business', title: 'Business workflow', copy: 'I ran the pipeline', label: 'Business', warning: '', input: 'assess a saas idea', payload: { huge: true } },
  ]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['role', 'text']);
  assert.equal(out[0].text, 'assess a saas idea');
  assert.deepEqual(Object.keys(out[1]).sort(), ['copy', 'input', 'intent', 'label', 'role', 'title', 'warning']);
  assert.equal(out[1].payload, undefined);
  assert.equal(out[1].intent, 'business');
});

test('normalizeMessages validates array shape and size', () => {
  assert.throws(() => normalizeMessages([]), ConversationError);
  assert.throws(() => normalizeMessages('nope'), ConversationError);
  assert.throws(() => normalizeMessages(new Array(MAX_MESSAGES_PER_REQUEST + 1).fill({ role: 'user', text: 'x' })), /per request/);
});

test('normalizeMessages enforces role and required content', () => {
  assert.throws(() => normalizeMessages([{ role: 'system', text: 'x' }]), /role/);
  assert.throws(() => normalizeMessages([{ role: 'user', text: '   ' }]), /requires text/);
  assert.throws(() => normalizeMessages([{ role: 'assistant', copy: '', title: '' }]), /copy or title/);
});

test('normalizeMessages bounds long fields', () => {
  const [msg] = normalizeMessages([{ role: 'user', text: 'y'.repeat(9000) }]);
  assert.equal(msg.text.length, 8000);
});

test('deriveTitle collapses to a single bounded line, with a fallback', () => {
  assert.equal(deriveTitle('  Pressure-test my   revenue model  '), 'Pressure-test my revenue model');
  assert.ok(deriveTitle('z'.repeat(200)).length <= 60);
  assert.equal(deriveTitle('   '), 'New conversation');
});

test('normalizeTitle trims/bounds and rejects empty', () => {
  assert.equal(normalizeTitle('  My thread  '), 'My thread');
  assert.throws(() => normalizeTitle('   '), ConversationError);
});

test('normalizeMessages keeps a bounded attachments array on user messages, omitted when absent', () => {
  const attachment = { id: 'att_12345678', filename: 'revenue.pdf', mimeType: 'application/pdf', size: 1024 };
  const [withAttachment] = normalizeMessages([{ role: 'user', text: 'see attached', attachments: [attachment] }]);
  assert.deepEqual(withAttachment.attachments, [attachment]);

  const [withoutAttachment] = normalizeMessages([{ role: 'user', text: 'no files here' }]);
  assert.deepEqual(Object.keys(withoutAttachment).sort(), ['role', 'text']);
});

test('normalizeMessages rejects malformed or oversized attachment references', () => {
  assert.throws(
    () => normalizeMessages([{ role: 'user', text: 'x', attachments: [{ id: 'not-an-attachment-id', filename: 'a.pdf', mimeType: 'application/pdf', size: 1 }] }]),
    /attachment id is invalid/
  );
  assert.throws(
    () => normalizeMessages([{ role: 'user', text: 'x', attachments: [{ id: 'att_12345678', filename: '', mimeType: 'application/pdf', size: 1 }] }]),
    /filename is required/
  );
  assert.throws(
    () => normalizeMessages([{ role: 'user', text: 'x', attachments: [{ id: 'att_12345678', filename: 'a.pdf', mimeType: 'application/pdf', size: -1 }] }]),
    /positive number/
  );
  const tooMany = new Array(MAX_ATTACHMENTS_PER_MESSAGE + 1).fill({ id: 'att_12345678', filename: 'a.pdf', mimeType: 'application/pdf', size: 1 });
  assert.throws(
    () => normalizeMessages([{ role: 'user', text: 'x', attachments: tooMany }]),
    /at most/
  );
});

test('normalizeMessages keeps a bounded citations array on assistant messages, omitted when absent', () => {
  const citation = { attachmentId: 'att_12345678', filename: 'revenue.pdf', snippet: 'Q3 revenue grew 12%.' };
  const [withCitation] = normalizeMessages([
    { role: 'assistant', title: 'Answer', copy: 'Based on your file…', citations: [citation] },
  ]);
  assert.deepEqual(withCitation.citations, [citation]);

  const [withoutCitation] = normalizeMessages([{ role: 'assistant', title: 'Answer', copy: 'No files involved' }]);
  assert.equal(withoutCitation.citations, undefined);
});

test('normalizeMessages rejects malformed citations', () => {
  assert.throws(
    () => normalizeMessages([{ role: 'assistant', title: 'Answer', copy: 'x', citations: [{ attachmentId: 'bad', filename: 'a.pdf', snippet: 's' }] }]),
    /citation attachmentId is invalid/
  );
  assert.throws(
    () => normalizeMessages([{ role: 'assistant', title: 'Answer', copy: 'x', citations: [{ attachmentId: 'att_12345678', filename: 'a.pdf', snippet: '' }] }]),
    /requires a snippet/
  );
});

test('summarizeConversation omits messages and counts them', () => {
  const summary = summarizeConversation({ id: 'conv_1', title: 'T', createdAt: 'a', updatedAt: 'b', messages: [{}, {}] });
  assert.deepEqual(summary, { id: 'conv_1', title: 'T', createdAt: 'a', updatedAt: 'b', messageCount: 2 });
  assert.equal(summary.messages, undefined);
});
