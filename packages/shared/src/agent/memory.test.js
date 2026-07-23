'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MEMORY_SCOPES,
  MemoryError,
  normalizeMemory,
  detectMemoryScope,
  detectMemoryWrite,
  searchMemories,
} = require('./memory');

test('normalizeMemory validates scope, bounds fields, and strips unknown keys', () => {
  const record = normalizeMemory({
    scope: 'business',
    refId: 'proj_123',
    title: 'Pricing decision',
    text: 'Charge $9/mo with a 14-day trial.',
    tags: ['pricing', 'pricing', 'trial'],
    source: 'business-pipeline',
    id: 'attacker-supplied', // must be ignored (no mass assignment)
    createdAt: 'attacker-supplied',
  });
  assert.deepEqual(Object.keys(record).sort(), ['refId', 'scope', 'source', 'tags', 'text', 'title'].sort());
  assert.equal(record.scope, 'business');
  assert.equal(record.refId, 'proj_123');
  assert.deepEqual(record.tags, ['pricing', 'trial']); // deduped
  assert.equal(record.source, 'business-pipeline');
});

test('normalizeMemory defaults source, derives title, and requires text', () => {
  const record = normalizeMemory({ scope: 'user', text: 'I prefer dark mode and concise summaries.' });
  assert.equal(record.source, 'omnibox');
  assert.equal(record.refId, null);
  assert.ok(record.title.length > 0 && record.title.length <= 60);
  assert.throws(() => normalizeMemory({ scope: 'user', text: '   ' }), MemoryError);
});

test('normalizeMemory rejects bad scope and traversal-shaped refId', () => {
  assert.throws(() => normalizeMemory({ scope: 'wrong', text: 'x' }), MemoryError);
  assert.throws(() => normalizeMemory({ scope: 'task', refId: '../../etc/passwd', text: 'x' }), MemoryError);
  assert.throws(() => normalizeMemory({ scope: 'task', refId: 'a/b', text: 'x' }), MemoryError);
});

test('normalizeMemory caps text length', () => {
  const record = normalizeMemory({ scope: 'workspace', text: 'y'.repeat(5000) });
  assert.equal(record.text.length, 2000);
});

test('detectMemoryScope reads explicit "<scope> memory" phrasing', () => {
  assert.equal(detectMemoryScope('search project memory for the checkout plan'), 'project');
  assert.equal(detectMemoryScope('what is in our business memory'), 'business');
  assert.equal(detectMemoryScope('show my user memory'), 'user');
  assert.equal(detectMemoryScope('list task memories'), 'task');
});

test('detectMemoryScope falls back to keyword heuristics, else all', () => {
  assert.equal(detectMemoryScope('recall our pricing decision'), 'business');
  assert.equal(detectMemoryScope('remember that I prefer dark mode'), 'user');
  assert.equal(detectMemoryScope('open the checkout ticket'), 'task');
  assert.equal(detectMemoryScope('find the thing we discussed'), 'all');
  assert.equal(detectMemoryScope(''), 'all');
});

test('detectMemoryWrite returns a scoped draft for write phrasing, null otherwise', () => {
  const a = detectMemoryWrite('remember that I prefer dark mode');
  assert.equal(a.scope, 'user');
  assert.match(a.text, /prefer dark mode/i);
  assert.ok(a.title.length > 0);

  const b = detectMemoryWrite('save to business memory: charge $9/mo with a trial');
  assert.equal(b.scope, 'business');
  assert.match(b.text, /\$9\/mo/);

  assert.equal(detectMemoryWrite('what is our current pricing?'), null);
  assert.equal(detectMemoryWrite(''), null);
});

test('searchMemories ranks by term overlap and filters by scope', () => {
  const memories = [
    { id: 'm1', scope: 'business', title: 'Pricing', text: 'Charge nine dollars monthly', tags: ['pricing'] },
    { id: 'm2', scope: 'project', title: 'Checkout', text: 'Checkout flow milestones', tags: [] },
    { id: 'm3', scope: 'business', title: 'Growth', text: 'Retention cohorts', tags: [] },
  ];
  const all = searchMemories('pricing monthly', memories, {});
  assert.equal(all[0].id, 'm1');
  assert.equal(all[0].scope, 'business');

  const scoped = searchMemories('checkout', memories, { scope: 'project' });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].id, 'm2');

  const none = searchMemories('pricing', memories, { scope: 'project' });
  assert.equal(none.length, 0);
});

test('MEMORY_SCOPES lists the five typed scopes', () => {
  assert.deepEqual([...MEMORY_SCOPES].sort(), ['business', 'project', 'task', 'user', 'workspace']);
});
