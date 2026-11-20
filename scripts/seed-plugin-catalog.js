#!/usr/bin/env node
'use strict';

/**
 * The plugin/skill support matrix, generated from the two catalogs.
 *
 * `deploy/kagent/plugin-support.csv` is the artifact the docs and the Linear
 * milestone are read from: rows are packs, columns are CLI harnesses, a cell is
 * the version that pack is published at on that CLI, and a blank cell means
 * "not available" — not "someone has not filled it in yet".
 *
 * It is generated because the same version number lives in four places (the
 * catalog, `plugins.csv`/`skills.csv`, the authored `plugin.json`, and any cell
 * that quotes it), and a hand-edited CSV is a fifth. `--check` renders into
 * memory and compares, so drift in either direction fails before someone quotes
 * a stale cell in a review.
 *
 * The CSVs are also re-checked here against the catalogs — same ids, pin,
 * version, image, Dockerfile, version source. This does not rewrite them:
 * `plugins.csv` is what CI's matrix reads, and the row order and the `current`
 * flag are that workflow's business, not the catalog's.
 *
 * Usage:
 *   node scripts/seed-plugin-catalog.js             write the matrix
 *   node scripts/seed-plugin-catalog.js --check      fail on drift (CI gate)
 *   node scripts/seed-plugin-catalog.js --store      also mirror the records into
 *                                                    the `plugins` collection
 *                                                    (idempotent; what boot runs)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const registry = (name) => require(path.join(ROOT, 'packages/shared-core/src/agent/registry', name));
const { CATALOG, MATRIX_COLUMNS, validatePluginCatalog, cellVersion } = registry('plugin-catalog');
const { SKILLS, validateSkillCatalog, cellVersion: skillCellVersion } = registry('skill-catalog');

const MATRIX_PATH = 'deploy/kagent/plugin-support.csv';
const PLUGIN_CSV = 'deploy/kagent/plugins.csv';
const SKILL_CSV = 'deploy/kagent/skills.csv';
const CHECK = process.argv.includes('--check');
const STORE = process.argv.includes('--store');

// kagent's own engine column first: it is where the MCP-binding rows live, and
// a matrix that omits it makes graphify and code-review-graph look skill-only
// when their value splits between skills (codex/claude) and MCP (kagent).
const COLUMNS = ['kagent', ...Object.keys(MATRIX_COLUMNS)];

function readCsv(relative) {
  const text = fs.readFileSync(path.join(ROOT, relative), 'utf8').trimEnd();
  const [head, ...body] = text.split('\n');
  const keys = head.split(',');
  return body.filter((line) => line.trim() !== '').map((line) => {
    const values = line.split(',');
    return Object.fromEntries(keys.map((key, i) => [key, (values[i] || '').trim()]));
  });
}

/** The matrix as CSV text: `kind` separating the plugin and standalone-skill tracks. */
function renderMatrix() {
  const lines = [`kind,id,${COLUMNS.join(',')}`];
  const rows = [
    ...CATALOG.plugins.map((record) => ({ kind: 'plugin', id: record.id, pick: (c) => cellVersion(record, c) })),
    ...SKILLS.skills.map((record) => ({ kind: 'skill', id: record.id, pick: (c) => skillCellVersion(record, c) })),
  ];
  for (const row of rows) {
    lines.push([row.kind, row.id, ...COLUMNS.map((c) => row.pick(c) || '')].join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Catalog row vs its publishing CSV row. Each field named here is one the build
 * or the workflow reads, so a mismatch means the committed manifest and the
 * published bytes describe different commits.
 */
function compareRows(catalogRows, csvRows, csvName, field, errors) {
  const byId = new Map(csvRows.map((row) => [row[field], row]));
  const ids = new Set(catalogRows.map((row) => row.id));
  for (const id of byId.keys()) {
    if (!ids.has(id)) errors.push(`${csvName}: row "${id}" has no catalog record`);
  }
  for (const record of catalogRows) {
    const row = byId.get(record.id);
    if (!row) {
      errors.push(`${csvName}: catalog record "${record.id}" has no row`);
      continue;
    }
    const want = record.__csv;
    for (const [column, expected] of Object.entries(want)) {
      if (String(row[column] || '') !== String(expected)) {
        errors.push(`${csvName}: ${record.id}.${column} is ${JSON.stringify(row[column])} but the catalog says ${JSON.stringify(expected)}`);
      }
    }
  }
}

function main() {
  const errors = [...validatePluginCatalog().errors, ...validateSkillCatalog().errors];
  if (errors.length) {
    console.error(`catalogs invalid; refusing to write the matrix:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }

  const pluginRecords = CATALOG.plugins.map((p) => ({
    id: p.id,
    __csv: {
      repo: p.upstream.url || `https://github.com/${p.upstream.repository}.git`,
      commit: p.upstream.commit,
      version: p.bundle.version,
      version_source: p.upstream.versionSource,
      image: p.bundle.image,
      dockerfile: p.bundle.dockerfile,
    },
  }));
  const skillRecords = SKILLS.skills.map((s) => ({
    id: s.id,
    __csv: {
      repo: s.upstream.url,
      commit: s.upstream.commit,
      version: s.artifact.version,
      version_source: s.upstream.versionSource,
      image: s.artifact.image,
      dockerfile: s.artifact.dockerfile,
      skill_path: s.artifact.skillPath,
    },
  }));

  compareRows(pluginRecords, readCsv(PLUGIN_CSV), PLUGIN_CSV, 'plugin', errors);
  compareRows(skillRecords, readCsv(SKILL_CSV), SKILL_CSV, 'skill', errors);
  if (errors.length) {
    console.error(`${PLUGIN_CSV} / ${SKILL_CSV} disagree with the catalogs:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }

  writeMatrix();
  if (STORE) return mirrorStore();
}

function writeMatrix() {
  const text = renderMatrix();
  const absolute = path.join(ROOT, MATRIX_PATH);
  const onDisk = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
  if (onDisk === text) {
    console.log(`${MATRIX_PATH} is in date with the catalogs (${COLUMNS.length} columns)`);
    return;
  }
  if (CHECK) {
    console.error(`${MATRIX_PATH} does not match the catalogs.\n--- expected\n${text}--- found\n${onDisk || '(absent)'}`);
    console.error('\nrun: node scripts/seed-plugin-catalog.js');
    process.exit(1);
  }
  fs.writeFileSync(absolute, text);
  console.log(`wrote ${MATRIX_PATH}`);
}

/**
 * One store doc per catalog record, `kind` added so the two tracks stay
 * distinguishable in a single collection. The whole record is mirrored rather
 * than a summary: versions, icon.href, the skills list, the Docker steps a
 * runtime image needs, and the prompt append are exactly what the console
 * renders, and a projection that drops a field is a field the UI cannot show
 * until someone edits this script.
 *
 * `tags` are the AgentCard types each pack surfaces on
 * (registry/agent-card-tags.json), so the mirrored doc says which agent card
 * should show it without a second lookup.
 *
 * `upsertPlugin` is content-compared, so re-seeding on every boot reports
 * `0 changed` instead of bumping every revision.
 */
async function mirrorStore() {
  const store = require(path.join(ROOT, 'packages/shared-core/src/store'));
  const { tags: cardTags } = registry('agent-card-tags.json');
  await store.initStore();
  const records = [
    ...CATALOG.plugins.map((record) => ({ ...record, kind: 'plugin', tags: cardTags[record.id] || [] })),
    ...SKILLS.skills.map((record) => ({ ...record, kind: 'skill', tags: cardTags[record.id] || [] })),
  ];
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) {
      console.error(`catalog ids must be unique across both tracks: "${record.id}" repeats`);
      process.exit(1);
    }
    ids.add(record.id);
  }
  const before = new Map(store.listPlugins().map((row) => [row.id, row]));
  let changed = 0;
  for (const record of records) {
    const written = store.upsertPlugin(record);
    const previous = before.get(record.id);
    if (!previous || previous.revision !== written.revision) changed += 1;
  }
  const stale = [...before.keys()].filter((id) => !ids.has(id));
  for (const id of stale) store.removePlugin(id);
  console.log(
    `${STORE_LABEL}: ${records.length} record(s), ${changed} changed, ${stale.length} removed`,
  );
  if (CHECK && (changed || stale.length)) {
    console.error('--store --check: the store mirror is not in date with the catalogs');
    process.exit(1);
  }
}

const STORE_LABEL = process.env.STORE_BACKEND === 'firestore' ? 'firestore plugins' : 'store plugins';

Promise.resolve(main()).catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

