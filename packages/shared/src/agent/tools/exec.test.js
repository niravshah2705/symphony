'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  sanitizedToolEnv,
  redactSecrets,
  truncate,
  resolveWorkdir,
  runCommand,
  commandExists,
  runSequence,
} = require('./exec');

test('sanitizedToolEnv strips credential-looking variables but keeps toolchain vars', () => {
  // Arrange
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    ANDROID_HOME: '/opt/android',
    GH_TOKEN: 'ghp_deadbeefdeadbeefdeadbeef',
    MY_SECRET: 'shhh-super-secret',
    DB_PASSWORD: 'hunter2hunter2',
    OPENAI_API_KEY: 'sk-abc123abc123abc123',
  };

  // Act
  const { env, secrets } = sanitizedToolEnv(base);

  // Assert
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/dev');
  assert.equal(env.ANDROID_HOME, '/opt/android');
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.MY_SECRET, undefined);
  assert.equal(env.DB_PASSWORD, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0'); // non-interactive flag forced on
  assert.ok(secrets.includes('ghp_deadbeefdeadbeefdeadbeef'));
  assert.ok(secrets.includes('hunter2hunter2'));
});

test('redactSecrets blanks known secret values and common token patterns', () => {
  // Arrange
  const secret = 'my-literal-token-value';
  const text = `using ${secret}\nAuthorization: Bearer abcdef1234567890\ntoken ghp_0123456789abcdef0123`;

  // Act
  const out = redactSecrets(text, [secret]);

  // Assert
  assert.doesNotMatch(out, /my-literal-token-value/);
  assert.doesNotMatch(out, /ghp_0123456789abcdef0123/);
  assert.match(out, /«redacted»/);
});

test('truncate keeps head and tail with a marker when over the limit', () => {
  // Arrange
  const text = 'x'.repeat(1000);

  // Act
  const out = truncate(text, 100);

  // Assert
  assert.ok(out.length < text.length);
  assert.match(out, /\[truncated \d+ chars\]/);
});

test('resolveWorkdir confines to the workspace and refuses traversal', () => {
  // Arrange
  const ctx = { cwd: '/work/space' };

  // Act + Assert
  assert.equal(resolveWorkdir(ctx), path.resolve('/work/space'));
  assert.equal(resolveWorkdir(ctx, 'sub/dir'), path.resolve('/work/space/sub/dir'));
  assert.throws(() => resolveWorkdir(ctx, '../escape'), /outside the workspace/);
  assert.throws(() => resolveWorkdir(ctx, '/etc/passwd'), /outside the workspace/);
});

test('runCommand rejects non-array / non-string args (no shell interpolation surface)', async () => {
  await assert.rejects(() => runCommand('node', 'not-an-array'), /array of strings/);
  await assert.rejects(() => runCommand('node', ['ok', 'bad\0null']), /null bytes/);
});

test('runCommand reports a missing binary as notFound rather than throwing', async () => {
  // Act
  const result = await runCommand('definitely-not-a-real-binary-xyz', ['--version']);

  // Assert
  assert.equal(result.ok, false);
  assert.equal(result.notFound, true);
});

test('runCommand captures a non-zero exit code without throwing', async () => {
  // Act
  const result = await runCommand(process.execPath, ['-e', 'process.exit(3)']);

  // Assert
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.equal(result.notFound, false);
});

test('commandExists is true for node and false for a missing binary', async () => {
  assert.equal(await commandExists(process.execPath), true);
  assert.equal(await commandExists('definitely-not-a-real-binary-xyz'), false);
});

test('runSequence stops at the first failing step', async () => {
  // Arrange
  const steps = [
    { label: 'ok', command: process.execPath, args: ['-e', 'console.log("first")'] },
    { label: 'boom', command: process.execPath, args: ['-e', 'process.exit(2)'] },
    { label: 'never', command: process.execPath, args: ['-e', 'console.log("third")'] },
  ];

  // Act
  const { ok, output } = await runSequence({ ctx: { cwd: process.cwd() }, steps });

  // Assert
  assert.equal(ok, false);
  assert.match(output, /first/);
  assert.doesNotMatch(output, /third/);
});
