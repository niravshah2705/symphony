'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { readPlugin, readVendoredSkill, resolvePluginDir, inferHookEvent } = require('./native-reader');

const FIXTURE_MP = path.join(__dirname, '__fixtures__', 'marketplace');
const VENDORED = path.join(__dirname, '__fixtures__', 'vendored-skills');

const SEL = {
  name: 'security',
  marketplace: 'test-marketplace',
  version: '1.6.2',
  ref: 'abc1234',
  sourceRepo: 'test/marketplace',
  sourceUrl: null,
};

test('resolvePluginDir finds a plugin via the marketplace manifest', () => {
  const dir = resolvePluginDir(FIXTURE_MP, 'security');
  assert.ok(dir && dir.endsWith(path.join('plugins', 'security')));
  assert.equal(resolvePluginDir(FIXTURE_MP, 'does-not-exist'), null);
});

test('readPlugin discovers version, skills, hooks, mcp, agents, commands', () => {
  const rec = readPlugin(FIXTURE_MP, SEL);
  assert.equal(rec.kind, 'plugin');
  assert.equal(rec.name, 'security');
  assert.equal(rec.version, '1.6.2'); // taken from plugin.json
  assert.equal(rec.incomplete, false);

  const skillNames = rec.provides.skills.map((s) => s.name).sort();
  assert.deepEqual(skillNames, ['raven', 'tribal-knowledge']);
  const raven = rec.provides.skills.find((s) => s.name === 'raven');
  assert.deepEqual(raven.capabilities.allowedTools, ['Bash', 'Read', 'Grep']);
  assert.equal(raven.parentPlugin, 'plugin:security@test-marketplace');

  // hooks: one from the hooks/ dir (post) + one from plugin.json map (pre)
  const events = rec.provides.hooks.map((h) => h.event).sort();
  assert.ok(events.includes('post'));
  assert.ok(events.includes('pre'));

  // mcp descriptor sanitized — env + headers stripped
  assert.equal(rec.provides.mcpServers.length, 1);
  const mcp = rec.provides.mcpServers[0];
  assert.equal(mcp.name, 'security-scanner');
  assert.equal('env' in mcp.descriptor, false);
  assert.equal('headers' in mcp.descriptor, false);
  assert.deepEqual(mcp.descriptor.args, ['-y', '@test/scanner@1.0.0']);

  assert.deepEqual(rec.provides.agents, ['reviewer']);
  assert.deepEqual(rec.provides.commands, ['scan']);
});

test('readPlugin marks a missing plugin dir incomplete without throwing', () => {
  const rec = readPlugin(FIXTURE_MP, { ...SEL, name: 'ghost' });
  assert.equal(rec.incomplete, true);
  assert.equal(rec.sourceDir, null);
  assert.equal(rec.version, '1.6.2'); // falls back to selection version
});

test('readVendoredSkill parses SKILL.md frontmatter', () => {
  const rec = readVendoredSkill(VENDORED, 'web-research');
  assert.equal(rec.kind, 'skill');
  assert.equal(rec.name, 'web-research');
  assert.match(rec.description, /current, real-world/);
  assert.equal(rec.incomplete, false);
  assert.equal(rec.marketplace, null);
});

test('inferHookEvent maps pre/post-ish labels', () => {
  assert.equal(inferHookEvent('PreToolUse'), 'pre');
  assert.equal(inferHookEvent('post-commit-scan'), 'post');
  assert.equal(inferHookEvent('Stop'), 'post');
  assert.equal(inferHookEvent('whatever'), null);
});
