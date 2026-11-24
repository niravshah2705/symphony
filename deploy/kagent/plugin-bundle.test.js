'use strict';

/**
 * File-level invariants for the kagent pack pipeline. Like `deploy/gcp/*.test.js`,
 * this asserts over committed text rather than over runtime values: the failure
 * it is guarding against is a script that quietly stops doing the thing its
 * comment says, between the last review and the next publish.
 *
 * The rule running through all of it is that local and CI must not be able to
 * differ. Both read one CSV row through `pack-inputs.sh` / `skill-inputs.sh`,
 * both compose through the same script, and neither writes a committed manifest.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const { CATALOG, findPlugin, FULL_GIT_SHA } = require('../../packages/shared-core/src/agent/registry/plugin-catalog');
const { SKILLS, findSkill } = require('../../packages/shared-core/src/agent/registry/skill-catalog');
const { DIGEST_PLACEHOLDER } = require('../../packages/shared-core/src/agent/registry/agent-crset');

function csv(rel) {
  const [head, ...body] = read(rel).trimEnd().split('\n');
  const keys = head.split(',');
  return body.filter((l) => l.trim() !== '').map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(keys.map((k, i) => [k, (cells[i] || '').trim()]));
  });
}

const pluginRows = csv('deploy/kagent/plugins.csv');
const skillRows = csv('deploy/kagent/skills.csv');
const allManifests = [
  ...CATALOG.plugins.flatMap((p) => Object.values(p.bundle.manifests || {})),
  ...SKILLS.skills.flatMap((s) => Object.values(s.artifact.manifests || {})),
];

test('every pack has its own directory with the inputs the composer reads', () => {
  for (const row of pluginRows) {
    const dir = path.dirname(row.dockerfile);
    assert.ok(exists(`${dir}/bundle.env`), `${row.plugin}: bundle.env declares the compose inputs`);
    assert.ok(exists(`${dir}/skills.txt`), `${row.plugin}: skills.txt is the allowlist the bundle carries`);
    assert.ok(exists(row.dockerfile), `${row.plugin}: ${row.dockerfile}`);
  }
  for (const row of skillRows) {
    const dir = path.dirname(row.dockerfile);
    assert.ok(exists(`${dir}/bundle.env`), `${row.skill}: bundle.env declares the skill inputs`);
    // There is no allowlist on this track: the artifact is the skill.
    assert.equal(exists(`${dir}/skills.txt`), false, `${row.skill}: a standalone skill takes no skills.txt`);
    assert.ok(exists(row.dockerfile), `${row.skill}: ${row.dockerfile}`);
  }
});

test('every artifact image is data-only: FROM scratch, and the bundle is the context', () => {
  for (const row of [...pluginRows, ...skillRows]) {
    const dockerfile = read(row.dockerfile);
    assert.match(dockerfile, /^FROM scratch$/m, `${row.dockerfile} is not FROM scratch`);
    assert.equal(/^FROM (?!scratch)/m.test(dockerfile), false, `${row.dockerfile} layers a runtime onto a data image`);
    assert.match(dockerfile, /^COPY bundle\/\. \/$/m, `${row.dockerfile} must COPY the composed bundle at the root`);
    assert.match(dockerfile, /^LABEL org\.opencontainers\.image\.title/m, `${row.dockerfile} carries no OCI labels`);
    // No RUN: a scratch image has no shell, which is why requirements go elsewhere.
    assert.equal(/^RUN /m.test(dockerfile), false, `${row.dockerfile} cannot run anything in a scratch image`);
  }
});

test('the publish rows are pinned, resolvable, and have one current row each', () => {
  for (const [rows, key] of [[pluginRows, 'plugin'], [skillRows, 'skill']]) {
    const current = new Map();
    for (const row of rows) {
      assert.match(row.commit, FULL_GIT_SHA, `${row[key]}: a short sha is not a pin`);
      assert.match(row.repo, /^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/);
      assert.match(row.image, /^ghcr\.io\/[^/]+\/[^/]+\/[^/]+$/, `${row[key]}: image must be a ghcr repository`);
      assert.ok(exists(row.dockerfile), `${row[key]}: dockerfile ${row.dockerfile} is missing`);
      current.set(row[key], (current.get(row[key]) || 0) + (row.current === 'true'));
    }
    for (const [id, count] of current) assert.equal(count, 1, `${id}: exactly one current row gets :latest`);
  }
  // A skill artifact and a plugin bundle are different bytes: the suffix is how
  // the preflight, the validator and this test all tell them apart.
  for (const row of skillRows) assert.match(row.image, new RegExp(`/${row.skill}-skill$`));
  for (const row of pluginRows) assert.match(row.image, new RegExp(`/${row.plugin}-plugin$`));
});

test("the composers keep the bundle inside kagent's limits and keep the entry file", () => {
  const pluginComposer = read('deploy/kagent/ecc-plugin/compose-bundle.sh');
  const skillComposer = read('deploy/kagent/compose-skill-bundle.sh');
  for (const [name, text] of [['compose-bundle.sh', pluginComposer], ['compose-skill-bundle.sh', skillComposer]]) {
    assert.match(text, /10000/, `${name} must enforce the 10000-entry cap`);
    assert.match(text, /104857600/, `${name} must enforce the 100 MiB cap`);
    // Fetching the pin itself, so a stale cache cannot compose a different tree.
    assert.match(text, /FETCH_HEAD/, `${name} must check out the pinned commit, not a branch`);
  }
  // The skill composer is the only one with no image digest of its own until
  // publish, so it records what it composed instead.
  assert.match(skillComposer, /sha256/, 'the skill composer must record a content digest');
  assert.match(skillComposer, /SKILL\.md/, 'the skill composer must require the entry file');
  assert.match(skillComposer, /basename "\$\{SKILL_PATH\}"/, 'the mounted directory name IS the skill name');
  // The exclusion loop may never drop the entry file, or the artifact mounts empty.
  const excludeLoop = skillComposer.split('for pat in ${EXCLUDES')[1].split('\ndone')[0];
  assert.match(excludeLoop, /SKILL\.md|entry|never/, 'the exclude loop needs its SKILL.md guard');

  // Only the plugin track authors a root manifest and an allowlist.
  assert.match(pluginComposer, /"skills": "\.\/skills\/"/, 'plugin.json must point at ./skills/');
  assert.match(pluginComposer, /agent-plugins\.org\/schemas\/1\.0\.0\/plugin\.schema\.json/, 'plugin.json must name the spec it claims');
  assert.match(pluginComposer, /PLUGIN_SKILLS_LIST/, 'the allowlist is an input, not a constant');
  assert.match(pluginComposer, /PLUGIN_MCP_FILE/, 'mcp.json is emitted only when a pack names one');
  // A skill that cites its pack's reviewer prompts is not self-contained, so the
  // composer takes root-level companions as an input. Naming skills/ or the root
  // manifest would let a pack overwrite what the composer authors, and the copy
  // has to precede the cap measurement or the extras ship uncounted.
  assert.match(pluginComposer, /PLUGIN_EXTRA_PATHS/, "a pack's root-level companions are an input, not a constant");
  assert.match(pluginComposer, /^\s+skills \| plugin\.json \| mcp\.json\)/m,
    'the companion list must deny the names the composer authors at the bundle root');
  assert.ok(pluginComposer.indexOf('PLUGIN_EXTRA_PATHS entry') < pluginComposer.indexOf('ENTRY_COUNT='),
    'companions must be validated and copied before the bundle is measured against kagent limits');
  // Companions are upstream-relative, so the resolver must not rewrite them into
  // this repository the way it does an allowlist or an overlay dir.
  const packInputs = read('deploy/kagent/pack-inputs.sh');
  assert.match(packInputs, /export PLUGIN_EXTRA_PATHS="\$\{PLUGIN_EXTRA_PATHS:-\}"/,
    'the resolver must pass companions through raw, not resolve them against REPO_ROOT');
  assert.equal(/PLUGIN_EXTRA_PATHS="\$\(resolve/.test(packInputs), false,
    'resolve() would prefix REPO_ROOT onto an upstream path');
  // Only a comment may mention it: the skill track authors no root manifest, and
  // that is what distinguishes its artifact from a bundle.
  const manifestLines = skillComposer.split('\n')
    .filter((line) => line.includes('plugin.json') && !/^\s*#/.test(line));
  assert.deepEqual(manifestLines, [], 'a standalone skill authors no plugin manifest');
});

test('local builds and CI resolve the same row through one helper', () => {
  const local = read('deploy/kagent/build-plugin-image.sh');
  const skillLocal = read('deploy/kagent/build-skill-image.sh');
  const ci = read('.github/workflows/build-plugin-images.yml');
  const skillCi = read('.github/workflows/build-skill-images.yml');
  for (const text of [local, ci]) assert.match(text, /deploy\/kagent\/pack-inputs\.sh/);
  for (const text of [skillLocal, skillCi]) assert.match(text, /deploy\/kagent\/skill-inputs\.sh/);
  for (const [name, text] of [['build-plugin-image.sh', local], ['build-skill-image.sh', skillLocal]]) {
    assert.match(text, /compose-bundle\.sh|compose-skill-bundle\.sh/, `${name} must compose through the shared script`);
    assert.match(text, /RepoDigests/, `${name}: the digest is read back from the registry, not recomputed`);
    assert.match(text, /v2\/.*manifests/, `${name}: the builder proves the manifest resolves in-cluster`);
  }
  assert.equal(local.includes('VERSION_FILE'), false, 'a builder must not re-derive the version source itself');
});

test('a PR composes the bundles it is not allowed to publish', () => {
  // The merge is the first run that builds, so a skills.txt name absent
  // upstream, or a PLUGIN_EXTRA_PATHS entry that does not resolve, would die
  // there — the build fails, the stamp job never runs, and the committed
  // manifest keeps an all-zero digest that only an in-cluster apply notices.
  const ci = read('.github/workflows/build-plugin-images.yml');
  const parts = ci.split('name: Dry-compose every selected bundle');
  assert.equal(parts.length, 2, 'the plan job must dry-compose exactly once');
  const step = parts[1].split('\n      - name:')[0];
  assert.match(step, /if: \$\{\{ github\.event_name == 'pull_request' \}\}/,
    'a merge run already builds, so the leg must not double the work');
  assert.match(step, /deploy\/kagent\/pack-inputs\.sh/,
    'the PR leg must resolve the row through the same helper as the build');
  assert.match(step, /compose-bundle\.sh/, 'the PR leg must run the real composer');
  // Every upstream fetch goes through the pin, so the leg cannot pass on a
  // stale cache the way a repeat local run can.
  assert.equal(/--branch|--depth 0/.test(step), false, 'the leg must not fetch a moving ref');
});

test('every script a workflow runs by path is executable', () => {
  // A 644 here is a CI job that dies on "permission denied" for a script whose
  // logic is fine — and only on the merge path, because the PR legs run --check.
  const invoked = [];
  for (const wf of ['build-plugin-images.yml', 'build-skill-images.yml']) {
    for (const [, rel] of read(`.github/workflows/${wf}`).matchAll(/^\s+((?:scripts|deploy)\/\S+\.sh)(?=\s|$)/gm)) {
      invoked.push([wf, rel]);
    }
  }
  assert.ok(invoked.length >= 2, 'the workflows must be the ones this test reads');
  for (const [wf, rel] of invoked) {
    const executable = (fs.statSync(path.join(ROOT, rel)).mode & 0o111) !== 0;
    assert.ok(executable, `${wf} runs ${rel} directly, but it is not executable`);
  }
});

test('the selection is one shared table, not two hand-kept workflow scripts', () => {
  const pluginCi = read('.github/workflows/build-plugin-images.yml');
  const skillCi = read('.github/workflows/build-skill-images.yml');
  for (const [wf, text, track] of [['build-plugin-images.yml', pluginCi, 'plugin'], ['build-skill-images.yml', skillCi, 'skill']]) {
    const calls = [...text.matchAll(/python3 deploy\/kagent\/select-published-rows\.py/g)];
    assert.equal(calls.length, 1, `${wf} must select rows through exactly one helper call`);
    assert.ok(text.includes(`--track ${track} \\`), `${wf} must name its own track to the selector`);
    assert.match(text, /--base-csv/, `${wf} must hand the selector the baseline manifest`);
    assert.match(text, /--paths/, `${wf} must hand the selector the changed paths`);
    // Without the full history there is no previous commit to diff, and the
    // fallback is a republish of every pack on every merge.
    assert.match(text, /fetch-depth: 0/, `${wf} cannot diff without the history`);
    assert.match(text, /type: choice[\s\S]*options:\n\s+- all\n\s+- changed/, `${wf} needs the rebuild=all escape hatch`);
    // A PR publishes nothing, so it must validate every row rather than the moved
    // subset: the diff would only weaken the one run that catches a bad row.
    const scope = text.split('name: Classify the change')[1].split('- name:')[0];
    assert.match(scope, /pull_request\)\n\s+echo "mode=all"/, `${wf} must resolve every row on a PR run`);
  }
  // The fields the build steps interpolate; a rename in the selector would
  // otherwise surface as an empty matrix entry on the merge path.
  assert.match(pluginCi, /matrix\.dockerfile/);
  assert.match(pluginCi, /matrix\.tags/);
  assert.match(skillCi, /matrix\.skill_path/);
});

test("the selector's tables name paths that exist, and nothing that reaches a bundle is inert", () => {
  const helper = read('deploy/kagent/select-published-rows.py');
  const literals = [...helper.matchAll(/"((?:deploy|\.github|docs|public|packages|scripts|\.githooks)\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(literals.length >= 12, 'the classification tables are the thing this test guards');
  for (const rel of literals) {
    assert.ok(exists(rel.replace(/\/$/, '')), `the selector classifies ${rel}, which is not in the repo`);
  }
  // INERT_PREFIX calls packages/ and scripts/ inert because the composers take
  // every input from the environment the resolvers build. A catalog field that
  // reached a bundle would have to join the row compare instead, and this is the
  // assertion that would fail rather than a silently stale published artifact.
  for (const rel of ['deploy/kagent/ecc-plugin/compose-bundle.sh', 'deploy/kagent/compose-skill-bundle.sh',
    'deploy/kagent/pack-inputs.sh', 'deploy/kagent/skill-inputs.sh']) {
    const text = read(rel);
    for (const forbidden of ['plugin-catalog', 'skill-catalog', 'registry/', 'plugin-support.csv']) {
      assert.equal(text.includes(forbidden), false, `${rel} reads ${forbidden}, so packages/ is no longer inert`);
    }
  }
});

test('no builder writes a committed manifest', () => {
  const builders = [
    'deploy/kagent/build-plugin-image.sh',
    'deploy/kagent/build-skill-image.sh',
    'deploy/kagent/ecc-plugin/build-ecc-plugin-image.sh',
  ];
  for (const builder of builders) {
    const text = read(builder);
    const sedTargets = [...text.matchAll(/sed -i(?:\.bak)?[^\n]*?"([^"]*\.yaml)"/g)].map((m) => m[1]);
    for (const target of sedTargets) {
      assert.match(target, /BUILD_DIR|local\.yaml/, `${builder} stamps ${target}, which is a committed file`);
    }
    assert.match(text, /local\.yaml/, `${builder} must stamp a gitignored local copy`);
  }
  // And none of the committed manifests carries a kind-registry address.
  for (const rel of allManifests) {
    const oci = [...read(rel).matchAll(/^\s*oci:\s*(\S+)/gm)].map((m) => m[1].replace(/'/g, ''));
    for (const ref of oci) {
      assert.match(ref, /^ghcr\.io\//, `${rel}: committed manifests name the published repository, not ${ref}`);
    }
  }
});

test('every committed manifest sources exactly the image its catalog record publishes', () => {
  const records = new Map([
    ...CATALOG.plugins.map((p) => [p.id, { record: p, base: p.bundle }]),
    ...SKILLS.skills.map((s) => [s.id, { record: s, base: s.artifact }]),
  ]);
  const pairs = [
    ...CATALOG.plugins.flatMap((p) => Object.entries(p.bundle.manifests || {}).map(([cliKey, rel]) => ({ id: p.id, cliKey, rel }))),
    ...SKILLS.skills.flatMap((s) => Object.entries(s.artifact.manifests || {}).map(([cliKey, rel]) => ({ id: s.id, cliKey, rel }))),
  ];
  for (const { id, cliKey, rel } of pairs) {
    const { record, base } = records.get(id);
    const digest = base.digest || DIGEST_PLACEHOLDER.split('@').pop();
    const expected = `${base.image}@${digest}`;
    const refs = [...read(rel).matchAll(/^\s*oci:\s*(\S+)/gm)].map((m) => m[1].replace(/'/g, ''));
    const sources = refs.filter((r) => !r.startsWith('ghcr.io/kagent-dev/'));
    assert.ok(sources.length >= 1, `${rel} names no plugin source`);
    for (const ref of sources) {
      assert.equal(ref, expected, `${rel}: ${ref} is not what ${id}/${cliKey} publishes`);
    }
    // The pin, once: a manifest that states a version must state the record's.
    if (record.bundle) assert.equal(read(rel).includes('0000000000000000'), base.digest === null);
  }
});

test('the harness runtime image digest is pinned, never a floating tag', () => {
  for (const rel of allManifests) {
    for (const line of read(rel).split('\n')) {
      if (!/^\s*image: /.test(line)) continue;
      const value = line.split('image:')[1].trim().replace(/'/g, '');
      assert.match(value, /@sha256:[0-9a-f]{64}$/, `${rel}: workload image ${value} must be digest-pinned`);
    }
  }
});

test('the mount test covers both tracks and refuses a placeholder digest', () => {
  const text = read('deploy/kagent/test-pack.sh');
  assert.match(text, /--quick/);
  assert.match(text, /--apply/);
  // Both tracks, because they mount through different spec fields.
  assert.match(text, /\.spec\.plugins\[0\]\.source\.oci/);
  assert.match(text, /\.spec\.skills\[0\]\.source\.oci/);
  assert.match(text, /0000000000000000/, 'an unstamped digest must fail the test, not pass it');
  assert.match(text, /unsupported/);
  // exit codes: 0 pass, 1 failure, 2 cannot run
  assert.match(text, /exit 2/);
});

test('build artifacts stay out of the repository', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /deploy\/kagent\/\*\/build\//);
  assert.match(ignore, /deploy\/kagent\/skills\/\*\/build\//);
  assert.ok(findPlugin('ecc') && findSkill('security-audit'));
});

test('every generated manifest says so, and the hand-written reference does not', () => {
  const generated = allManifests.filter((rel) => read(rel).includes('GENERATED by scripts/gen-kagent-manifests.js'));
  assert.ok(generated.length >= allManifests.length - 1);
  const reference = 'deploy/kagent/ecc-plugin/ecc-agent.yaml';
  assert.equal(read(reference).includes('GENERATED by'), false,
    'the annotated #307 reference is maintained by hand and must stay readable');
  for (const rel of generated) {
    const text = read(rel);
    assert.match(text, /# Apply: kubectl --context kind-kind apply -f /);
    assert.match(text, /build\/.*\.local\.yaml from it/, `${rel} must tell a reader how to build locally`);
  }
});
