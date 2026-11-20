'use strict';

/**
 * The stamp jobs' push, run for real against a throwaway origin.
 *
 * A publish that builds and pushes eight images and then loses its final
 * `git push` records nothing: the tags have moved, the registry holds the
 * digests, and the committed manifests still name the previous bytes. That is
 * not hypothetical — it happened on the merge that added `egm`, because a
 * second PR reached main between the run's checkout and its push. The next one
 * was two publishes of the same eight rows racing each other, which replayed
 * the same generated lines against each other and demanded a human.
 *
 * So the recovery is tested the way the failure happened: a derived stamp
 * commit, a branch that moved under it, and the block from the workflow run
 * verbatim. Reading the committed text is what `plugin-bundle.test.js` does;
 * whether a raced stamp actually lands, and lands with *these* digests, is only
 * knowable by doing it.
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
const REF = 'oci-refs/plugin-oci-ref-egm.txt';

/**
 * The push block of the stamp step, dedented, taken from the committed
 * workflow so the test cannot drift away from the thing CI runs.
 */
function stampPush(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const anchor = 'BASE_SHA="$(git rev-parse HEAD^)"';
  const at = text.indexOf(anchor);
  assert.notEqual(at, -1, `${rel}: the stamp step must recover from a moved branch instead of pushing once`);
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

/** Run one of the fixture's generator stand-ins the way the step does. */
function node(cwd, ...args) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `node ${args.join(' ')} in ${cwd}: ${r.stdout}${r.stderr}`);
}

// The two scripts the stamp step re-runs after a lost push, standing in for
// `stamp-plugin-digest.js` and `gen-kagent-manifests.js`. Only their contract is
// reproduced — the digest lives in the catalog and every manifest derives from
// it — because what the step depends on is that re-running them on a new tip
// rebuilds the commit from the artifacts on disk, byte for byte.
const STAMP = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[process.argv.indexOf('--refs-dir') + 1];
const CATALOG = '${CATALOG}';
const store = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
for (const file of fs.readdirSync(dir).sort()) {
  const id = /-oci-ref-([a-z0-9-]+)\\.txt$/.exec(file);
  if (!id) continue;
  const record = store.plugins.find((p) => p.id === id[1]);
  if (!record) throw new Error('no catalog record for ' + id[1]);
  record.digest = fs.readFileSync(path.join(dir, file), 'utf8').trim();
}
fs.writeFileSync(CATALOG, JSON.stringify(store, null, 1) + '\\n');
`;
const GEN = `
const fs = require('node:fs');
const path = require('node:path');
const store = JSON.parse(fs.readFileSync('${CATALOG}', 'utf8'));
for (const record of store.plugins) {
  const file = path.join('deploy/kagent', record.id, record.id + '-codex.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'oci: ' + record.digest + '\\n');
}
`;

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
  write(work, CATALOG, JSON.stringify({ plugins: [
    { id: 'egm', digest: 'sha256:base' },
    { id: 'hallmark', digest: 'sha256:base' },
  ] }, null, 1) + '\n');
  write(work, 'scripts/stamp-plugin-digest.js', STAMP);
  write(work, 'scripts/gen-kagent-manifests.js', GEN);
  write(work, 'docs/unrelated.md', 'handwritten\n');
  node(work, 'scripts/gen-kagent-manifests.js');
  git(work, 'add', '-A');
  git(work, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  git(work, 'branch', '-M', 'main');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', '-u', 'origin', 'main');
  // What the stamp step does before the push: take this run's immutable ref,
  // write the digest into the catalog, regenerate the manifests from it, commit.
  write(work, REF, 'sha256:new\n');
  node(work, 'scripts/stamp-plugin-digest.js', '--refs-dir', 'oci-refs');
  node(work, 'scripts/gen-kagent-manifests.js');
  git(work, 'add', 'packages/shared-core/src/agent/registry', 'deploy/kagent');
  git(work, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'chore(kagent): record published digests [skip ci]');
  const stamp = git(work, 'rev-parse', 'HEAD');
  // A second checkout standing for "the other publish that landed first".
  const other = path.join(root, 'other');
  git(root, 'clone', '-q', '--branch', 'main', origin, other);
  return { root, origin, work, other, stamp, write };
}

/** Run the workflow's push block the way the step does. */
function push(world, summary) {
  const r = spawnSync('bash', ['-c', stampPush('.github/workflows/build-plugin-images.yml')], {
    cwd: world.work,
    encoding: 'utf8',
    env: { ...process.env, MANIFEST, GITHUB_REF_NAME: 'main', GITHUB_STEP_SUMMARY: summary },
  });
  return { out: (r.stdout || '') + (r.stderr || ''), code: r.status, summary: fs.readFileSync(summary, 'utf8') };
}

/** Land a commit on origin/main from the other checkout. */
function land(world, rel, text) {
  world.write(world.other, rel, text);
  return commit(world, 'Merge pull request #999 from someone/else');
}

/** Commit whatever the other checkout has staged, and land it on origin/main. */
function commit(world, subject) {
  git(world.other, 'add', '-A');
  git(world.other, '-c', 'commit.gpgsign=false', 'commit', '-qm', subject);
  git(world.other, 'push', '-q', 'origin', 'main');
  return git(world.other, 'rev-parse', 'HEAD');
}

/** Land what a second publish of the same row would stamp. */
function landStamp(world, digest) {
  world.write(world.other, CATALOG, JSON.stringify({ plugins: [
    { id: 'egm', digest },
    { id: 'hallmark', digest: 'sha256:base' },
  ] }, null, 1) + '\n');
  node(world.other, 'scripts/gen-kagent-manifests.js');
  return commit(world, 'chore(kagent): record published plugin bundle digests [skip ci]');
}

const at = (world) => git(world.origin, 'rev-parse', 'main');
const digest = (world, id) =>
  JSON.parse(git(world.origin, 'show', `main:${CATALOG}`)).plugins.find((p) => p.id === id).digest;

test('an uncontested stamp push lands on the first attempt', () => {
  const w = world();
  const summary = path.join(w.root, 'summary.md');
  fs.writeFileSync(summary, '');
  const r = push(w, summary);
  assert.equal(r.code, 0, r.out);
  assert.equal(at(w), w.stamp);
  assert.match(r.summary, /attempt 1/);
});

test('a stamp that lost the race re-derives onto the new tip and lands', () => {
  const w = world();
  const summary = path.join(w.root, 'summary.md');
  fs.writeFileSync(summary, '');
  const theirs = land(w, 'docs/unrelated.md', 'the other PR\n');
  const r = push(w, summary);
  assert.equal(r.code, 0, r.out);
  assert.notEqual(at(w), theirs, 'the published digests must end up recorded');
  assert.equal(git(w.origin, 'rev-parse', 'main^'), theirs, 'the stamp must sit on top of what merged');
  assert.equal(git(w.origin, 'show', 'main:docs/unrelated.md'), 'the other PR', 'what merged must not be dropped');
  assert.equal(digest(w, 'egm'), 'sha256:new');
  assert.match(r.summary, /attempt 2/);
});

test('a row that moved under the run is refused rather than re-derived', () => {
  const w = world();
  const summary = path.join(w.root, 'summary.md');
  fs.writeFileSync(summary, '');
  const theirs = land(w, MANIFEST, 'repo,commit,version\nx,bbbb,2\n');
  const r = push(w, summary);
  // The digest this run produced belongs to the row it read. Re-deriving onto a
  // different row would record a pin for bytes no manifest names.
  assert.equal(r.code, 1, 'a moved row must fail the stamp, not publish a wrong pin');
  assert.match(r.summary, /moved while this run published/);
  assert.match(r.summary, /rebuild: all/);
  assert.equal(at(w), theirs, 'nothing may be pushed');
});

test('two publishes of one row resolve without a human, newest wins', () => {
  const w = world();
  const summary = path.join(w.root, 'summary.md');
  fs.writeFileSync(summary, '');
  const theirs = landStamp(w, 'sha256:other-run');
  const r = push(w, summary);
  // Replaying the first commit's diff here conflicted on the same catalog line
  // and the same generated manifest, and either resolution left a digest
  // recorded that the tags no longer name. Re-deriving cannot conflict.
  assert.equal(r.code, 0, r.out);
  assert.equal(digest(w, 'egm'), 'sha256:new', 'the newer publish must own the pin');
  assert.equal(git(w.origin, 'merge-base', '--is-ancestor', theirs, 'main'), '', 'and the other run stays in history');
  assert.equal(git(w.origin, 'show', 'main:deploy/kagent/egm/egm-codex.yaml').trim(), 'oci: sha256:new',
    'the manifest must be regenerated from the catalog, not carried over by the diff');
});

test('a stamp re-derives without disturbing another row that landed', () => {
  const w = world();
  const summary = path.join(w.root, 'summary.md');
  fs.writeFileSync(summary, '');
  land(w, CATALOG, JSON.stringify({ plugins: [
    { id: 'egm', digest: 'sha256:base' },
    { id: 'hallmark', digest: 'sha256:theirs' },
  ] }, null, 1) + '\n');
  const r = push(w, summary);
  assert.equal(r.code, 0, r.out);
  assert.equal(digest(w, 'hallmark'), 'sha256:theirs', 'only this run\'s row may move');
  assert.equal(digest(w, 'egm'), 'sha256:new');
});

test('neither stamp step replays a diff, pushes once and hopes, or forces', () => {
  for (const rel of ['.github/workflows/build-plugin-images.yml', '.github/workflows/build-skill-images.yml']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const stamp = text.split('Commit the stamped digests')[1];
    // Comments say "never --force" out loud; only code could violate it.
    const code = stamp.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    assert.ok(stamp, `${rel}: the stamp step must commit its digests`);
    assert.equal(/^          git push$/m.test(stamp), false,
      `${rel}: a bare git push cannot survive a merge during the publish`);
    assert.equal(/--force|-f origin|force-with-lease/.test(code), false, `${rel}: never overwrite what landed`);
    assert.match(stampPush(rel), /for attempt in 1 2 3 4 5/, `${rel}: the retry must be bounded`);
    // A derived commit is re-derived, not replayed: git rebase would reapply
    // this run's diff onto the same generated lines the other run rewrote.
    assert.equal(/git rebase/.test(code), false,
      `${rel}: rebasing a digest commit conflicts on the line both runs rewrote`);
    assert.match(code, /git reset -q --hard "origin\/\$\{GITHUB_REF_NAME\}"/,
      `${rel}: the retry must land on the new tip`);
    const loop = code.split('git fetch')[1];
    for (const script of ['stamp-plugin-digest.js --refs-dir oci-refs', 'gen-kagent-manifests.js']) {
      assert.match(loop, new RegExp(script.replace(/[.$/]/g, (c) => '\\' + c)),
        `${rel}: the retry must re-run ${script} against the new tip`);
    }
  }
});
