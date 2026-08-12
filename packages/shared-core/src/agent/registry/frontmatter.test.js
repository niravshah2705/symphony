'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter, skillFields, toToolList } = require('./frontmatter');

const CLAUDE_SKILL = `---
name: research
user-invocable: true
allowed-tools: Bash, Read
description: Conduct preliminary research on a topic.
---

# research

Body text here.
`;

const CODEX_SKILL = `---
name: skill-creator
description: Create a new skill.
metadata:
  short-description: make skills
---
Body.
`;

const INLINE_ARRAY = `---
name: x
allowed-tools: [Read, "Web Search", Grep]
argument-hint: <topic>
---
`;

test('parses Claude-style front-matter and body', () => {
  const { data, body } = parseFrontmatter(CLAUDE_SKILL);
  assert.equal(data.name, 'research');
  assert.equal(data['user-invocable'], true);
  assert.equal(data.description, 'Conduct preliminary research on a topic.');
  assert.match(body, /# research/);
});

test('skillFields normalizes tools and nested Codex metadata', () => {
  const claude = skillFields(parseFrontmatter(CLAUDE_SKILL).data);
  assert.equal(claude.name, 'research');
  assert.equal(claude.userInvocable, true);
  assert.deepEqual(claude.allowedTools, ['Bash', 'Read']);
  assert.equal(claude.shortDescription, null);

  const codex = skillFields(parseFrontmatter(CODEX_SKILL).data);
  assert.equal(codex.name, 'skill-creator');
  assert.equal(codex.shortDescription, 'make skills');
  assert.equal(codex.userInvocable, null);
});

test('parses inline flow arrays with quoted entries', () => {
  const { data } = parseFrontmatter(INLINE_ARRAY);
  assert.deepEqual(data['allowed-tools'], ['Read', 'Web Search', 'Grep']);
  assert.equal(data['argument-hint'], '<topic>');
});

test('toToolList accepts string, comma-list and array', () => {
  assert.deepEqual(toToolList('Bash, Read'), ['Bash', 'Read']);
  assert.deepEqual(toToolList(['Bash', 'Read']), ['Bash', 'Read']);
  assert.deepEqual(toToolList(''), []);
  assert.deepEqual(toToolList(null), []);
});

test('returns empty data when there is no front-matter', () => {
  const { data, body } = parseFrontmatter('# just markdown\n');
  assert.deepEqual(data, {});
  assert.equal(body, '# just markdown\n');
});

test('strips unquoted trailing comments but keeps # inside quotes', () => {
  const { data } = parseFrontmatter('---\nname: x  # a comment\ndescription: "a # b"\n---\n');
  assert.equal(data.name, 'x');
  assert.equal(data.description, 'a # b');
});
