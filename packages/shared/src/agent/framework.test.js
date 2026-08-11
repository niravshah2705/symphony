'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildBackend, installSkills, configuredResourceNames } = require('./framework');
const { resolveSkillsSrc } = require('../config');

// The vendored default skills live next to config.js, which now resides in
// @ai-fleet/shared-core (the split that keeps the agent SDKs out of the
// non-agent images). Derive the expected path from where config actually
// resolves so this test stays correct regardless of the package layout.
const VENDORED_SKILLS = path.join(
  path.dirname(require.resolve('@ai-fleet/shared-core/config')),
  'agent',
  'skills',
);

// Snapshot + restore the skills env so a test that pins SKILLS_ROOT/SKILLS_VERSION
// never leaks the versioned mount into the vendored-default tests (they run in
// the same process). Returns a restore fn to register with t.after.
function withSkillsEnv(overrides) {
  const saved = { SKILLS_ROOT: process.env.SKILLS_ROOT, SKILLS_VERSION: process.env.SKILLS_VERSION };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const key of ['SKILLS_ROOT', 'SKILLS_VERSION']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

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

test('installSkills reads the vendored default skills when SKILLS_ROOT is unset (backward-compat)', (t) => {
  const restore = withSkillsEnv({ SKILLS_ROOT: undefined, SKILLS_VERSION: undefined });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-skills-default-'));
  t.after(() => {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // resolveSkillsSrc falls back to the vendored skills in @ai-fleet/shared-core.
  assert.equal(resolveSkillsSrc(), VENDORED_SKILLS);

  const paths = installSkills(root, ['software-planning']);
  assert.deepEqual(paths, ['/.agent-skills/software-planning/']);
  assert.equal(fs.existsSync(path.join(root, '.agent-skills', 'software-planning', 'SKILL.md')), true);
});

test('installSkills honors SKILLS_ROOT + SKILLS_VERSION and installs from the pinned bundle', (t) => {
  // A versioned bundle laid out like the gcsfuse mount: <root>/<version>/<skill>/SKILL.md.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-skills-src-'));
  const bundleSkill = path.join(src, 'v9', 'demo-skill');
  fs.mkdirSync(bundleSkill, { recursive: true });
  fs.writeFileSync(path.join(bundleSkill, 'SKILL.md'), '# demo-skill v9\n', 'utf8');

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-skills-dest-'));
  const restore = withSkillsEnv({ SKILLS_ROOT: src, SKILLS_VERSION: 'v9' });
  t.after(() => {
    restore();
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  });

  assert.equal(resolveSkillsSrc(), path.join(src, 'v9'));

  const paths = installSkills(dest, ['demo-skill']);
  assert.deepEqual(paths, ['/.agent-skills/demo-skill/']);
  assert.equal(fs.readFileSync(path.join(dest, '.agent-skills', 'demo-skill', 'SKILL.md'), 'utf8'), '# demo-skill v9\n');

  // The vendored skills are NOT reachable from the pinned bundle: an unknown name
  // there is skipped rather than pulled from the default dir.
  const only = installSkills(dest, ['software-planning']);
  assert.deepEqual(only, []);
  assert.equal(fs.existsSync(path.join(dest, '.agent-skills', 'software-planning')), false);
});

test('resolveSkillsSrc pins the mount root directly when SKILLS_VERSION is unset', () => {
  assert.equal(resolveSkillsSrc({ SKILLS_ROOT: '/skills' }), path.join('/skills'));
  assert.equal(resolveSkillsSrc({ SKILLS_ROOT: '/skills', SKILLS_VERSION: 'v2' }), path.join('/skills', 'v2'));
  assert.equal(resolveSkillsSrc({}), VENDORED_SKILLS);
});

test('resolveSkillsSrc rejects a SKILLS_VERSION that is not a single safe path segment', () => {
  assert.throws(() => resolveSkillsSrc({ SKILLS_ROOT: '/skills', SKILLS_VERSION: '../etc' }), /single path segment/);
  assert.throws(() => resolveSkillsSrc({ SKILLS_ROOT: '/skills', SKILLS_VERSION: 'a/b' }), /single path segment/);
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

// ---------------------------------------------------------------------------
// configuredResourceNames (trace metadata: available skills/tools/plugins)
// ---------------------------------------------------------------------------

test('configuredResourceNames prefers a deepagent build’s resolved set', () => {
  const workflow = { skills: ['ignored'], tools: ['ignored'], mcp: ['linear', 'playwright'] };
  const resources = configuredResourceNames({
    workflow,
    effective: null,
    resolvedTools: [{ name: 'linear_graphql' }, { name: 'docker_build' }, {}],
    resolvedSkills: ['/.agent-skills/commit/', '/.agent-skills/push/'],
  });
  assert.deepEqual(resources, {
    skills: ['commit', 'push'],
    tools: ['linear_graphql', 'docker_build'],
    plugins: ['linear', 'playwright'],
  });
});

test('configuredResourceNames falls back to the workflow declaration when no build', () => {
  const workflow = { skills: ['software-planning', 'web-research'], tools: ['web_search'], mcp: [] };
  const resources = configuredResourceNames({ workflow, effective: null, resolvedTools: null, resolvedSkills: null });
  assert.deepEqual(resources, {
    skills: ['software-planning', 'web-research'],
    tools: ['web_search'],
    plugins: [],
  });
});
