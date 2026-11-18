import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

// icons.js is a browser ESM module in a CommonJS package (see permissions.test.mjs
// for the same loader): evaluate its source so this stays a unit test without a DOM.
const source = await readFile(new URL('./icons.js', import.meta.url), 'utf8');
const { pluginIconHref } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

const require = createRequire(import.meta.url);
const root = require('node:path').resolve(import.meta.dirname, '../..');
const { CATALOG } = require(require('node:path').join(
  root, 'packages/shared-core/src/agent/registry/plugin-catalog.js'));
const { SKILLS } = require(require('node:path').join(
  root, 'packages/shared-core/src/agent/registry/skill-catalog.js'));

test('a pack id resolves to a same-origin icon path', () => {
  assert.equal(pluginIconHref('code-review-graph'), '/icons/plugins/code-review-graph.svg');
  assert.equal(pluginIconHref('security-audit', 'skill'), '/icons/skills/security-audit.svg');
});

test('an id that could escape its directory, or an unknown kind, returns null', () => {
  for (const id of ['../secrets', 'a/b', '', '-leading', 'Trailing.', 'UPPER', 'with space', 'x'.repeat(64)]) {
    assert.equal(pluginIconHref(id), null, `${JSON.stringify(id)} must not produce a URL`);
  }
  assert.equal(pluginIconHref('ecc', 'marketplace'), null);
});

test('every catalog record has an icon this helper would address', () => {
  const records = [
    ...CATALOG.plugins.map((record) => ({ ...record, kind: 'plugin' })),
    ...SKILLS.skills.map((record) => ({ ...record, kind: 'skill' })),
  ];
  for (const record of records) {
    assert.equal(pluginIconHref(record.id, record.kind), record.icon.href,
      `${record.id}: icon.href must be the path pluginIconHref computes`);
  }
});
