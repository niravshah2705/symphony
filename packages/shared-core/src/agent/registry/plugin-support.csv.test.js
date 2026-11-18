'use strict';

/**
 * Tests for the generated support matrix. The discipline is the one
 * `deploy/gcp/substrate-env.test.js` uses: check the drift in BOTH directions,
 * because a cell that no longer matches the catalog is silent in exactly the
 * way that matters — someone quotes it in a review and it names a version that
 * was never published.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../../..');
const MATRIX = path.join(ROOT, 'deploy/kagent/plugin-support.csv');
const PLUGINS_CSV = path.join(ROOT, 'deploy/kagent/plugins.csv');
const SKILLS_CSV = path.join(ROOT, 'deploy/kagent/skills.csv');

const { CATALOG, MATRIX_COLUMNS, cellVersion, findPlugin } = require('./plugin-catalog');
const { SKILLS, cellVersion: skillCellVersion, findSkill } = require('./skill-catalog');

/** Split a CSV into header + rows of objects, with no parsing library. */
function parse(file) {
  const [head, ...body] = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const keys = head.split(',');
  return {
    keys,
    rows: body.filter((line) => line.trim() !== '').map((line) => {
      const cells = line.split(',');
      return Object.fromEntries(keys.map((key, i) => [key, (cells[i] || '').trim()]));
    }),
  };
}

const matrix = parse(MATRIX);
const columns = matrix.keys.slice(2);
const rowFor = (id) => matrix.rows.find((row) => row.id === id);

test('the matrix header is kind, id, then one column per kagent-reachable CLI', () => {
  assert.deepEqual(matrix.keys.slice(0, 2), ['kind', 'id']);
  // kagent's own engine column comes first: it is where the MCP-binding rows
  // live, and leaving it out makes those packs look skill-only.
  assert.deepEqual(columns, ['kagent', ...Object.keys(MATRIX_COLUMNS)]);
});

test('the rows are exactly the catalog records, in both directions', () => {
  const expected = [
    ...CATALOG.plugins.map((p) => ['plugin', p.id]),
    ...SKILLS.skills.map((s) => ['skill', s.id]),
  ];
  const actual = matrix.rows.map((row) => [row.kind, row.id]);
  assert.deepEqual(actual, expected);
  assert.equal(matrix.rows.length, CATALOG.plugins.length + SKILLS.skills.length);
});

test('a cell is either the record version or blank — never a hand-typed number', () => {
  for (const row of matrix.rows) {
    const record = row.kind === 'plugin' ? findPlugin(row.id) : findSkill(row.id);
    const version = row.kind === 'plugin' ? record.bundle.version : record.artifact.version;
    for (const column of columns) {
      const cell = row[column];
      const entry = record.harnesses[column];
      if (!entry || entry.status === 'unsupported') {
        assert.equal(cell, '', `${row.id}/${column}: unsupported or absent must be blank`);
        continue;
      }
      assert.equal(cell, version, `${row.id}/${column}: filled cell must be the record version`);
      assert.equal(cell, row.kind === 'plugin'
        ? cellVersion(record, column)
        : skillCellVersion(record, column));
    }
  }
});

test('every pack in the matrix has a publishing row that says the same thing', () => {
  const pluginRows = parse(PLUGINS_CSV);
  const skillRows = parse(SKILLS_CSV);
  assert.deepEqual(pluginRows.keys, ['plugin', 'repo', 'commit', 'version', 'version_source', 'image', 'dockerfile', 'current']);
  assert.deepEqual(skillRows.keys, ['skill', 'repo', 'commit', 'version', 'version_source', 'skill_path', 'image', 'dockerfile', 'current']);

  for (const row of pluginRows.rows) {
    const record = findPlugin(row.plugin);
    assert.ok(record, `${row.plugin} is published but not catalogued`);
    assert.equal(row.commit, record.upstream.commit);
    assert.equal(row.version, record.bundle.version);
    assert.equal(row.version_source, record.upstream.versionSource);
    assert.equal(row.image, record.bundle.image);
    assert.equal(row.dockerfile, record.bundle.dockerfile);
    assert.ok(fs.existsSync(path.join(ROOT, row.dockerfile)), `${row.dockerfile} exists`);
  }
  for (const row of skillRows.rows) {
    const record = findSkill(row.skill);
    assert.ok(record, `${row.skill} is published but not catalogued`);
    assert.equal(row.commit, record.upstream.commit);
    assert.equal(row.version, record.artifact.version);
    assert.equal(row.skill_path, record.artifact.skillPath);
    assert.equal(row.image, record.artifact.image);
    assert.ok(fs.existsSync(path.join(ROOT, row.dockerfile)), `${row.dockerfile} exists`);
  }
  for (const plugin of CATALOG.plugins) {
    assert.ok(pluginRows.rows.some((r) => r.plugin === plugin.id), `${plugin.id} has no plugins.csv row`);
  }
  for (const skill of SKILLS.skills) {
    assert.ok(skillRows.rows.some((r) => r.skill === skill.id), `${skill.id} has no skills.csv row`);
  }
});

test('a matrix row only claims a version its own CSV row publishes', () => {
  // The three-way equality the plan asks for: catalog cell == CSV version ==
  // what the bundle will be labelled. This is the leg that catches a catalog
  // edited without the CSV, or the reverse.
  const published = new Map([
    ...parse(PLUGINS_CSV).rows.map((r) => [`plugin:${r.plugin}`, r.version]),
    ...parse(SKILLS_CSV).rows.map((r) => [`skill:${r.skill}`, r.version]),
  ]);
  for (const row of matrix.rows) {
    for (const column of columns) {
      if (row[column]) assert.equal(row[column], published.get(`${row.kind}:${row.id}`),
        `${row.id}/${column} quotes ${row[column]} but the manifest publishes ${published.get(`${row.kind}:${row.id}`)}`);
    }
  }
});

test('exactly one current row per pack, so :latest has one meaning', () => {
  for (const [file, key] of [[PLUGINS_CSV, 'plugin'], [SKILLS_CSV, 'skill']]) {
    const rows = parse(file).rows;
    const byPack = new Map();
    for (const row of rows) byPack.set(row[key], (byPack.get(row[key]) || 0) + Number(row.current === 'true'));
    for (const [id, count] of byPack) assert.equal(count, 1, `${id}: ${count} rows marked current`);
    assert.equal(rows.every((r) => ['true', 'false'].includes(r.current)), true);
  }
});

test('the MCP-only-on-kagent split is visible in the matrix rather than buried in prose', () => {
  const mcpPacks = CATALOG.plugins.filter((p) => p.bundle.mcp).map((p) => p.id).sort();
  // Plugin rows only: a standalone skill also has a kagent cell, because a skill
  // directory mounts there too — it just never carries an mcp.json.
  const kagentCells = matrix.rows
    .filter((r) => r.kind === 'plugin' && r.kagent)
    .map((r) => r.id).sort();
  assert.deepEqual(kagentCells, mcpPacks,
    'today the only packs with a kagent engine row are the mcp-carrying ones; if a plain skill pack gains a kagent cell, widen this assertion and say why');
  for (const id of mcpPacks) {
    const record = findPlugin(id);
    assert.equal(record.harnesses.kagent.mcp, true, `${id}: the kagent row must bind the server`);
    assert.equal(record.harnesses.codex.mcp, false, `${id}: codex does not read a bundle mcp.json`);
  }
});

test('the two tracks share a version rule, and only they differ in where it comes from', () => {
  const { VERSION_SOURCES } = require('./plugin-catalog');
  const basenames = parse(PLUGINS_CSV).rows.map((r) => path.posix.basename(r.version_source));
  assert.ok(basenames.every((v) => v !== 'none' && VERSION_SOURCES.includes(v)),
    'a plugin pack must state an upstream version somewhere in a known file');
  const skillVersions = parse(SKILLS_CSV).rows.map((r) => r.version_source);
  assert.ok(skillVersions.every((v) => v === 'none' || VERSION_SOURCES.includes(v)));
  for (const row of matrix.rows.filter((r) => r.kind === 'skill')) {
    const record = findSkill(row.id);
    if (record.upstream.versionSource === 'none') {
      assert.equal(row.codex, record.upstream.commit.slice(0, 12), `${row.id}: the cell is the pin`);
    }
  }
});

test('regenerating the matrix from the catalogs writes these exact bytes', () => {
  // The seed script owns the rendering; running its --check gate here keeps the
  // CSV, the two publishing CSVs and both catalogs provably in date.
  const out = execFileSync(process.execPath, ['scripts/seed-plugin-catalog.js', '--check'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.match(out, /is in date with the catalogs/);
});
