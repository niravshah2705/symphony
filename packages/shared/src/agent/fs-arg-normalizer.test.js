'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeFsToolArgs,
  createFsArgNormalizerMiddleware,
  FILE_PATH_TOOLS,
} = require('./fs-arg-normalizer');

test('remaps `path` to `file_path` for read_file (the observed failure)', () => {
  // Arrange
  const args = { path: '/repo/.agent-skills/linear/SKILL.md', limit: 200 };
  // Act
  const fixed = normalizeFsToolArgs('read_file', args);
  // Assert
  assert.deepStrictEqual(fixed, { limit: 200, file_path: '/repo/.agent-skills/linear/SKILL.md' });
  assert.ok(!('path' in fixed), 'the mis-keyed alias is removed');
});

test('remaps aliases for write_file and edit_file too', () => {
  assert.strictEqual(
    normalizeFsToolArgs('write_file', { filepath: '/a.txt', content: 'x' }).file_path,
    '/a.txt'
  );
  assert.strictEqual(
    normalizeFsToolArgs('edit_file', { file: '/b.txt', old_string: 'a', new_string: 'b' }).file_path,
    '/b.txt'
  );
});

test('honors alias priority: prefers `path` over lower-priority keys', () => {
  const fixed = normalizeFsToolArgs('read_file', { path: '/win.txt', filename: '/lose.txt' });
  assert.strictEqual(fixed.file_path, '/win.txt');
});

test('leaves a correct call untouched (same reference, no rewrite)', () => {
  const args = { file_path: '/repo/x.js', path: '/ignored' };
  assert.strictEqual(normalizeFsToolArgs('read_file', args), args);
});

test('does not rewrite glob/grep, which legitimately use `path`', () => {
  const glob = { pattern: '*.ts', path: '/src' };
  assert.strictEqual(normalizeFsToolArgs('glob', glob), glob);
  const grep = { pattern: 'TODO', path: '/src' };
  assert.strictEqual(normalizeFsToolArgs('grep', grep), grep);
});

test('is a no-op when no alias is present or args are malformed', () => {
  const noAlias = { offset: 0, limit: 100 };
  assert.strictEqual(normalizeFsToolArgs('read_file', noAlias), noAlias);
  assert.strictEqual(normalizeFsToolArgs('read_file', null), null);
  assert.strictEqual(normalizeFsToolArgs('read_file', undefined), undefined);
  // Empty-string alias is not usable and must not overwrite file_path.
  const empty = { path: '' };
  assert.strictEqual(normalizeFsToolArgs('read_file', empty), empty);
});

test('unknown tool names pass through unchanged', () => {
  const args = { path: '/x' };
  assert.strictEqual(normalizeFsToolArgs('web_search', args), args);
});

test('FILE_PATH_TOOLS covers exactly the file_path-taking deepagents tools', () => {
  assert.deepStrictEqual([...FILE_PATH_TOOLS].sort(), ['edit_file', 'read_file', 'write_file']);
});

test('middleware repairs the tool call it forwards to the handler', async () => {
  // Arrange
  const middleware = createFsArgNormalizerMiddleware();
  assert.strictEqual(middleware.name, 'FsArgNormalizer');
  assert.strictEqual(typeof middleware.wrapToolCall, 'function');
  let forwarded = null;
  const handler = (req) => {
    forwarded = req;
    return { ok: true };
  };
  const request = { toolCall: { name: 'read_file', id: 'call_1', args: { path: '/p.md' } }, tool: {} };

  // Act
  const result = await middleware.wrapToolCall(request, handler);

  // Assert
  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(forwarded.toolCall.args.file_path, '/p.md');
  assert.ok(!('path' in forwarded.toolCall.args));
  assert.strictEqual(forwarded.toolCall.id, 'call_1', 'other tool-call fields are preserved');
  // The original request object is not mutated.
  assert.strictEqual(request.toolCall.args.path, '/p.md');
});

test('middleware forwards a correct call without cloning the request', async () => {
  const middleware = createFsArgNormalizerMiddleware();
  let forwarded = null;
  const handler = (req) => {
    forwarded = req;
    return 'done';
  };
  const request = { toolCall: { name: 'read_file', args: { file_path: '/ok.md' } } };
  const result = await middleware.wrapToolCall(request, handler);
  assert.strictEqual(result, 'done');
  assert.strictEqual(forwarded, request, 'unchanged calls are passed through as-is');
});
