'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildSystemsFor } = require('./build');
const { pickTestRunner } = require('./quality');

function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-build-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content || '', 'utf8');
  return dir;
}

test('buildSystemsFor detects Gradle, Go, and Cargo', () => {
  const gradle = scratch({ 'build.gradle': '' });
  const go = scratch({ 'go.mod': 'module x' });
  const cargo = scratch({ 'Cargo.toml': '' });
  try {
    assert.equal(buildSystemsFor(gradle)[0].system, 'gradle');
    assert.equal(buildSystemsFor(go)[0].system, 'go');
    assert.equal(buildSystemsFor(cargo)[0].system, 'cargo');
  } finally {
    [gradle, go, cargo].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

test('buildSystemsFor only surfaces npm when a build script exists', () => {
  const withBuild = scratch({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) });
  const withoutBuild = scratch({ 'package.json': JSON.stringify({ scripts: { start: 'node .' } }) });
  try {
    assert.ok(buildSystemsFor(withBuild).some((s) => s.system === 'npm'));
    assert.ok(!buildSystemsFor(withoutBuild).some((s) => s.system === 'npm'));
  } finally {
    [withBuild, withoutBuild].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

test('pickTestRunner prefers an npm test script, else falls back to language runners', () => {
  const npm = scratch({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
  const go = scratch({ 'go.mod': 'module x' });
  const none = scratch({ 'README.md': '' });
  try {
    assert.equal(pickTestRunner(npm).key, 'npm');
    assert.equal(pickTestRunner(go).key, 'go');
    assert.equal(pickTestRunner(none), null);
  } finally {
    [npm, go, none].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  }
});
