'use strict';

/**
 * Model-family registry drift gate. registry/model-families.json is now the only
 * copy of this vocabulary — the arrays that used to live in the server model,
 * its browser mirror, the preset→family map and the card icon map are gone — so
 * everything those four files used to guarantee by construction has to be
 * asserted here:
 *
 *  - ids are usable names and unique (they land in a CR label and a select value);
 *  - every family can be rendered (label + an icon the browser actually ships);
 *  - every LLM preset provider belongs to exactly one family, which is what the
 *    removed PRESET_FAMILIES map silently promised;
 *  - validation stays permissive about a family the file no longer lists, so
 *    deleting a row cannot rewrite `modelFamily` out of saved graphs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { load, modelFamilies, modelFamilyProblems, normalizeModelFamily, familyForProvider } = require('../model-families.js');
const presets = require('../llm-presets.json').presets;

// public/js/icons.js is the browser's icon set; a family naming anything else
// would render an empty pill on the card.
const SHIPPED_ICONS = fs.readFileSync(path.join(__dirname, '../../../../../public/js/icons.js'), 'utf8');

test('the shipped family registry parses clean and is sorted for display', () => {
  assert.deepEqual(modelFamilyProblems(), [], 'registry/model-families.json has parse or record problems');
  const families = modelFamilies();
  assert.ok(families.length >= 7, 'the designer would offer almost no families');
  assert.deepEqual(families.map((family) => family.order), [...families.map((f) => f.order)].sort((a, b) => a - b), 'families must arrive in display order');
});

test('every family is a usable id with a label and a shipped icon', () => {
  const seen = new Set();
  for (const family of modelFamilies()) {
    assert.match(family.id, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, `${family.id} is not a DNS-label id`);
    assert.ok(!seen.has(family.id), `${family.id} is declared twice`);
    seen.add(family.id);
    assert.ok(family.label.length, `${family.id} needs a label`);
    assert.ok(family.icon.length, `${family.id} needs an icon`);
    assert.match(SHIPPED_ICONS, new RegExp(`\\b${family.icon}\\b`), `${family.id} names an icon the browser does not ship: ${family.icon}`);
    assert.deepEqual(family.providers, [...new Set(family.providers)], `${family.id} lists a provider twice`);
    assert.equal(typeof family.enabled, 'boolean');
  }
});

test('every LLM preset provider belongs to exactly one family', () => {
  const claimed = new Map();
  for (const family of modelFamilies()) {
    for (const provider of family.providers) {
      assert.ok(!claimed.has(provider), `provider "${provider}" is claimed by both "${claimed.get(provider)}" and "${family.id}"`);
      claimed.set(provider, family.id);
    }
  }
  for (const preset of presets) {
    const provider = String(preset.provider || '');
    assert.ok(claimed.has(provider), `llm-presets.json ships provider "${provider}" with no model family — the Model dropdown could never list it`);
  }
  for (const provider of claimed.keys()) {
    assert.ok(presets.some((preset) => preset.provider === provider), `family providers name a provider no preset ships: ${provider}`);
  }
});

test('normalizeModelFamily keeps a listed family, an unlisted name, and drops garbage', () => {
  assert.equal(normalizeModelFamily('anthropic'), 'anthropic');
  assert.equal(normalizeModelFamily('  Anthropic  '), 'anthropic');
  // A row someone deleted while a graph still points at it: kept, not wiped.
  assert.equal(normalizeModelFamily('mistral'), 'mistral');
  assert.equal(normalizeModelFamily('Not a family!'), '');
  assert.equal(normalizeModelFamily('a'.repeat(70)), 'a'.repeat(63));
  assert.equal(normalizeModelFamily(undefined), '');
  assert.equal(normalizeModelFamily(''), '');
});

test('familyForProvider resolves the family a preset belongs to', () => {
  assert.equal(familyForProvider('huggingface').id, 'byok');
  assert.equal(familyForProvider('claude').id, 'anthropic');
  assert.equal(familyForProvider('nope'), null);
  assert.equal(familyForProvider(''), null);
});

test('a malformed registry degrades to an empty vocabulary instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-families-'));
  const write = (name, payload) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
    return file;
  };

  const broken = load(write('broken.json', '{ not json'));
  assert.deepEqual(broken.families, []);
  assert.match(broken.problems.join(' '), /not valid JSON/);

  const missing = load(path.join(dir, 'does-not-exist.json'));
  assert.deepEqual(missing.families, []);
  assert.match(missing.problems.join(' '), /could not be read/);

  const shapeless = load(write('shapeless.json', { schemaVersion: 1 }));
  assert.deepEqual(shapeless.families, []);
  assert.match(shapeless.problems.join(' '), /no "families" array/);

  const messy = load(write('messy.json', {
    families: [
      { id: 'byok', label: 'BYOK', providers: ['ollama', 'Bad Provider', 'ollama'], order: 20 },
      { id: 'Not An Id' },
      { id: 'byok', label: 'dupe' },
      { providers: ['x'] },
      { id: 'mystery' },
    ],
  }));
  assert.deepEqual(messy.families.map((family) => family.id), ['byok', 'mystery']);
  assert.deepEqual(messy.families[0].providers, ['ollama'], 'a bad provider is dropped, the record survives');
  assert.equal(messy.families[0].icon, 'byom', 'a record with no icon falls back to the generic one');
  assert.equal(messy.families[1].label, 'mystery', 'a record with no label shows its id');
  assert.equal(messy.families[1].enabled, true);
  assert.deepEqual(messy.families.map((family) => family.order), [20, 50], 'a missing order falls back to the row position');
  assert.equal(messy.problems.length, 4, messy.problems.join(' | '));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a disabled family is still carried, so a saved graph keeps its value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-families-'));
  const file = path.join(dir, 'disabled.json');
  fs.writeFileSync(file, JSON.stringify({ families: [{ id: 'gemini', label: 'Gemini', enabled: false }] }));
  const { families } = load(file);
  assert.equal(families[0].enabled, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
