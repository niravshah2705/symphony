'use strict';

/**
 * AgentCard tags drift gate: the map must reference only published packs and
 * only real agent card ids. A tag naming a pack that does not exist would
 * mirror a Firestore row nobody can publish; a tag naming an agent id that was
 * renamed away would make the designer say "shown on Planning Agent" about a
 * card that no longer exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CATALOG } = require('./plugin-catalog');
const { SKILLS } = require('./skill-catalog');
const { DEFAULT_AGENT_PROFILES } = require('../../workflow-defaults');
const { tags } = require('./agent-card-tags.json');

test('every AgentCard tag key names a published pack', () => {
  const packIds = new Set([
    ...CATALOG.plugins.map((record) => record.id),
    ...SKILLS.skills.map((record) => record.id),
  ]);
  for (const id of Object.keys(tags)) {
    assert.ok(packIds.has(id), `agent-card-tags.json names an unknown pack: ${id}`);
  }
});

test('every AgentCard tag value names a real agent card', () => {
  const cardIds = new Set(DEFAULT_AGENT_PROFILES.map((profile) => profile.id));
  for (const [pack, list] of Object.entries(tags)) {
    assert.ok(Array.isArray(list) && list.length, `${pack} needs at least one agent card tag`);
    assert.deepEqual(list, [...new Set(list)], `${pack} has duplicate tags`);
    for (const card of list) {
      assert.ok(cardIds.has(card), `${pack} tags an unknown agent card: ${card}`);
    }
  }
});

test('the global catalog carries the tags through', () => {
  const { globalCatalog } = require('../global-catalog');
  const catalog = globalCatalog();
  for (const record of [...catalog.plugins, ...catalog.skills]) {
    assert.deepEqual(record.tags, tags[record.id] || [], `${record.id} tags do not match the map`);
  }
});
