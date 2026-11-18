'use strict';

/**
 * Behavioural tests for deploy/kagent/select-published-rows.py, the step that
 * decides which pack a merge republishes.
 *
 * The invariant under test is narrow but expensive to discover in production: a
 * bundle build is not byte-reproducible, so selecting a row that did not change
 * republishes that pack under its existing tag and the stamp job then rewrites
 * its committed manifest with a digest no source change produced. Selecting too
 * *few* is the worse direction (the manifest would name bytes that were never
 * built for the new recipe), which is why an unrecognized path means "rebuild
 * everything" rather than "skip".
 *
 * This-tracks rows are fixtures, so a moved pin here does not silently change
 * what the tests assert. The other track is the repo's real manifest, because
 * inertness is defined against the pack directories it names.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const HELPER = 'deploy/kagent/select-published-rows.py';
const PLUGIN_HEAD = 'plugin,repo,commit,version,version_source,image,dockerfile,current';
const SKILL_HEAD = 'skill,repo,commit,version,version_source,image,dockerfile,skill_path,current';

function row(kind, id, over = {}) {
  const dir = kind === 'plugin' ? `deploy/kagent/${id}` : `deploy/kagent/skills/${id}`;
  const base = {
    [kind]: id,
    repo: `https://github.com/example/${id}.git`,
    commit: `00000000000000000000000000000000000${id.padEnd(3, '0').slice(0, 3)}`.slice(0, 40),
    version: `1.0.${id.length}`,
    version_source: 'VERSION',
    image: `ghcr.io/example/symphony/${id}-${kind}`,
    dockerfile: `${dir}/Dockerfile.${id}-${kind}`,
    // Both tracks carry the column; only the plugin track uses it for :latest.
    current: 'false',
  };
  if (kind === 'skill') base.skill_path = `skills/${id}`;
  return { ...base, ...over };
}

function toCsv(head, rows) {
  const keys = head.split(',');
  return [head, ...rows.map((r) => keys.map((k) => r[k] ?? '').join(','))].join('\n') + '\n';
}

/** Run the selector over a fixture manifest; returns {rows, count, reason, error}. */
function select({ track, mode = 'changed', head = [], paths = [], only = '', base = head }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'select-rows-'));
  const key = track === 'plugin' ? 'plugin' : 'skill';
  const manifest = path.join(dir, 'manifest.csv');
  fs.writeFileSync(manifest, toCsv(track === 'plugin' ? PLUGIN_HEAD : SKILL_HEAD, head));
  const baseCsv = path.join(dir, 'base.csv');
  if (base === null) fs.rmSync(baseCsv, { force: true });
  else fs.writeFileSync(baseCsv, toCsv(track === 'plugin' ? PLUGIN_HEAD : SKILL_HEAD, base));
  const changed = path.join(dir, 'paths.txt');
  fs.writeFileSync(changed, paths.join('\n') + (paths.length ? '\n' : ''));
  const selected = path.join(dir, 'selected.txt');

  const argv = [HELPER, '--track', track, '--mode', mode, '--manifest', manifest,
    '--base-csv', baseCsv, '--paths', changed, '--selected', selected];
  if (only) argv.push('--only', only);

  let stdout = '';
  let error = '';
  // spawnSync reports a non-zero exit on the result rather than throwing, and the
  // error cases below are the whole point of checking stderr at all.
  const proc = spawnSync('python3', argv, { cwd: ROOT, encoding: 'utf8' });
  stdout = proc.stdout || '';
  if (proc.status !== 0) error = String(proc.stderr || proc.error || '').trim().split('\n').pop();
  const out = Object.fromEntries(stdout.trim().split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const matrix = out.matrix ? JSON.parse(out.matrix) : [];
  return {
    ids: matrix.map((m) => m[key]),
    matrix,
    count: out.count === undefined ? null : Number(out.count),
    reason: out.reason ?? null,
    error,
    selected: fs.existsSync(selected) ? fs.readFileSync(selected, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

const three = [
  row('plugin', 'alpha', { current: 'true' }),
  row('plugin', 'bravo'),
  row('plugin', 'charlie'),
];
const one = [row('skill', 'delta', { current: 'true' })];

test('mode=all resolves every row, and only the current row gets :latest', () => {
  const got = select({ track: 'plugin', mode: 'all', head: three });
  assert.deepEqual(got.ids, ['alpha', 'bravo', 'charlie']);
  assert.equal(got.reason, 'full manifest');
  assert.equal(got.matrix[0].tags, 'ghcr.io/example/symphony/alpha-plugin:1.0.5,ghcr.io/example/symphony/alpha-plugin:latest');
  assert.equal(got.matrix[1].tags, 'ghcr.io/example/symphony/bravo-plugin:1.0.5');
  // The build job reads these four fields by name; a rename breaks CI, not a test.
  for (const field of ['plugin', 'version', 'image', 'dockerfile', 'tags', 'repo', 'commit']) {
    assert.ok(field in got.matrix[0], `matrix entry is missing ${field}`);
  }
});

test('the skill track names the pin only: no :latest, and skill_path travels', () => {
  const got = select({ track: 'skill', mode: 'all', head: one });
  assert.equal(got.matrix[0].tags, 'ghcr.io/example/symphony/delta-skill:1.0.5');
  assert.equal(got.matrix[0].skill_path, 'skills/delta');
  assert.equal(got.matrix[0].current, undefined);
});

test('a baseline identical to the head selects nothing', () => {
  const got = select({ track: 'plugin', head: three });
  assert.deepEqual(got.ids, []);
  assert.equal(got.count, 0);
  assert.equal(got.reason, 'nothing moved');
  assert.deepEqual(got.selected, []);
});

test('every way a row can move selects that row and only that row', () => {
  const move = (mutate) => {
    const base = three.map((r) => ({ ...r }));
    mutate(base);
    return select({ track: 'plugin', head: three, base });
  };
  assert.deepEqual(move((b) => { b[1].commit = 'f'.repeat(40); }).ids, ['bravo']);
  assert.deepEqual(move((b) => { b[1].version = '1.0.1'; }).ids, ['bravo']);
  assert.deepEqual(move((b) => { b[1].image = 'ghcr.io/example/symphony/other-plugin'; }).ids, ['bravo']);
  assert.deepEqual(move((b) => { b[1].current = 'true'; }).ids, ['bravo']);
  assert.deepEqual(move((b) => { b[1].version_source = 'pyproject.toml'; }).ids, ['bravo']);
  // An added row is a new pack staged for its first publish.
  assert.deepEqual(move((b) => b.pop()).ids, ['charlie']);
  // A deleted row has nothing left to publish, so it selects nothing by itself.
  assert.deepEqual(select({ track: 'plugin', head: three.slice(0, 2), base: three }).ids, []);
});

test('a change inside a pack directory selects that pack', () => {
  for (const file of ['bundle.env', 'skills.txt', 'overlay/mcp.json', 'Dockerfile.bravo-plugin']) {
    const got = select({ track: 'plugin', head: three, paths: [`deploy/kagent/bravo/${file}`] });
    assert.deepEqual(got.ids, ['bravo'], `${file} must select bravo`);
    assert.equal(got.reason, 'pack inputs');
  }
});

test('a change to anything that composes every bundle selects every row', () => {
  const shared = [
    'deploy/kagent/ecc-plugin/compose-bundle.sh',
    'deploy/kagent/pack-inputs.sh',
    'deploy/kagent/build-plugin-image.sh',
    'deploy/kagent/select-published-rows.py',
    '.github/workflows/build-plugin-images.yml',
  ];
  for (const file of shared) {
    const got = select({ track: 'plugin', head: three, paths: [file] });
    assert.deepEqual(got.ids, ['alpha', 'bravo', 'charlie'], `${file} must rebuild the whole manifest`);
    assert.equal(got.reason, 'shared recipe changed');
  }
  const skillShared = ['deploy/kagent/compose-skill-bundle.sh', 'deploy/kagent/skill-inputs.sh',
    'deploy/kagent/build-skill-image.sh', 'deploy/kagent/select-published-rows.py',
    '.github/workflows/build-skill-images.yml'];
  for (const file of skillShared) {
    const other = row('skill', 'echo');
    assert.deepEqual(select({ track: 'skill', head: [one[0], other], paths: [file] }).ids, ['delta', 'echo'],
      `${file} must republish every skill`);
  }
  // Even when only one row moved: the recipe change is the reason for all of them.
  const base = three.map((r) => ({ ...r }));
  base[0].commit = 'f'.repeat(40);
  assert.deepEqual(select({ track: 'plugin', head: three, base, paths: ['deploy/kagent/pack-inputs.sh'] }).ids.length, 3);
});

test('the skill track is inert here, and vice versa', () => {
  // Real paths from the repo's own manifests and pack directories, so this fails
  // if one of those packs is renamed rather than if the rule is broken.
  const otherPack = fs.readdirSync(path.join(ROOT, 'deploy/kagent/skills')).filter((d) => !d.startsWith('.'))[0];
  assert.ok(otherPack, 'the other track must have at least one pack directory');
  for (const file of ['deploy/kagent/skills.csv', `deploy/kagent/skills/${otherPack}/bundle.env`,
    'deploy/kagent/compose-skill-bundle.sh', 'deploy/kagent/skill-inputs.sh',
    'deploy/kagent/build-skill-image.sh', '.github/workflows/build-skill-images.yml']) {
    assert.deepEqual(select({ track: 'plugin', head: three, paths: [file] }).ids, [], `${file} must not rebuild a plugin`);
  }
  for (const file of ['deploy/kagent/plugins.csv', 'deploy/kagent/ecc-plugin/compose-bundle.sh',
    'deploy/kagent/pack-inputs.sh', 'deploy/kagent/ecc-plugin/bundle.env', 'deploy/kagent/plugin-support.csv',
    '.github/workflows/build-plugin-images.yml']) {
    assert.deepEqual(select({ track: 'skill', head: one, paths: [file] }).ids, [], `${file} must not republish a skill`);
  }
  // The mirror of the pack rule: its own directory is live on its own track.
  assert.deepEqual(select({ track: 'skill', head: one, paths: ['deploy/kagent/skills/delta/bundle.env'] }).ids, ['delta']);
});

test('what reaches no bundle byte is inert', () => {
  const inert = [
    'docs/PLUGIN_SUPPORT_MATRIX.md',
    'public/icons/plugins/alpha.svg',
    'packages/shared-core/src/agent/registry/plugin-catalog.json',
    'scripts/seed-plugin-catalog.js',
    'scripts/verify-plugin-images.sh',
    'deploy/kagent/plugin-support.csv',
    'deploy/kagent/plugin-bundle.test.js',
    '.githooks/pre-commit',
  ];
  for (const file of inert) {
    const got = select({ track: 'plugin', head: three, paths: [file] });
    assert.deepEqual(got.ids, [], `${file} reaches no bundle byte`);
  }
});

test('an unrecognized path rebuilds everything', () => {
  for (const file of ['deploy/kagent/new-thing.sh', 'Makefile', 'compose.yaml']) {
    const got = select({ track: 'plugin', head: three, paths: [file] });
    assert.deepEqual(got.ids, ['alpha', 'bravo', 'charlie'], `${file} must fail toward a full rebuild`);
    assert.equal(got.reason, 'shared recipe changed');
  }
});

test('the reasons add up when a row moved and a pack input changed', () => {
  const base = three.map((r) => ({ ...r }));
  base[0].commit = 'f'.repeat(40);
  const got = select({ track: 'plugin', head: three, base, paths: ['deploy/kagent/charlie/skills.txt'] });
  assert.deepEqual(got.ids, ['alpha', 'charlie']);
  assert.equal(got.reason, 'moved rows and pack inputs');
});

test('--only narrows the selection and still catches a typo', () => {
  assert.deepEqual(select({ track: 'plugin', mode: 'all', head: three, only: 'bravo' }).ids, ['bravo']);
  // A pack whose rows simply did not move is a no-op, not an error.
  assert.deepEqual(select({ track: 'plugin', head: three, only: 'bravo' }).ids, []);
  assert.match(select({ track: 'plugin', head: three, only: 'nope' }).error, /no manifest rows for plugin 'nope'/);
});

test('a mangled manifest fails the run instead of publishing nothing quietly', () => {
  assert.match(select({ track: 'plugin', head: [] }).error, /has no rows/);
  const blank = three.map((r) => ({ ...r, dockerfile: '' }));
  assert.match(select({ track: 'plugin', mode: 'all', head: blank }).error, /empty dockerfile/);
});

test('mode=changed with no baseline manifest resolves the whole thing', () => {
  // The workflow only writes base.csv when it found a usable commit, so this is
  // the shape of a run whose scope step said "changed" and had nothing to diff.
  const got = select({ track: 'plugin', head: three, base: null });
  assert.deepEqual(got.ids, ['alpha', 'bravo', 'charlie']);
  assert.equal(got.reason, 'changed requested but no baseline manifest');
});
