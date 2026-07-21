'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectProjectTypes,
  pickNodeManager,
  pickPythonManager,
  renderDevcontainer,
} = require('./environments');

function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-env-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content || '', 'utf8');
  }
  return dir;
}

test('detectProjectTypes recognises node, python, and compose markers', () => {
  const dir = scratch({ 'package.json': '{}', 'requirements.txt': '', 'docker-compose.yml': '' });
  try {
    const types = detectProjectTypes(dir);
    assert.equal(types.node, true);
    assert.equal(types.python, true);
    assert.equal(types.compose, true);
    assert.equal(types.go, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickNodeManager selects the manager from the lockfile', () => {
  const pnpm = scratch({ 'pnpm-lock.yaml': '' });
  const yarn = scratch({ 'yarn.lock': '' });
  const npm = scratch({ 'package-lock.json': '' });
  const bare = scratch({ 'package.json': '{}' });
  try {
    assert.equal(pickNodeManager(pnpm).manager, 'pnpm');
    assert.equal(pickNodeManager(yarn).manager, 'yarn');
    assert.deepEqual(pickNodeManager(npm), { manager: 'npm', args: ['ci'] });
    assert.deepEqual(pickNodeManager(bare), { manager: 'npm', args: ['install'] });
  } finally {
    [pnpm, yarn, npm, bare].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

test('pickPythonManager prefers lockfile managers, then uv, then venv', () => {
  const poetry = scratch({ 'poetry.lock': '' });
  const pipenv = scratch({ Pipfile: '' });
  const plain = scratch({ 'requirements.txt': '' });
  try {
    assert.equal(pickPythonManager(poetry), 'poetry');
    assert.equal(pickPythonManager(pipenv), 'pipenv');
    assert.equal(pickPythonManager(plain, { uvAvailable: true }), 'uv');
    assert.equal(pickPythonManager(plain, { uvAvailable: false }), 'venv');
  } finally {
    [poetry, pipenv, plain].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

test('renderDevcontainer emits a pinned image and a non-root remote user', () => {
  const json = JSON.parse(renderDevcontainer({ language: 'node', port: 3000 }));
  assert.match(json.image, /devcontainers\/javascript-node/);
  assert.equal(json.remoteUser, 'node');
  assert.deepEqual(json.forwardPorts, [3000]);
});
