'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  renderDockerfile,
  renderDockerignore,
  assertImage,
  assertSafeVolume,
  buildArgPairs,
  portArgs,
} = require('./docker');
const { FACTORIES } = require('./docker');

test('renderDockerfile produces a hardened image for every preset', () => {
  for (const language of ['node', 'python', 'go', 'java', 'generic']) {
    const df = renderDockerfile({ language });
    assert.match(df, /^FROM /m, `${language} has FROM`);
    assert.doesNotMatch(df, /FROM \S+:latest/, `${language} does not use :latest`);
    assert.match(df, /USER /, `${language} sets a non-root USER`);
  }
});

test('renderDockerignore excludes secrets and VCS metadata', () => {
  const ignore = renderDockerignore();
  for (const entry of ['.git', '.env', '*.pem', '*.key', '.ssh', 'node_modules']) {
    assert.ok(ignore.split('\n').includes(entry), `ignores ${entry}`);
  }
});

test('assertImage accepts valid refs and rejects flag-like input', () => {
  assert.equal(assertImage('myapp:1.2.3'), 'myapp:1.2.3');
  assert.equal(assertImage('ghcr.io/org/app@sha256:abc'), 'ghcr.io/org/app@sha256:abc');
  assert.throws(() => assertImage('--privileged'), /invalid image/);
  assert.throws(() => assertImage('a b'), /invalid image/);
});

test('assertSafeVolume refuses the Docker socket and host escapes', () => {
  const base = '/work/space';
  assert.equal(assertSafeVolume('data:/data', base), 'data:/data');
  assert.equal(assertSafeVolume('/work/space/sub:/app', base), '/work/space/sub:/app');
  assert.throws(() => assertSafeVolume('/var/run/docker.sock:/var/run/docker.sock', base), /Docker socket/);
  assert.throws(() => assertSafeVolume('/etc:/etc', base), /outside the workspace/);
});

test('buildArgPairs refuses secret-looking build args', () => {
  assert.deepEqual(buildArgPairs({ NODE_ENV: 'production' }), ['--build-arg', 'NODE_ENV=production']);
  assert.throws(() => buildArgPairs({ NPM_TOKEN: 'x' }), /secret-looking build-arg/);
  assert.throws(() => buildArgPairs({ AWS_SECRET_ACCESS_KEY: 'x' }), /secret-looking build-arg/);
});

test('portArgs validates port mappings', () => {
  assert.deepEqual(portArgs(['8080:80', '443']), ['-p', '8080:80', '-p', '443']);
  assert.throws(() => portArgs(['8080; rm -rf /']), /invalid port/);
});

test('dockerfile_generate writes a Dockerfile and .dockerignore into the workspace', async () => {
  // Arrange
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-docker-'));
  try {
    const tool = FACTORIES.dockerfile_generate({ cwd: dir, step: () => {} });

    // Act
    const out = await tool.invoke({ language: 'node' });

    // Assert
    assert.match(out, /Wrote hardened Dockerfile/);
    assert.ok(fs.existsSync(path.join(dir, 'Dockerfile')));
    assert.ok(fs.existsSync(path.join(dir, '.dockerignore')));
    assert.match(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8'), /USER node/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dockerfile_generate refuses to write outside the workspace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-docker-esc-'));
  try {
    const tool = FACTORIES.dockerfile_generate({ cwd: dir, step: () => {} });
    const out = await tool.invoke({ language: 'node', dir: '../../etc' });
    assert.match(out, /failed: .*outside the workspace/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
