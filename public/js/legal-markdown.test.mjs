import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  normalizeLegalLink,
  parseLegalMarkdown,
  renderLegalMarkdown,
} from './legal-markdown.mjs';

class FakeNode {
  constructor(tagName, nodeType = 1) {
    this.tagName = tagName;
    this.nodeType = nodeType;
    this.children = [];
    this.attributes = {};
  }

  append(...children) {
    this.children.push(...children);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}

class FakeTextNode extends FakeNode {
  constructor(value) {
    super('#text', 3);
    this.value = value;
  }
}

const fakeDocument = {
  createDocumentFragment: () => new FakeNode('#fragment', 11),
  createElement: (tagName) => new FakeNode(tagName.toUpperCase()),
  createTextNode: (value) => new FakeTextNode(String(value)),
};

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

function textOf(node) {
  if (node.nodeType === 3) return node.value;
  return node.children.map(textOf).join('');
}

test('parses the restricted legal Markdown block and inline vocabulary', () => {
  const blocks = parseLegalMarkdown(`# Notice

Paragraph with **important**, *emphasized*, and \`literal\` text.

> A quoted **warning**.

3. First item
   continued here
4. Second item

- One bullet
- Another bullet

---`);

  assert.deepEqual(blocks.map((block) => block.type), [
    'heading',
    'paragraph',
    'blockquote',
    'list',
    'list',
    'thematicBreak',
  ]);
  assert.equal(blocks[0].level, 1);
  assert.deepEqual(blocks[1].children.map((token) => token.type), [
    'text', 'strong', 'text', 'emphasis', 'text', 'code', 'text',
  ]);
  assert.equal(blocks[2].children[0].type, 'paragraph');
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[3].start, 3);
  assert.equal(blocks[3].items.length, 2);
  assert.equal(blocks[4].ordered, false);
});

test('accepts navigational URLs and rejects executable or ambiguous destinations', () => {
  for (const href of [
    'https://example.com/privacy',
    'http://localhost:8080/legal',
    'mailto:privacy@example.com',
    '#/terms',
    '/legal/terms.md',
    './terms.md',
    '../EULA.md',
  ]) {
    assert.equal(normalizeLegalLink(href), href);
  }

  for (const href of [
    '',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//example.com/ambiguous',
    'example.com/no-scheme',
    'https://example.com/line\nbreak',
  ]) {
    assert.equal(normalizeLegalLink(href), '');
  }
});

test('renders semantic nodes while leaving raw markup inert and unsafe links unlinked', () => {
  const fragment = renderLegalMarkdown(`# Safe document

Text with **strong**, *emphasis*, \`code\`, [safe](https://example.com), and [unsafe](javascript:alert(1)).

> Quoted text

1. Ordered

- Unordered

---

<script>globalThis.compromised = true</script>`, { documentRef: fakeDocument });

  const nodes = descendants(fragment);
  const tags = nodes.map((node) => node.tagName);
  for (const expected of ['H1', 'P', 'STRONG', 'EM', 'CODE', 'A', 'BLOCKQUOTE', 'OL', 'UL', 'LI', 'HR']) {
    assert.ok(tags.includes(expected), `missing semantic ${expected} node`);
  }
  assert.equal(tags.includes('SCRIPT'), false);
  assert.match(textOf(fragment), /<script>globalThis\.compromised = true<\/script>/);

  const anchors = nodes.filter((node) => node.tagName === 'A');
  assert.equal(anchors.length, 1);
  assert.deepEqual(anchors[0].attributes, {
    href: 'https://example.com',
    target: '_blank',
    rel: 'noopener noreferrer',
  });
  assert.match(textOf(fragment), /unsafe/);
});

test('renderer source contains no HTML string insertion sink', () => {
  const source = readFileSync(new URL('./legal-markdown.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.\s*innerHTML\b/u);
  assert.doesNotMatch(source, /insertAdjacentHTML/u);
  assert.doesNotMatch(source, /document\.write/u);
});

// The privacy notice states its data-per-purpose mapping as a table, which is the
// one place in the documents that needs one. Both renderers — this browser one and
// scripts/build-legal-pages.js — must agree, or the signed-in view shows raw pipes
// where the static crawler-facing page shows a table.
test('renders a pipe table into thead and tbody cells', () => {
  const source = readFileSync(new URL('../../public/legal/privacy.md', import.meta.url), 'utf8');
  const blocks = parseLegalMarkdown(source);
  const tables = blocks.filter((block) => block.type === 'table');
  assert.equal(tables.length, 1, 'the privacy notice must carry exactly one table');
  assert.equal(tables[0].head.length, 2, 'the data/purpose table has two columns');
  assert.ok(tables[0].rows.length >= 8, 'every data category must be itemised, not summarised');
  assert.ok(
    tables[0].rows.every((row) => row.length === 2),
    'each row must pair personal data with its purpose',
  );

  const fragment = renderLegalMarkdown('| a | b |\n| --- | --- |\n| <x> | **y** |\n', { documentRef: fakeDocument });
  const table = fragment.children[0];
  assert.equal(table.tagName, 'TABLE');
  const [head, body] = table.children;
  assert.deepEqual(head.children[0].children.map((cell) => cell.tagName), ['TH', 'TH']);
  const cells = body.children[0].children;
  assert.deepEqual(cells.map((cell) => cell.tagName), ['TD', 'TD']);
  assert.equal(cells[0].children[0].value, '<x>', 'markup in a cell stays text');
  assert.equal(cells[1].children[0].tagName, 'STRONG');
});

test('a pipe line without a divider row stays a paragraph', () => {
  const blocks = parseLegalMarkdown('one | two\nthree | four\n');
  assert.deepEqual(blocks.map((block) => block.type), ['paragraph']);
});
