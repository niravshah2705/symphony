'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const disk = require('./disk-backend');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-disk-'));
}

function record(overrides = {}) {
  return {
    id: 'mem_1',
    scope: 'project',
    title: 'Alpha',
    text: 'The API base URL is configured per org.',
    tags: ['api'],
    source: 'agent',
    createdAt: '2026-09-03T10:00:00.000Z',
    embedding: [0.1, 0.2, 0.3, 0.4],
    ...overrides,
  };
}

test('writeMemory persists a .md + .f32 pair that listMemories/readVector round-trip', () => {
  const src = tmpRoot();
  const out = disk.writeMemory(record(), { src, context: { organizationId: 'orgA' } });
  assert.ok(out && out.path.endsWith('.md'));
  assert.ok(fs.existsSync(out.path.replace(/\.md$/, '.f32')), 'sibling vector written');

  const list = disk.listMemories({ src, context: { organizationId: 'orgA' } });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'mem_1');
  assert.equal(list[0].scope, 'project');
  assert.equal(list[0].title, 'Alpha');
  assert.match(list[0].text, /API base URL/);

  const vec = disk.readVector(list[0].path);
  assert.equal(vec.length, 4);
  assert.ok(Math.abs(vec[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(vec[3] - 0.4) < 1e-6);
});

test('tenant isolation — org B never sees org A memories on a shared root', () => {
  const src = tmpRoot();
  disk.writeMemory(record({ id: 'mem_a' }), { src, context: { organizationId: 'orgA' } });
  disk.writeMemory(record({ id: 'mem_b' }), { src, context: { organizationId: 'orgB' } });
  const a = disk.listMemories({ src, context: { organizationId: 'orgA' } });
  const b = disk.listMemories({ src, context: { organizationId: 'orgB' } });
  assert.deepEqual(a.map((m) => m.id), ['mem_a']);
  assert.deepEqual(b.map((m) => m.id), ['mem_b']);
});

test('scope filter and newest-first ordering', () => {
  const src = tmpRoot();
  const ctx = { organizationId: 'orgA' };
  disk.writeMemory(record({ id: 'p1', scope: 'project', createdAt: '2026-09-03T10:00:00.000Z' }), { src, context: ctx });
  disk.writeMemory(record({ id: 'p2', scope: 'project', createdAt: '2026-09-03T11:00:00.000Z' }), { src, context: ctx });
  disk.writeMemory(record({ id: 't1', scope: 'task', createdAt: '2026-09-03T10:30:00.000Z' }), { src, context: ctx });

  const project = disk.listMemories({ src, context: ctx, scope: 'project' });
  assert.deepEqual(project.map((m) => m.id), ['p2', 'p1'], 'newest first, project only');
  const all = disk.listMemories({ src, context: ctx });
  assert.equal(all.length, 3);
});

test('unknown scope and disabled src are safe no-ops', () => {
  const src = tmpRoot();
  assert.equal(disk.writeMemory(record({ scope: 'bogus' }), { src, context: {} }), null);
  assert.equal(disk.writeMemory(record(), { src: null }), null);
  assert.deepEqual(disk.listMemories({ src: null }), []);
  assert.deepEqual(disk.listMemories({ src: path.join(src, 'does-not-exist') }), []);
});

test('a memory without an embedding still persists and reads back (vector null)', () => {
  const src = tmpRoot();
  const out = disk.writeMemory(record({ embedding: null }), { src, context: { organizationId: 'orgA' } });
  assert.ok(out);
  assert.equal(disk.readVector(out.path), null);
  assert.equal(disk.listMemories({ src, context: { organizationId: 'orgA' } }).length, 1);
});
