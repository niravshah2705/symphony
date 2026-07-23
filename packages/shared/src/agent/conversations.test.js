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

test('summarizeConversation omits messages and counts them', () => {
  const summary = summarizeConversation({ id: 'conv_1', title: 'T', createdAt: 'a', updatedAt: 'b', messages: [{}, {}] });
  assert.deepEqual(summary, { id: 'conv_1', title: 'T', createdAt: 'a', updatedAt: 'b', messageCount: 2 });
  assert.equal(summary.messages, undefined);
});
