'use strict';

/**
 * The stamp jobs' push, run for real against a throwaway origin.
 *
 * A publish that builds and pushes eight images and then loses its final
 * `git push` records nothing: the tags have moved, the registry holds the
 * digests, and the committed manifests still name the previous bytes. That is
 * not hypothetical — it happened on the merge that added `egm`, because a
 * second PR reached main between the run's checkout and its push.
 *
 * So the recovery is tested the way the failure happened: a stamp commit, a
 * branch that moved under it, and the block from the workflow run verbatim.
 * Reading the committed text is what `plugin-bundle.test.js` does; whether the
 * rebase actually lands is only knowable by doing it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const MANIFEST = 'deploy/kagent/plugins.csv';
const CATALOG = 'packages/shared-core/src/agent/registry/plugin-catalog.json';

/**
 * The push block of the stamp step, dedented, taken from the committed
 * workflow so the test cannot drift away from the thing CI runs.
 */
function stampPush(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const anchor = 'BASE_SHA="$(git rev-parse HEAD^)"';
  const at = text.indexOf(anchor);
  assert.notEqual(at, -1, `${rel}: the stamp step must rebase onto the new tip instead of pushing once`);
  const lines = [];
  for (const line of text.slice(at).split('\n')) {
    // The run block is indented 10; the next key of the workflow is at 6.
    if (/^ {6}\S/.test(line)) break;
    lines.push(line.replace(/^ {10}/, ''));
  }
  return lines.join('\n');
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'bot', GIT_AUTHOR_EMAIL: 'bot@x',
      GIT_COMMITTER_NAME: 'bot', GIT_COMMITTER_EMAIL: 'bot@x',
    },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo with a stamped-digest commit pending, and an origin it can race. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-race-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '--bare', '-q', origin);
  git(root, 'init', '-q', work);
  const write = (dir, rel, text) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(work, MANIFEST, 'repo,commit,version\nx,aaaa,1\n');
  write(work, CATALOG, '{"digest": "sha256:old"}\n');
  write(work, 'docs/unrelated.md', 'handwritten\n');
  git(work, 'add', '-A');
  git(work, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  git(work, 'branch', '-M', 'main');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', '-u', 'origin', 'main');
  // What the stamp jobs do before the push: write the digests, regenerate.
  write(work, CATALOG, '{"digest": "sha256:new"}\n');
  git(work, 'add', '-A');
  git(work, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'chore(kagent): record published digests [skip ci]');
  const stamp = git(work, 'rev-parse', 'HEAD');
  // A second checkout standing for "the PR that merged during the publish".
  const other = path.join(root, 'other');
  git(root, 'clone', '-q', '--branch', 'main', origin, other);
  return { root, origin, work, other, stamp, write };
}

/** Run the workflow's push block the way the step does. */
function push(work, summary) {
  const r = spawnSync('bash', ['-c', stampPush('.github/workflows/build-plugin-images.yml')], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, MANIFEST, GITHUB_REF_NAME: 'main', GITHUB_STEP_SUMMARY: summary },
  });
  return { out: (r.stdout || '') + (r.stderr || ''), code: r.status, summary: fs.readFileSync(summary, 'utf8') };
}

/** Land a commit on origin/main from the other checkout. */
function land(world, rel, text) {
  world.write(world.other, rel, text);
  git(world.other, 'add', '-A');
  git(world.other, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Merge pull request #999 from someone/else');
  git(world.other, 'push', '-q', 'origin', 'main');
  return git(world.other, 'rev-parse', 'HEAD');
}

const at = (world) => git(world.origin, 'rev-parse', 'main');

test('an uncontested stamp push lands on the first attempt', () => {
  const w = world();
  const summary = path.join(w.root, 'summary.md');
  fs.writeFileSync(summary, '');
  const r = push(w.work, summary);
  assert.equal(r.code, 0, r.out);
  assert.equal(at(w), w.stamp);
  assert.match(r.summary, /attempt 1/);
});

test('a stamp that lost the race rebases onto the new tip and lands', () => {
  const w = world();
  const summary = path.join(w.root, 'summary.md');
  fs.writeFileSync(summary, '');
  const theirs = land(w, 'docs/unrelated.md', 'the other PR\n');
  const r = push(w.work, summary);
  assert.equal(r.code, 0, r.out);
  assert.notEqual(at(w), theirs, 'the published digests must end up recorded');
  assert.equal(git(w.origin, 'rev-parse', 'main^'), theirs, 'the stamp must sit on top of what merged');
  assert.equal(git(w.origin, 'show', 'main:docs/unrelated.md'), 'the other PR', 'the rebase must not drop their change');
  assert.equal(git(w.origin, 'show', 'main:packages/shared-core/src/agent/registry/plugin-catalog.json'),
    '{"digest": "sha256:new"}');
  assert.match(r.summary, /attempt 2/);
});

test('a row that moved under the run is refused rather than rebased', () => {
  const w = world();
  const summary = path.join(w.root, 'summary.md');
  fs.writeFileSync(summary, '');
  const theirs = land(w, MANIFEST, 'repo,commit,version\nx,bbbb,2\n');
  const r = push(w.work, summary);
  // The digests this run produced belong to the row it read. Rebasing them onto
  // a different row would record a pin for bytes no manifest names.
  assert.equal(r.code, 1, 'a moved row must fail the stamp, not publish a wrong pin');
  assert.match(r.summary, /moved while this run published/);
  assert.match(r.summary, /rebuild: all/);
  assert.equal(at(w), theirs, 'nothing may be pushed');
});

test('a conflicting stamp aborts and never forces', () => {
  const w = world();
  const summary = path.join(w.root, 'summary.md');
  fs.writeFileSync(summary, '');
  const theirs = land(w, CATALOG, '{"digest": "sha256:other-run"}\n');
  const r = push(w.work, summary);
  assert.equal(r.code, 1, 'two stamps of the same row is a human call');
  assert.match(r.summary, /conflict/);
  assert.equal(at(w), theirs);
  assert.equal(fs.existsSync(path.join(w.work, '.git', 'rebase-merge')), false,
    'a failed rebase must be aborted, not left for the next attempt to resume wrong');
  assert.equal(git(w.work, 'status', '--porcelain'), '', 'and must leave the worktree clean');
});

test('neither stamp step pushes once and hopes, or forces', () => {
  for (const rel of ['.github/workflows/build-plugin-images.yml', '.github/workflows/build-skill-images.yml']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const stamp = text.split('Commit the stamped digests')[1];
    // Comments say "never --force" out loud; only code could violate it.
    const nocomment = stamp.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    assert.ok(stamp, `${rel}: the stamp step must commit its digests`);
    assert.equal(/^          git push$/m.test(stamp), false,
      `${rel}: a bare git push cannot survive a merge during the publish`);
    assert.match(stamp, /git rebase/);
    assert.match(stamp, /--abort/);
    assert.equal(/--force|-f origin|force-with-lease/.test(nocomment), false, `${rel}: never overwrite what landed`);
    assert.match(stampPush(rel), /for attempt in 1 2 3 4 5/, `${rel}: the retry must be bounded`);
  }
});
