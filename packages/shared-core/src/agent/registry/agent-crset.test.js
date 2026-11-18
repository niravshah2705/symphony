'use strict';

/**
 * Tests for the four-CR renderer. They are written against kagent's rules, not
 * this module's convenience: every throw below is a `kubectl apply` rejection or
 * an Agent that stalls on ResolvedRefs, and the equality tests are the reason the
 * manifests can be generated at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const cr = require('./agent-crset');
const { CATALOG, findPlugin, enabledSkills } = require('./plugin-catalog');
const { SKILLS, findSkill } = require('./skill-catalog');

const ECC = findPlugin('ecc');
const AUDIT = findSkill('security-audit');
const root = path.resolve(__dirname, '../../../../..');

const doc = (set, kind) => set.documents.find((d) => d.kind === kind);
const template = (set) => doc(set, 'AgentTemplate').spec;
const harness = (set) => doc(set, 'Harness').spec;

test('a rendered set is exactly ModelConfig, Harness, AgentTemplate, Agent', () => {
  const set = cr.buildCrSet({ plugin: ECC, cliKey: 'codex' });
  assert.deepEqual(set.documents.map((d) => d.kind), ['ModelConfig', 'Harness', 'AgentTemplate', 'Agent']);
  assert.ok(set.documents.every((d) => d.apiVersion === cr.API_VERSION));
  assert.ok(set.documents.every((d) => d.metadata.namespace === 'kagent'));
});

test('the Agent is the only place the template and the harness meet', () => {
  const set = cr.buildCrSet({ plugin: ECC, cliKey: 'claude' });
  const agent = doc(set, 'Agent').spec;
  assert.deepEqual(agent.template.ref, { name: set.names.template });
  assert.deepEqual(agent.harnessRef, { name: set.names.harness });
  assert.deepEqual(agent.egressPolicyRefs, []);
  for (const spec of [template(set), harness(set)]) {
    assert.equal(spec.harnessRef, undefined);
    assert.equal(spec.template, undefined);
    assert.equal(spec.templateRef, undefined);
  }
});

test('names are deterministic from (pack, cli) so two runs cannot differ', () => {
  const a = cr.buildCrSet({ plugin: ECC, cliKey: 'codex' });
  const b = cr.buildCrSet({ plugin: findPlugin('ecc'), cliKey: 'codex' });
  assert.deepEqual(a.names, b.names);
  assert.equal(cr.renderCrSet(a), cr.renderCrSet(b));
  assert.match(a.names.agent, /^ecc-codex-agent$/);
});

test('the plugin source is digest-pinned, and an unstamped ref is visibly zeroes', () => {
  const set = cr.buildCrSet({ plugin: ECC, cliKey: 'codex' });
  const oci = template(set).plugins[0].source.oci;
  assert.match(oci, cr.OCI_PINNED);
  assert.ok(oci.endsWith(cr.DIGEST_PLACEHOLDER), 'a placeholder must be all zeroes, not a real digest');
  assert.equal(oci.split('@')[0], ECC.bundle.image);
});

test('a bare tag is rejected: the worker would resolve it to different bytes', () => {
  assert.throws(
    () => cr.buildCrSet({ plugin: ECC, cliKey: 'codex', ociRef: 'ghcr.io/niravshah2705/symphony/ecc-plugin:2.2.3' }),
    /not digest-pinned/,
  );
});

test('the enabled skill list reaches the template and cannot be empty or over cap', () => {
  const set = cr.buildCrSet({ plugin: ECC, cliKey: 'codex' });
  assert.deepEqual(template(set).plugins[0].skills, enabledSkills(ECC));
  assert.ok(template(set).plugins[0].skills.length > 0);

  const none = structuredClone(ECC);
  none.skills = [];
  assert.throws(() => cr.buildCrSet({ plugin: none, cliKey: 'codex' }), /no enabled skills/);

  const many = structuredClone(ECC);
  many.skills = Array.from({ length: 51 }, (_, i) => ({ name: `s-${i}`, enabled: true }));
  assert.throws(() => cr.buildCrSet({ plugin: many, cliKey: 'codex' }), /exceeds 50/);
});

test('the most common Ready failure is designed out: pool and snapshot location are named', () => {
  const set = cr.buildCrSet({ plugin: ECC, cliKey: 'codex' });
  assert.deepEqual(harness(set).substrate.workerPoolRef, { name: 'kagent-default' });
  assert.deepEqual(harness(set).substrate.snapshotPolicy, { location: 's3://ate-snapshots/kagent/' });
  const custom = cr.buildCrSet({
    plugin: ECC, cliKey: 'codex', workerPool: 'planner-pool', snapshotLocation: 's3://ate-snapshots/planner/',
  });
  assert.equal(harness(custom).substrate.workerPoolRef.name, 'planner-pool');
  assert.equal(harness(custom).substrate.snapshotPolicy.location, 's3://ate-snapshots/planner/');
});

test('the engine block is kagent\'s enum, and only that', () => {
  assert.ok(harness(cr.buildCrSet({ plugin: ECC, cliKey: 'codex' })).codex);
  const rowan = structuredClone(ECC);
  rowan.harnesses.codex.engine = 'qoder';
  assert.throws(() => cr.buildCrSet({ plugin: rowan, cliKey: 'codex' }), /outside kagent's enum/);
});

test('codex pins a digest-named runtime image; claude follows the release default', () => {
  const codex = harness(cr.buildCrSet({ plugin: ECC, cliKey: 'codex' }));
  assert.match(codex.workload.image, cr.OCI_PINNED);
  const claude = harness(cr.buildCrSet({ plugin: ECC, cliKey: 'claude' }));
  assert.equal(claude.workload, undefined, 'naming no image is the release default, not a missing field');
});

test('byo needs both a digest-pinned image and a command, and nothing longer than 32 entries', () => {
  const rowan = structuredClone(ECC);
  rowan.harnesses.dsh = { status: 'declared', engine: 'byo', version: '2.2.3', cliKey: 'dsh' };
  const image = 'ghcr.io/example/dsh@sha256:1111111111111111111111111111111111111111111111111111111111111111';
  assert.throws(() => cr.buildCrSet({ plugin: rowan, cliKey: 'dsh' }), /requires a digest-pinned workload/);
  assert.throws(
    () => cr.buildCrSet({ plugin: rowan, cliKey: 'dsh', workloadImage: image }),
    /requires an entrypoint command/,
  );
  const set = cr.buildCrSet({ plugin: rowan, cliKey: 'dsh', workloadImage: image, command: ['dsh', '--help'] });
  assert.deepEqual(harness(set).workload, { image, command: ['dsh', '--help'] });
  assert.throws(
    () => cr.buildCrSet({ plugin: rowan, cliKey: 'dsh', workloadImage: image, command: new Array(33).fill('x') }),
    /over the 32/,
  );
});

test('a git source needs a full 40-hex commit and never runs under Substrate', () => {
  // Tighter than the model-layer GIT_COMMIT, which also admits 64-hex: kagent
  // accepts 40 lowercase only.
  assert.match('3f14a103a8694e51c1df9a806217a6d0b5f7a6f7', cr.GIT_COMMIT);
  // Only a kagent/byo engine may name a git source at all.
  const graphify = findPlugin('graphify');
  assert.doesNotThrow(() => cr.buildCrSet({ plugin: graphify, cliKey: 'kagent', source: 'git' }));

  const short = structuredClone(graphify);
  short.upstream.commit = short.upstream.commit.slice(0, 12);
  assert.throws(
    () => cr.buildCrSet({ plugin: short, cliKey: 'kagent', source: 'git' }),
    /full 40-hex commit/,
  );
  assert.throws(
    () => cr.buildCrSet({ plugin: ECC, cliKey: 'codex', source: 'git' }),
    /crashes the Substrate snapshot builder/,
  );
});

test('a bundle mcp.json binds on the kagent engine and nowhere else', () => {
  const graphify = findPlugin('graphify');
  assert.equal(graphify.bundle.mcp, true);
  assert.equal(graphify.harnesses.kagent.mcp, true);
  assert.equal(graphify.harnesses.codex.mcp, false);
  // A kagent row that turns the server off ships a bundle whose server nothing
  // binds; a codex row that turns it on claims a binding the engine cannot make.
  const off = structuredClone(graphify);
  off.harnesses.kagent.mcp = false;
  assert.throws(
    () => cr.buildCrSet({ plugin: off, cliKey: 'kagent' }),
    /must bind its server on the kagent engine/,
  );
  const on = structuredClone(graphify);
  on.harnesses.codex.mcp = true;
  assert.throws(
    () => cr.buildCrSet({ plugin: on, cliKey: 'codex' }),
    /the codex engine does not read a bundle mcp\.json/,
  );
});

test('env is capped at 32 vars, reserves the CA names, and codex reserves more', () => {
  const wide = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`V${i}`, 'x']));
  assert.throws(() => cr.buildCrSet({ plugin: ECC, cliKey: 'codex', env: wide }), /over the 32/);
  assert.throws(
    () => cr.buildCrSet({ plugin: ECC, cliKey: 'codex', env: { SSL_CERT_FILE: '/x' } }),
    /reserved by kagent/,
  );
  assert.throws(
    () => cr.buildCrSet({ plugin: ECC, cliKey: 'codex', env: { OPENAI_API_KEY: 'sk-' } }),
    /the codex engine reserves the env name OPENAI_API_KEY/,
  );
  // The same name is fair game on claude, which is why it is engine-scoped.
  const claude = cr.buildCrSet({ plugin: ECC, cliKey: 'claude', env: { OPENAI_API_KEY: 'sk-' } });
  assert.deepEqual(harness(claude).env, [{ name: 'OPENAI_API_KEY', value: 'sk-' }]);
});

test('the catalog promptAppend reaches the prompt verbatim, with no invented mount path', () => {
  for (const plugin of CATALOG.plugins) {
    const set = cr.buildCrSet({ plugin, cliKey: 'codex' });
    assert.ok(template(set).systemPrompt.includes(plugin.promptAppend.trim()), `${plugin.id}: promptAppend paraphrased`);
    for (const banned of ['/mnt/', '/plugins/', 'SKILL_DIR', '.claude/skills']) {
      assert.equal(template(set).systemPrompt.includes(banned), false, `${plugin.id}: prompt guesses ${banned}`);
    }
  }
});

test('an unsupported cell refuses to render rather than emitting a blank image', () => {
  assert.throws(
    () => cr.buildCrSet({ plugin: findPlugin('code-review-graph'), cliKey: 'dsh' }),
    /unsupported \(blocked on /,
  );
  assert.equal(cr.renderablePairs().some((p) => p.pluginId === 'code-review-graph' && p.cliKey === 'dsh'), false);
});

test('a standalone skill mounts through spec.skills with a path, and never spec.plugins', () => {
  const set = cr.buildSkillCrSet({ skill: AUDIT, cliKey: 'codex' });
  const spec = template(set);
  assert.equal(spec.plugins, undefined);
  assert.deepEqual(spec.skills, [{
    name: 'security-audit',
    source: { oci: `${AUDIT.artifact.image}@${cr.DIGEST_PLACEHOLDER}`, path: AUDIT.artifact.skillPath },
  }]);
  assert.match(spec.skills[0].source.oci, cr.OCI_PINNED);
  assert.ok(spec.systemPrompt.includes(AUDIT.promptAppend.trim()));
});

test('a standalone skill that declares an MCP server is a packaging mistake', () => {
  const broken = structuredClone(AUDIT);
  broken.harnesses.codex.mcp = true;
  assert.throws(
    () => cr.buildSkillCrSet({ skill: broken, cliKey: 'codex' }),
    /declares no mcp\.json/,
  );
});

test('the skill source must be digest-pinned too, and the bare-tag message names the pack', () => {
  assert.throws(
    () => cr.buildSkillCrSet({ skill: AUDIT, cliKey: 'codex', ociRef: 'ghcr.io/x/security-audit-skill:c1c8a8c14710' }),
    /security-audit\/codex: skill source .* is not digest-pinned/,
  );
});

test('the emitter keeps every reference the stamping step rewrites on one line', () => {
  const text = cr.renderCrSet(cr.buildCrSet({ plugin: findPlugin('graphify'), cliKey: 'kagent' }));
  const ociLines = text.split('\n').filter((line) => /^[ ]*oci: /.test(line));
  assert.ok(ociLines.length >= 1);
  for (const line of ociLines) assert.match(line, /^ +oci: '?[^']+'?$/, 'a folded oci: line survives sed as a stray scalar');
  assert.equal(/oci: >-/.test(text), false);
  // Long prose still folds, so the file stays readable.
  assert.match(text, /description: >-/);
});

test('the ModelConfig holds the credential reference and never a credential value', () => {
  const spec = doc(cr.buildCrSet({ plugin: ECC, cliKey: 'codex' }), 'ModelConfig').spec;
  assert.equal(spec.apiKeySecret, 'litellm-secrets');
  assert.equal(spec.apiKeySecretKey, 'LITELLM_MASTER_KEY');
  assert.equal(JSON.stringify(spec).includes('key:'), false);
  assert.equal(spec.openAI.apiFormat, 'responses', 'the codex runtime posts to /v1/responses');
  assert.equal(doc(cr.buildCrSet({ plugin: ECC, cliKey: 'claude' }), 'ModelConfig').spec.openAI.apiFormat, undefined);
});

test('renderable pairs cover exactly the filled cells of both catalogs', () => {
  const pairs = cr.renderablePairs();
  const skillPairs = cr.renderableSkillPairs();
  const expected = CATALOG.plugins
    .flatMap((plugin) => Object.entries(plugin.harnesses)
      .filter(([, row]) => row.status !== 'unsupported')
      .map(([cliKey]) => `${plugin.id}/${cliKey}`));
  assert.deepEqual(pairs.map((p) => `${p.pluginId}/${p.cliKey}`).sort(), expected.sort());
  assert.deepEqual(
    skillPairs.map((p) => `${p.skillId}/${p.cliKey}`).sort(),
    ['security-audit/codex', 'security-audit/claude', 'security-audit/kagent'].sort(),
  );
});

test('every committed manifest is byte-equal to what the catalogs render today', () => {
  // The generator owns the header text; running it in --check mode keeps this
  // test honest about the whole file rather than about the subset a unit test
  // can reconstruct.
  const out = execFileSync(process.execPath, ['scripts/gen-kagent-manifests.js', '--check'], {
    cwd: root, encoding: 'utf8',
  });
  assert.match(out, /0 stale/, out);
});

test('the rendered files are four-CR streams with one generated marker each', () => {
  const manifests = [];
  for (const plugin of CATALOG.plugins) {
    for (const [cliKey, rel] of Object.entries(plugin.bundle.manifests || {})) {
      manifests.push({ cliKey, rel, text: fs.readFileSync(path.join(root, rel), 'utf8') });
    }
  }
  for (const skill of SKILLS.skills) {
    for (const [cliKey, rel] of Object.entries(skill.artifact.manifests || {})) {
      manifests.push({ cliKey, rel, text: fs.readFileSync(path.join(root, rel), 'utf8') });
    }
  }
  assert.ok(manifests.length >= CATALOG.plugins.length * 2);
  for (const m of manifests) {
    if (!m.text.includes('GENERATED by scripts/gen-kagent-manifests.js')) continue; // hand-written reference
    assert.equal(m.text.split('\n').filter((l) => l.startsWith('# GENERATED')).length, 1, m.rel);
    for (const kind of ['ModelConfig', 'Harness', 'AgentTemplate', 'Agent']) {
      assert.ok(m.text.includes(`# ${kind}: `), `${m.rel} has no ${kind}`);
    }
    assert.ok(m.text.includes(`${m.cliKey}`), `${m.rel} does not name its column`);
  }
});
