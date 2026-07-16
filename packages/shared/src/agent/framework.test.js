'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildBackend, installSkills } = require('./framework');

test('installSkills refuses a symbolic-link destination without writing outside the root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-skills-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-skills-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'unchanged\n', 'utf8');
  fs.symlinkSync(outside, path.join(root, '.agent-skills'), 'dir');

  assert.throws(
    () => installSkills(root, ['software-planning']),
    /Refusing symbolic-link skill destination/
  );
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'unchanged\n');
  assert.equal(fs.existsSync(path.join(outside, 'software-planning')), false);
});

test('installSkills refuses tracked project-owned .agent-skills files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-skills-tracked-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const projectFile = path.join(root, '.agent-skills', 'software-planning', 'project.md');
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.writeFileSync(projectFile, 'project-owned\n', 'utf8');
  execFileSync('git', ['add', '.agent-skills/software-planning/project.md'], { cwd: root });

  assert.throws(
    () => installSkills(root, ['software-planning']),
    /tracked project files/
  );
  assert.equal(fs.readFileSync(projectFile, 'utf8'), 'project-owned\n');
  assert.equal(fs.existsSync(path.join(root, '.agent-skills', '.tech-symphony-managed')), false);
});

test('installSkills refuses an unclaimed project-owned destination', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-skills-owned-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectFile = path.join(root, '.agent-skills', 'notes.txt');
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.writeFileSync(projectFile, 'project-owned\n', 'utf8');

  assert.throws(
    () => installSkills(root, ['software-planning']),
    /project-owned skill directory/
  );
  assert.equal(fs.readFileSync(projectFile, 'utf8'), 'project-owned\n');
});

test('installSkills can refresh a framework-owned skill directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-skills-managed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = installSkills(root, ['software-planning']);
  const second = installSkills(root, ['software-planning']);

  assert.deepEqual(first, ['/.agent-skills/software-planning/']);
  assert.deepEqual(second, first);
  assert.equal(fs.readFileSync(path.join(root, '.agent-skills', '.tech-symphony-managed'), 'utf8'), 'tech-symphony-agent-skills-v1\n');
  assert.equal(fs.existsSync(path.join(root, '.agent-skills', 'software-planning', 'SKILL.md')), true);
});

test('LocalShellBackend receives only the sanitized allowlisted environment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-shell-env-'));
  const backend = buildBackend('shell', root, {
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      LANG: 'C',
      GH_TOKEN: 'should-not-appear',
      GITLAB_TOKEN: 'should-not-appear',
      TECHSYMPHONY_BROKER_GIT_TOKEN: 'should-not-appear',
      UNRELATED_SECRET: 'should-not-appear',
    },
  });
  try {
    const result = await backend.execute('env');
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /GIT_TERMINAL_PROMPT=0/);
    assert.doesNotMatch(result.output, /GH_TOKEN=|GITLAB_TOKEN=|TECHSYMPHONY_BROKER_GIT_TOKEN=|UNRELATED_SECRET=/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
