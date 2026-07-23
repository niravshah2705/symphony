'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { searchDocuments, normalizeQuery } = require('./knowledge-search');

test('workspace document search returns bounded titled snippets and relative paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'README.md'), '# Product guide\n\nThe scheduler runs project planning work.\n');
  fs.writeFileSync(path.join(root, 'docs', 'memory.md'), '# Business memory\n\nRevenue decisions and customer assumptions are recorded here.\n');
  fs.writeFileSync(path.join(root, 'secret.json'), '{"token":"not-indexed"}');

  const result = searchDocuments('find revenue decisions in memory', { root });
  assert.equal(result.indexedFiles, 2);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Business memory');
  assert.equal(result.results[0].path, 'docs/memory.md');
  assert.match(result.results[0].snippet, /Revenue decisions/);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(JSON.stringify(result).includes('not-indexed'), false);
});

test('document query validation rejects empty and oversized input', () => {
  assert.throws(() => normalizeQuery('  '), /Describe what/);
  assert.throws(() => normalizeQuery('x'.repeat(8_001)), /8,000/);
});
