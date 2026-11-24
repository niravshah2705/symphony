'use strict';

/**
 * Behavioural coverage for PLUGIN_EXTRA_PATHS, the composer input that ships a
 * pack's root-level companions beside skills/.
 *
 * `plugin-bundle.test.js` asserts over committed text, which is the right tool
 * for a script quietly stopping doing what its comment says. It cannot tell
 * whether a copy landed at the depth a citation expects, and that is exactly
 * the failure this input can produce: a bundle that composes, publishes and
 * mounts, with skills whose instructions point at files that are not there.
 * So this file composes for real, against a local fixture repository.
 *
 * The cases are the ones the input exists to make impossible, plus the
 * regression that matters most: a pack declaring nothing must compose exactly
 * what it composed before the input existed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const COMPOSER = path.join(ROOT, 'deploy/kagent/ecc-plugin/compose-bundle.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-extras-'));

// A skill of the shape EGM ships: three companion citations, one of them an
// upstream page that is deliberately NOT declared, and one `docs/designs/...`
// path that means the user's own repository rather than this pack.
const SKILL_WITH_CITES = [
  '# Review',
  'Read [Codex integration](../../docs/codex.md) first.',
  'Dispatch the reviewer at `agents/comprehension.md` applying',
  '`resources/document_standards/zoom-out-standard.md`.',
  'Publish the RFC under `docs/designs/<feature>.md` in your repository.',
  'Upstream also has a page at docs/releases.md.',
  '',
].join('\n');

/**
 * Build a fixture upstream at a fresh commit, so every case has a HEAD that is
 * its own pin and no cached checkout can leak between cases.
 * @param {(dir:string)=>void} [mutate] extra files to add before the commit
 */
function fixture(mutate) {
  const dir = fs.mkdtempSync(path.join(TMP, 'upstream-'));
  const write = (rel, text) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('plugin.json', '{\n  "name": "egm",\n  "version": "0.1.1"\n}\n');
  write('skills/egm-review/SKILL.md', SKILL_WITH_CITES);
  write('agents/comprehension.md', 'reviewer prompt\n');
  write('resources/document_standards/zoom-out-standard.md', 'standard\n');
  write('docs/codex.md', 'adaptation guide\n');
  write('docs/designs/README.md', 'EGM internal design notes\n');
  if (mutate) mutate(dir);
  const git = (args) => {
    const r = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'f@x',
        GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'f@x',
      },
    });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r;
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  return { dir, commit: head, git, recommit: (msg) => {
    git(['add', '-A']);
    git(['commit', '-qm', msg]);
    return { dir, commit: git(['rev-parse', 'HEAD']).stdout.trim() };
  } };
}

let caseId = 0;
/** Compose one fixture with the given companion specs. */
function compose(upstream, { extras = '' } = {}) {
  const out = path.join(TMP, `out-${(caseId += 1)}`);
  const proc = spawnSync('bash', [COMPOSER, out], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLUGIN_REPO: `file://${upstream.dir}`,
      PLUGIN_COMMIT: upstream.commit,
      PLUGIN_VERSION: '0.1.1',
      PLUGIN_NAME: 'egm',
      PLUGIN_VERSION_SOURCE: 'plugin.json',
      PLUGIN_SKILLS_SRC: 'skills',
      PLUGIN_EXTRA_PATHS: extras,
    },
  });
  return {
    proc,
    out,
    bundle: path.join(out, 'bundle'),
    err: (proc.stderr || '').replace(/\x1b\[[0-9;]*m/g, ''),
  };
}

test('declared companions land beside skills/ at the depth the citations expect', () => {
  const f = fixture();
  const { proc, bundle, err } = compose(f, { extras: 'agents resources docs/codex.md' });
  assert.equal(proc.status, 0, err);
  // Depth is load-bearing: a single-file entry must keep its directory, or
  // every root-relative citation to docs/<file>.md misses it.
  assert.equal(fs.existsSync(path.join(bundle, 'docs/codex.md')), true, err);
  assert.equal(fs.existsSync(path.join(bundle, 'codex.md')), false, 'a file entry must not flatten to the root');
  assert.equal(fs.existsSync(path.join(bundle, 'agents/comprehension.md')), true);
  assert.equal(fs.existsSync(path.join(bundle, 'resources/document_standards/zoom-out-standard.md')), true);
  // What the pack declares is what ships, so the ~230 KB internal notes tree
  // the same citation form names stays out of the mount.
  assert.equal(fs.existsSync(path.join(bundle, 'docs/designs')), false);
  assert.deepEqual(fs.readdirSync(path.join(bundle, 'skills')), ['egm-review']);
});

test('a citation under a declared root that did not ship fails the compose', () => {
  const f = fixture((dir) => {
    fs.writeFileSync(path.join(dir, 'agents/summarize.md'), 'another prompt\n');
  });
  // The declared root exists upstream, so the absent-path gate passes; only the
  // citation check catches that the prompt the skill dispatches is not the one
  // that shipped. This is the "copied is not reachable" case the gate is for.
  f.git(['rm', '-q', 'agents/comprehension.md']);
  const dropped = f.recommit('drop the reviewer prompt');
  const { proc, err } = compose(dropped, { extras: 'agents' });
  assert.notEqual(proc.status, 0, 'a skill whose reviewer prompt is missing must not publish');
  assert.match(err, /cite these declared companion paths/);
  assert.match(err, /agents\/comprehension\.md/);
});

test('a companion may not overwrite what the composer authors at the root', () => {
  const f = fixture();
  for (const spec of ['plugin.json', 'skills', 'mcp.json']) {
    const { proc, err } = compose(f, { extras: spec });
    assert.notEqual(proc.status, 0, `${spec} must be refused`);
    assert.match(err, new RegExp(`may not name '${spec}'`));
  }
});

test('companion specs are shaped before anything is fetched', () => {
  const f = fixture();
  for (const spec of ['../escape', '/etc/passwd', '-rf', 'a/../b']) {
    const r = compose(f, { extras: spec });
    assert.notEqual(r.proc.status, 0, `${spec} must be refused`);
    assert.match(r.err, /upstream-relative/);
    // The shape gate runs ahead of the checkout, so a refused spec leaves no
    // partial tree behind for a repeat run to mistake for a composed bundle.
    assert.equal(fs.existsSync(path.join(r.out, `egm-${f.commit}`)), false);
  }
});

test('every absent path is named in one failure, not one per run', () => {
  const f = fixture();
  const { proc, err } = compose(f, { extras: 'agents docs/nope.md resources/nope.md' });
  assert.notEqual(proc.status, 0);
  assert.match(err, /docs\/nope\.md resources\/nope\.md/, 'both absent paths in one message');
});

test('a symlink or a secret-shaped file inside a companion never reaches an image', () => {
  const link = compose(fixture((dir) => {
    fs.symlinkSync('../../plugin.json', path.join(dir, 'agents/dangling.md'));
  }), { extras: 'agents' });
  assert.notEqual(link.proc.status, 0, link.err);
  assert.match(link.err, /symlink/);

  const secret = compose(fixture((dir) => {
    fs.writeFileSync(path.join(dir, 'resources/staging_secret.md'), 'x\n');
  }), { extras: 'resources' });
  assert.notEqual(secret.proc.status, 0, secret.err);
  assert.match(secret.err, /secret-shaped/);
});

test('a citation the pack did not declare is reported, not fatal', () => {
  const f = fixture();
  const { proc, err } = compose(f, { extras: 'agents resources docs/codex.md' });
  assert.equal(proc.status, 0, err);
  // docs/releases.md and docs/designs/ are both cited and both undeclared, but
  // only one is an upstream file: the composer cannot tell an upstream page
  // from a path the agent is handed at run time, so it lists them and builds.
  assert.match(err, /docs\/releases\.md/);
  assert.match(err, /not declared in PLUGIN_EXTRA_PATHS/);
});

test('a pack that declares no companions composes exactly what it did before', () => {
  const f = fixture();
  const bare = compose(f, { extras: '' });
  assert.equal(bare.proc.status, 0, bare.err);
  assert.deepEqual(fs.readdirSync(bare.bundle).sort(), ['plugin.json', 'skills']);
  const withExtras = compose(f, { extras: 'agents resources docs/codex.md' });
  assert.notEqual(fs.readdirSync(bare.bundle).join(' '), fs.readdirSync(withExtras.bundle).join(' '),
    'the input must actually add something when a pack uses it');
});
