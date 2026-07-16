'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildAnnotations, withAnnotations } = require('./trace-annotations');

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
