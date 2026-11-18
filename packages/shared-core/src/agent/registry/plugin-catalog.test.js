'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CATALOG,
  MATRIX_COLUMNS,
  KAGENT_COLUMN,
  VERSION_SOURCES,
  STATUSES,
  SKILLS_MAX,
  PROMPT_APPEND_MAX,
  DOCKERFILE_INSTRUCTIONS,
  isAgentPluginName,
  FULL_GIT_SHA,
  validatePluginCatalog,
  eccSourceAgreement,
  buildMatrix,
  cellVersion,
  enabledSkills,
  findPlugin,
} = require('./plugin-catalog');
const { ECC_SOURCE } = require('./schema');

const ROOT = path.resolve(__dirname, '../../../../..');

/** Deep-clone so a mutation in one case cannot leak into the next. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorFor(mutate) {
  const catalog = clone(CATALOG);
  mutate(catalog);
  const { errors } = validatePluginCatalog(catalog);
  assert.ok(errors.length > 0, 'expected the mutation to be rejected');
  return errors;
}

test('the shipped catalog validates clean', () => {
  const { ok, errors } = validatePluginCatalog(CATALOG);
  assert.deepEqual(errors, [], errors.join('\n'));
  assert.equal(ok, true);
});

test('every column is a CLI name and maps to a kagent engine or explains why not', () => {
  assert.deepEqual(Object.keys(MATRIX_COLUMNS), [
    'deepagent', 'codex', 'claude', 'antigravity', 'qodercli', 'opencode', 'pi', 'omp', 'dsh',
  ]);
  // Harness.spec.engine is the enum kagent|codex|claude|byo: only codex and claude
  // are native, deepagent has no engine at all, and the rest need a byo image.
  assert.equal(MATRIX_COLUMNS.deepagent.engine, null);
  assert.equal(MATRIX_COLUMNS.codex.engine, 'codex');
  assert.equal(MATRIX_COLUMNS.claude.engine, 'claude');
  for (const key of ['antigravity', 'qodercli', 'opencode', 'pi', 'omp', 'dsh']) {
    assert.equal(MATRIX_COLUMNS[key].engine, 'byo', `${key} is only reachable as byo`);
  }
});

test('one version number, three places: upstream release == bundle version == every filled cell', () => {
  for (const plugin of CATALOG.plugins) {
    assert.equal(plugin.bundle.version, plugin.upstream.release, plugin.id);
    for (const [key, entry] of Object.entries(plugin.harnesses)) {
      const cell = cellVersion(plugin, key);
      if (entry.status === 'unsupported') {
        assert.equal(cell, '', `${plugin.id}/${key} is unsupported and must render blank`);
      } else {
        assert.equal(cell, plugin.upstream.release, `${plugin.id}/${key}`);
      }
    }
  }
});

test('the matrix is rectangular and blanks unsupported cells', () => {
  const { columns, rows } = buildMatrix(CATALOG);
  assert.deepEqual(columns, Object.keys(MATRIX_COLUMNS));
  assert.equal(rows.length, CATALOG.plugins.length);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row.cells), columns, row.id);
    // Nothing is fillable outside codex/claude until a byo runtime image exists.
    for (const key of columns) {
      if (key !== 'codex' && key !== 'claude') assert.equal(row.cells[key], '', `${row.id}/${key}`);
    }
  }
});

test('pins are full commits, because kagent rejects a branch, tag or abbreviated sha', () => {
  for (const plugin of CATALOG.plugins) {
    assert.match(plugin.upstream.commit, FULL_GIT_SHA, plugin.id);
    assert.equal(plugin.versions[0].commit, plugin.upstream.commit, plugin.id);
    assert.ok(VERSION_SOURCES.includes(path.posix.basename(plugin.upstream.versionSource)),
      `${plugin.id}: ${plugin.upstream.versionSource}`);
  }
});

test('a 12-character or 64-character pin is rejected', () => {
  for (const short of ['3f14a103a869', 'a'.repeat(64)]) {
    const errors = errorFor((catalog) => { catalog.plugins[0].upstream.commit = short; });
    assert.ok(errors.some((e) => /exactly 40 lowercase hex/.test(e)), errors.join('\n'));
  }
});

test('plugin ids obey the Agent Plugins 1.0.0 naming rule', () => {
  for (const plugin of CATALOG.plugins) {
    assert.ok(isAgentPluginName(plugin.id), plugin.id);
  }
  for (const bad of ['ECC', '-ecc', 'ecc-', 'ecc--skills', 'ecc..skills', 'ecc_skills', 'e', 'x'.repeat(65)]) {
    const errors = errorFor((catalog) => { catalog.plugins[0].id = bad; });
    assert.ok(errors.some((e) => /Agent Plugins 1.0\.0 name/.test(e)), `${bad}: ${errors.join('\n')}`);
  }
});

test('enabled skills are non-empty, within kagent cap of 50, and unique', () => {
  for (const plugin of CATALOG.plugins) {
    const enabled = enabledSkills(plugin);
    assert.ok(enabled.length > 0, plugin.id);
    assert.ok(enabled.length <= SKILLS_MAX, `${plugin.id} has ${enabled.length}`);
    assert.equal(new Set(enabled).size, enabled.length, plugin.id);
    assert.deepEqual(plugin.skills.filter((s) => !s.enabled).map((s) => s.name),
      plugin.skills.map((s) => s.name).filter((n) => !enabled.includes(n)), plugin.id);
  }
  const errors = errorFor((catalog) => {
    catalog.plugins[0].skills = Array.from({ length: 51 }, (_, i) => ({ name: `s-${i}`, enabled: true }));
  });
  assert.ok(errors.some((e) => /exceeds the kagent limit of 50/.test(e)), errors.join('\n'));
});

test('attaching a plugin without enabling a skill is rejected: the agent would start with none', () => {
  const errors = errorFor((catalog) => {
    catalog.plugins[0].skills = catalog.plugins[0].skills.map((s) => ({ ...s, enabled: false }));
  });
  assert.ok(errors.some((e) => /does not enable its skills/.test(e)), errors.join('\n'));
});

test('a bundle version that is not the upstream version is rejected', () => {
  const errors = errorFor((catalog) => { catalog.plugins[0].bundle.version = '1.0.0'; });
  assert.ok(errors.some((e) => /bundle\.version 1\.0\.0 != upstream\.release 2\.2\.3/.test(e)), errors.join('\n'));
});

test('a matrix cell that disagrees with the bundle version is rejected', () => {
  const errors = errorFor((catalog) => { catalog.plugins[0].harnesses.codex.version = '9.9.9'; });
  assert.ok(errors.some((e) => /cell version 9\.9\.9 != bundle version/.test(e)), errors.join('\n'));
});

test('requirements land in the harness runtime image, never the plugin image', () => {
  for (const plugin of CATALOG.plugins) {
    assert.match(plugin.requirements.appliedTo, /^go\/harness\/[^/]+\/Dockerfile$/, plugin.id);
    assert.doesNotMatch(plugin.requirements.appliedTo, /deploy\/kagent/, plugin.id);
  }
  const errors = errorFor((catalog) => {
    catalog.plugins[0].requirements.appliedTo = 'deploy/kagent/ecc-plugin/Dockerfile.ecc-plugin';
  });
  assert.ok(errors.some((e) => /not a plugin image/.test(e)), errors.join('\n'));
});

test('requirement lines are appendable Dockerfile steps and carry no credential', () => {
  for (const plugin of CATALOG.plugins) {
    for (const line of plugin.requirements.dockerfile) {
      assert.ok(DOCKERFILE_INSTRUCTIONS.includes(line.trim().split(/\s+/)[0].toUpperCase()), line);
    }
  }
  for (const line of [
    'RUN echo $LINEAR_API_KEY=abc',
    'ENV OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv',
    'RUN git clone https://ghp_AAAAAAAAAAAAAAAAAAAA@github.com/x/y',
  ]) {
    const errors = errorFor((catalog) => { catalog.plugins[0].requirements.dockerfile = [line]; });
    assert.ok(errors.some((e) => /credential-shaped/.test(e)), `${line}: ${errors.join('\n')}`);
  }
  const errors = errorFor((catalog) => { catalog.plugins[0].requirements.dockerfile = ['ADD http://x/y /']; });
  assert.ok(errors.some((e) => /not an allowed instruction/.test(e)), errors.join('\n'));
});

test('promptAppend is present and inside the 4000-character per-plugin cap', () => {
  for (const plugin of CATALOG.plugins) {
    assert.ok(plugin.promptAppend.length > 0, plugin.id);
    assert.ok(plugin.promptAppend.length <= PROMPT_APPEND_MAX, plugin.id);
  }
  const errors = errorFor((catalog) => { catalog.plugins[0].promptAppend = 'x'.repeat(4001); });
  assert.ok(errors.some((e) => /exceeds 4000 chars/.test(e)), errors.join('\n'));
});

test('icons are committed same-origin files, not remote assets', () => {
  for (const plugin of CATALOG.plugins) {
    assert.equal(plugin.icon.file, `public/icons/plugins/${plugin.id}.svg`);
    assert.equal(plugin.icon.href, `/icons/plugins/${plugin.id}.svg`);
    assert.ok(!/^https?:/.test(plugin.icon.href), plugin.id);
    const abs = path.join(ROOT, plugin.icon.file);
    assert.ok(fs.existsSync(abs), `missing ${plugin.icon.file}`);
    const svg = fs.readFileSync(abs, 'utf8');
    assert.match(svg, /^<svg\b/, plugin.icon.file);
    assert.ok(!/<(script|image[^>]*href=["']https?)/i.test(svg), `${plugin.icon.file} must not embed remote content`);
  }
  const errors = errorFor((catalog) => { catalog.plugins[0].icon.href = 'https://cdn.example.com/ecc.svg'; });
  assert.ok(errors.some((e) => /same-origin/.test(e)), errors.join('\n'));
});

test('plugin-declared mcp.json binds only on engine kagent', () => {
  for (const plugin of CATALOG.plugins) {
    for (const [key, entry] of Object.entries(plugin.harnesses)) {
      if (entry.engine === KAGENT_COLUMN) assert.equal(entry.mcp, plugin.bundle.mcp, `${plugin.id}/${key}`);
      else assert.equal(entry.mcp, false, `${plugin.id}/${key}`);
    }
  }
  const errors = errorFor((catalog) => { catalog.plugins[0].harnesses.codex.mcp = true; });
  assert.ok(errors.some((e) => /binds only on engine kagent/.test(e)), errors.join('\n'));
});

test('an unsupported cell names the runtime image it is blocked on', () => {
  const crg = findPlugin('code-review-graph');
  assert.equal(crg.harnesses.dsh.status, 'unsupported');
  assert.equal(crg.harnesses.dsh.blockedOn, 'go/harness/dsh/Dockerfile');
  const errors = errorFor((catalog) => { delete catalog.plugins[5].harnesses.dsh.blockedOn; });
  assert.ok(errors.some((e) => /must name what it is blocked on/.test(e)), errors.join('\n'));
});

test('a status outside the legend is rejected', () => {
  for (const status of ['maybe', 'Built', '']) {
    const errors = errorFor((catalog) => { catalog.plugins[0].harnesses.codex.status = status; });
    assert.ok(errors.some((e) => new RegExp(`status must be one of ${STATUSES.join('|')}`.replace('|', '|')).test(e)), errors.join('\n'));
  }
});

test('the ecc record agrees with the harness-rootfs sources.json', () => {
  assert.deepEqual(eccSourceAgreement(CATALOG, ECC_SOURCE), []);
  const drift = clone(CATALOG);
  drift.plugins[0].upstream.repository = 'someone-else/ECC';
  assert.match(eccSourceAgreement(drift, ECC_SOURCE).join('\n'), /sources\.json/);
  const versionDrift = clone(CATALOG);
  versionDrift.plugins[0].upstream.release = '3.0.0';
  assert.match(eccSourceAgreement(versionDrift, ECC_SOURCE).join('\n'), /versionRange/);
});

test('the catalog covers all seven packs the milestone tracks', () => {
  assert.deepEqual(CATALOG.plugins.map((p) => p.id).sort(), [
    'agent-skills', 'code-review-graph', 'ecc', 'graphify', 'hallmark', 'spec-kit', 'superpowers',
  ]);
});

test('malformed catalog documents fail loudly rather than silently', () => {
  assert.equal(validatePluginCatalog(null).ok, false);
  assert.equal(validatePluginCatalog({ schemaVersion: 'plugin-catalog/v2', plugins: [] }).ok, false);
  const errors = errorFor((catalog) => { catalog.plugins[0].skills = []; });
  assert.ok(errors.some((e) => /non-empty array|at least one skill/.test(e)), errors.join('\n'));
});
