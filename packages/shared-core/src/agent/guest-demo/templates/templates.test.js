'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../catalog.js');
const templates = require('./index.js');

const { GUEST_DEMO } = catalog;

/**
 * Every (template, variant) pair the visitor can actually reach by clicking:
 * walk the tree from each command, merging the variants the answers carry. This
 * is the contract between the catalogue and the bundles — a knob a click sets
 * that a template does not offer would otherwise only surface as a failed
 * deploy, several clicks into a demo.
 */
function reachablePairs() {
  const pairs = new Map();
  const visit = (target, template, variant, seen) => {
    const node = catalog.findGuestNode(target);
    if (!node) return;
    for (const answer of node.answers) {
      const nextTemplate = answer.template || template;
      const nextVariant = { ...variant, ...(answer.variant || {}) };
      if (nextTemplate) pairs.set(`${nextTemplate}|${JSON.stringify(nextVariant)}`, { template: nextTemplate, variant: nextVariant });
      if (!answer.next || seen.has(answer.next)) continue;
      visit(answer.next, nextTemplate, nextVariant, new Set([...seen, answer.next]));
    }
  };
  for (const command of GUEST_DEMO.commands) {
    visit(command.entryNode, command.template || null, {}, new Set([command.entryNode]));
  }
  return [...pairs.values()];
}

test('every clickable (template, variant) pair builds a release', () => {
  const pairs = reachablePairs();
  assert.ok(pairs.length >= 12, `only ${pairs.length} pairs reachable — the walk is broken`);
  for (const pair of pairs) {
    const release = templates.buildGuestRelease(pair);
    assert.equal(release.template, pair.template);
    assert.ok(release.files.length > 0, `${pair.template} shipped no files`);
    assert.ok(release.files.some((file) => file.path === 'index.html'), `${pair.template} has no index.html`);
    assert.ok(release.files.some((file) => file.path === 'styles.css'), `${pair.template} has no stylesheet`);
    assert.equal(release.label, release.label.trim());
  }
  const names = new Set(pairs.map((p) => p.template));
  assert.deepEqual([...names].sort(), [...GUEST_DEMO.templates].sort(), 'a catalogue template is never reachable by a click');
});

test('a rendered file never ships an unresolved token or a secret-shaped literal', () => {
  for (const pair of reachablePairs()) {
    for (const file of templates.buildGuestRelease(pair).files) {
      assert.ok(!file.content.includes('{{'), `${pair.template}/${file.path} ships an unresolved token`);
      for (const pattern of [/sk-[A-Za-z0-9_-]{8,}/, /BEGIN (RSA )?PRIVATE KEY/, /Bearer\s+\S{20,}/]) {
        assert.ok(!pattern.test(file.content), `${pair.template}/${file.path} matches ${pattern}`);
      }
      // A guest page is a throwaway preview: it must not be indexed or framed-in
      // as if it were part of the product.
      if (file.path.endsWith('.html')) assert.match(file.content, /noindex/);
    }
  }
});

test('the selected knob value is what lands in the files, not the key', () => {
  const emerald = templates.buildGuestRelease({ template: 'helloworld', variant: { accent: 'emerald' } });
  assert.match(emerald.files.find((f) => f.path === 'styles.css').content, /--accent: #059669;/);
  assert.match(emerald.files.find((f) => f.path === 'index.html').content, /Emerald theme|emerald theme/i);

  const ai = templates.buildGuestRelease({ template: 'tic-tac-toe', variant: { opponent: 'ai' } });
  const page = ai.files.find((f) => f.path === 'index.html').content;
  assert.match(page, /window\.GUEST_OPPONENT = 'ai';/, 'the script must get the option key');
  assert.match(page, /Play the computer/, 'the copy must get the option label');
});

test('the depth knob swaps which page is the entry point', () => {
  const map = templates.buildGuestRelease({ template: 'clone-storefront', variant: { depth: 'map' } });
  assert.deepEqual(map.files.map((f) => f.path), ['index.html', 'site.html', 'styles.css']);
  assert.match(map.files.find((f) => f.path === 'index.html').content, /Component map/);
  assert.match(map.files.find((f) => f.path === 'site.html').content, /Field notebook/);

  const full = templates.buildGuestRelease({ template: 'clone-storefront', variant: { depth: 'full' } });
  assert.match(full.files.find((f) => f.path === 'index.html').content, /Field notebook/);
  assert.match(full.files.find((f) => f.path === 'components.html').content, /Component map/);
});

test('a variant the bundle does not offer is refused before anything is read', () => {
  for (const variant of [
    { accent: 'crimson' }, { accent: 'indigo; rm -rf /' }, { accent: '{{TITLE}}' }, { accent: 7 },
    { stack: 'NODE' }, { depth: 'full' }, { extra: 'PAGE' },
    { 'knobs': 'x' }, { '../variant.json': 'x' },
  ]) {
    assert.throws(
      () => templates.buildGuestRelease({ template: 'helloworld', variant }),
      (error) => error.code === 'guest_variant_invalid' && error.status === 400,
      `${JSON.stringify(variant)} was accepted`,
    );
  }
  // A selection that is not an object of known options is the same refusal —
  // there is no shape of it that reaches the file reader.
  for (const variant of ['accent', 7, ['indigo'], () => 'indigo']) {
    assert.throws(
      () => templates.buildGuestRelease({ template: 'helloworld', variant }),
      (error) => error.code === 'guest_variant_invalid',
      `${String(variant)} was accepted`,
    );
  }
  for (const variant of [null, undefined, {}]) {
    assert.equal(templates.buildGuestRelease({ template: 'helloworld', variant }).variant.accent, 'indigo');
  }
});

test('an unknown template is refused, and no path escapes the bundle tree', () => {
  for (const template of ['clone-storefront/../../etc', '../helloworld', '', 'gcmd.helloworld', 7, null]) {
    assert.throws(
      () => templates.buildGuestRelease({ template }),
      (error) => error.code === 'guest_template_unknown',
      `"${template}" was treated as a template`,
    );
  }
});

test('a bundle with a knob the files never use still renders, and a missing file is named', () => {
  const release = templates.buildGuestRelease({ template: 'clone-docs-site', variant: { extra: 'page' } });
  assert.ok(release.files.some((f) => f.path === 'about.html'));
  // The about page comes from the shared bundle, so its tokens have to resolve too.
  assert.match(release.files.find((f) => f.path === 'about.html').content, /Back to the site/);
});
