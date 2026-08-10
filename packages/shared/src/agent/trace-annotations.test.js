'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  buildAnnotations,
  withAnnotations,
  cleanList,
  buildResourceAnnotations,
  withResources,
} = require('./trace-annotations');

test('buildAnnotations stamps all three business fields into metadata and tags', () => {
  // Arrange
  const business = { project: 'OTA', taskId: 'ENG-123', session: 'run-abc' };

  // Act
  const { metadata, tags } = buildAnnotations(business);

  // Assert
  assert.deepStrictEqual(metadata, {
    project: 'OTA',
    'task-id': 'ENG-123',
    session: 'run-abc',
    session_id: 'run-abc', // LangSmith Threads grouping key mirrors session
  });
  assert.deepStrictEqual(tags, ['project:OTA', 'task:ENG-123', 'session:run-abc']);
});

test('buildAnnotations omits blank, null, and undefined fields', () => {
  // Arrange / Act
  const { metadata, tags } = buildAnnotations({ project: '  ', taskId: null, session: undefined });

  // Assert
  assert.deepStrictEqual(metadata, {});
  assert.deepStrictEqual(tags, []);
});

test('buildAnnotations trims surrounding whitespace on values', () => {
  const { metadata, tags } = buildAnnotations({ project: '  OTA  ', taskId: ' ENG-1 ' });
  assert.strictEqual(metadata.project, 'OTA');
  assert.strictEqual(metadata['task-id'], 'ENG-1');
  assert.deepStrictEqual(tags, ['project:OTA', 'task:ENG-1']);
});

test('buildAnnotations tolerates no argument', () => {
  const { metadata, tags } = buildAnnotations();
  assert.deepStrictEqual(metadata, {});
  assert.deepStrictEqual(tags, []);
});

test('withAnnotations preserves existing metadata and tags while merging', () => {
  // Arrange
  const config = {
    runId: 'r1',
    recursionLimit: 24,
    tags: ['enrich', 'linear-manager'],
    metadata: { projectId: 'p1', assumedRole: null },
  };

  // Act
  const merged = withAnnotations(config, { project: 'OTA', taskId: 'ENG-9', session: 'r1' });

  // Assert
  assert.strictEqual(merged.runId, 'r1');
  assert.strictEqual(merged.recursionLimit, 24);
  assert.deepStrictEqual(merged.metadata, {
    projectId: 'p1',
    assumedRole: null,
    project: 'OTA',
    'task-id': 'ENG-9',
    session: 'r1',
    session_id: 'r1',
  });
  assert.deepStrictEqual(merged.tags, [
    'enrich',
    'linear-manager',
    'project:OTA',
    'task:ENG-9',
    'session:r1',
  ]);
});

test('withAnnotations does not mutate the input config', () => {
  // Arrange
  const config = { tags: ['enrich'], metadata: { projectId: 'p1' } };
  const originalTags = [...config.tags];
  const originalMeta = { ...config.metadata };

  // Act
  withAnnotations(config, { project: 'OTA', session: 'r1' });

  // Assert — input untouched (immutability rule)
  assert.deepStrictEqual(config.tags, originalTags);
  assert.deepStrictEqual(config.metadata, originalMeta);
});

test('withAnnotations de-duplicates tags that already exist', () => {
  const config = { tags: ['project:OTA'] };
  const merged = withAnnotations(config, { project: 'OTA', session: 'r1' });
  assert.deepStrictEqual(merged.tags, ['project:OTA', 'session:r1']);
});

test('withAnnotations works with an empty config and empty business', () => {
  const merged = withAnnotations();
  assert.deepStrictEqual(merged.metadata, {});
  assert.deepStrictEqual(merged.tags, []);
});

// ---------------------------------------------------------------------------
// Resource annotations (skills / tools / plugins)
// ---------------------------------------------------------------------------

test('cleanList accepts an array and returns trimmed, de-duplicated names', () => {
  assert.deepStrictEqual(cleanList([' commit ', 'commit', 'push', '', null]), ['commit', 'push']);
});

test('cleanList accepts a comma-separated string', () => {
  assert.deepStrictEqual(cleanList('commit, push ,commit'), ['commit', 'push']);
});

test('cleanList returns [] for null/undefined/blank', () => {
  assert.deepStrictEqual(cleanList(null), []);
  assert.deepStrictEqual(cleanList(undefined), []);
  assert.deepStrictEqual(cleanList('   '), []);
  assert.deepStrictEqual(cleanList([]), []);
});

test('cleanList caps the number of items and per-name length', () => {
  const many = Array.from({ length: 10 }, (_, i) => `tool-${i}`);
  assert.deepStrictEqual(cleanList(many, { maxItems: 3 }), ['tool-0', 'tool-1', 'tool-2']);
  assert.strictEqual(cleanList(['abcdefghij'], { maxLen: 4 })[0], 'abcd');
});

test('buildResourceAnnotations stamps arrays, counts, and flat tags', () => {
  // Arrange
  const resources = {
    skills: ['linear', 'commit'],
    tools: ['linear_graphql', 'docker_build'],
    plugins: ['linear', 'playwright'],
  };

  // Act
  const { metadata, tags } = buildResourceAnnotations(resources);

  // Assert
  assert.deepStrictEqual(metadata, {
    skills: ['linear', 'commit'],
    skills_count: 2,
    tools: ['linear_graphql', 'docker_build'],
    tools_count: 2,
    plugins: ['linear', 'playwright'],
    plugins_count: 2,
  });
  assert.deepStrictEqual(tags, [
    'skill:linear',
    'skill:commit',
    'tool:linear_graphql',
    'tool:docker_build',
    'plugin:linear',
    'plugin:playwright',
  ]);
});

test('buildResourceAnnotations omits empty categories and tolerates no argument', () => {
  const { metadata, tags } = buildResourceAnnotations({ tools: ['web_search'], skills: [] });
  assert.deepStrictEqual(metadata, { tools: ['web_search'], tools_count: 1 });
  assert.deepStrictEqual(tags, ['tool:web_search']);

  const empty = buildResourceAnnotations();
  assert.deepStrictEqual(empty.metadata, {});
  assert.deepStrictEqual(empty.tags, []);
});

test('withResources merges into existing config without mutating it', () => {
  // Arrange
  const config = {
    runId: 'r1',
    tags: ['enrich', 'project:OTA'],
    metadata: { project: 'OTA' },
  };
  const originalTags = [...config.tags];
  const originalMeta = { ...config.metadata };

  // Act
  const merged = withResources(config, { skills: ['commit'], tools: ['docker_build'] });

  // Assert — merged output
  assert.strictEqual(merged.runId, 'r1');
  assert.deepStrictEqual(merged.metadata, {
    project: 'OTA',
    skills: ['commit'],
    skills_count: 1,
    tools: ['docker_build'],
    tools_count: 1,
  });
  assert.deepStrictEqual(merged.tags, ['enrich', 'project:OTA', 'skill:commit', 'tool:docker_build']);

  // Assert — input untouched (immutability rule)
  assert.deepStrictEqual(config.tags, originalTags);
  assert.deepStrictEqual(config.metadata, originalMeta);
});

test('withResources de-duplicates tags and works with empty inputs', () => {
  const merged = withResources({ tags: ['tool:web_search'] }, { tools: ['web_search'] });
  assert.deepStrictEqual(merged.tags, ['tool:web_search']);

  const empty = withResources();
  assert.deepStrictEqual(empty.metadata, {});
  assert.deepStrictEqual(empty.tags, []);
});
