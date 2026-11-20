import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// The guest experience reads copy from three places at once: the catalogue the
// gateway serves (packages/shared-core/src/agent/guest-demo/catalog.js), the
// dictionary the SPA translates with (public/js/i18n.js), and the static dialog
// markup (public/index.html, which must be readable before any fetch resolves).
// All three have to say the same thing, so this test is the seam: it pins the
// English dictionary against the server's strings and requires every key in each
// hand-maintained locale.

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const { GUEST_DEMO } = require(path.join(ROOT, 'packages/shared-core/src/agent/guest-demo/catalog.js'));

const LOCALES = ['en', 'gu', 'hi', 'mr'];

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * i18n.js cannot be imported in Node — it pulls in api.js, which imports
 * /config.js by absolute URL. The dictionary is a plain object literal, so it is
 * evaluated out of the source instead; a shape change fails loudly rather than
 * silently testing nothing.
 */
function dictionaries() {
  const source = read('public/js/i18n.js');
  const marker = 'const MESSAGES = Object.freeze({';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'public/js/i18n.js no longer declares MESSAGES the way this test reads it');
  const body = source.slice(start + marker.length - 1);
  const end = body.indexOf('\n});');
  assert.notEqual(end, -1, 'the MESSAGES literal is not closed where this test expects');
  const evaluated = Function(`"use strict"; return (${body.slice(0, end + 2)});`)();
  for (const locale of LOCALES) {
    assert.ok(evaluated[locale], `the ${locale} dictionary is missing from public/js/i18n.js`);
  }
  return evaluated;
}

const MESSAGES = dictionaries();

/** Every literal `t('guest…', …)` call, `data-i18n="guest…"` attribute, and runner `labelKey`. */
function spaGuestKeys() {
  // The runner is scanned too: a terminal step it names with a literal labelKey
  // is copy the browser has to have, and nothing else would notice a miss.
  const files = ['public/js/views/agent.js', 'public/index.html', 'public/js/guest-onboarding.mjs', 'services/gateway/src/guest-demo-runner.js'];
  const keys = new Set();
  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(/\bt\('(guest[A-Za-z0-9]+)'/g)) keys.add(match[1]);
    for (const match of source.matchAll(/i18n:\s*'(guest[A-Za-z0-9]+)'/g)) keys.add(match[1]);
    for (const match of source.matchAll(/data-i18n="(guest[A-Za-z0-9]+)"/g)) keys.add(match[1]);
    for (const match of source.matchAll(/labelKey: '(guest[A-Za-z0-9]+)'/g)) keys.add(match[1]);
  }
  return [...keys].sort();
}

/** The keys and English strings the server owns, from the one catalogue. */
function catalogueCopy() {
  const copy = new Map();
  copy.set(GUEST_DEMO.echoKey, GUEST_DEMO.echo);
  for (const [field, value] of Object.entries(GUEST_DEMO.notice)) {
    if (!field.endsWith('Key')) continue;
    copy.set(value, GUEST_DEMO.notice[field.slice(0, -3)]);
  }
  for (const command of GUEST_DEMO.commands) copy.set(command.labelKey, command.labelFallback);
  for (const node of Object.values(GUEST_DEMO.nodes)) {
    copy.set(node.questionKey, node.questionFallback);
    for (const answer of node.answers) copy.set(answer.labelKey, answer.labelFallback);
  }
  for (const flow of Object.values(GUEST_DEMO.flows)) {
    for (const step of flow.steps) copy.set(step.labelKey, step.labelFallback);
  }
  return copy;
}

function placeholders(value) {
  return [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort();
}

test('every guest key the SPA names is in every hand-maintained dictionary', () => {
  const keys = spaGuestKeys();
  assert.ok(keys.length > 40, `only ${keys.length} guest keys were found — the scan is not matching`);
  const missing = keys.filter((key) => LOCALES.some((locale) => typeof MESSAGES[locale][key] !== 'string'));
  assert.deepEqual(missing.map((key) => [key, LOCALES.filter((locale) => typeof MESSAGES[locale][key] !== 'string')]), [],
    'a guest key is untranslated or absent (machine translation is a fallback, not the plan)');
});

test('no guest dictionary entry is blank', () => {
  const blank = [];
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(MESSAGES[locale])) {
      if (!key.startsWith('guest')) continue;
      if (typeof value !== 'string' || !value.trim()) blank.push(`${locale}.${key}`);
    }
  }
  assert.deepEqual(blank, []);
});

test('the English guest copy equals what the gateway serves', () => {
  const copy = catalogueCopy();
  assert.ok(copy.size > 45, `the catalogue walk found only ${copy.size} keys — it has stopped covering the tree`);
  const drift = [];
  for (const [key, served] of copy) {
    if (MESSAGES.en[key] !== served) drift.push({ key, served, dictionary: MESSAGES.en[key] });
  }
  assert.deepEqual(drift, [], 'the dictionary and the catalogue disagree, so t(key, label) shows one and the transcript stores another');
});

test('the catalogue names no key the dictionaries do not carry', () => {
  const absent = [...catalogueCopy().keys()].filter((key) => LOCALES.some((locale) => !(key in MESSAGES[locale])));
  assert.deepEqual(absent, []);
});

test('a translated guest string keeps every placeholder its English has', () => {
  const broken = [];
  for (const key of Object.keys(MESSAGES.en)) {
    if (!key.startsWith('guest')) continue;
    const expected = placeholders(MESSAGES.en[key]);
    if (!expected.length) continue;
    for (const locale of LOCALES.slice(1)) {
      const value = MESSAGES[locale][key];
      if (typeof value !== 'string') continue;
      if (placeholders(value).join() !== expected.join()) broken.push(`${locale}.${key}: ${placeholders(value)} vs ${expected}`);
    }
  }
  assert.deepEqual(broken, [], 't() leaves an unfilled {token} visible in the UI');
});

test('only the retention sentences carry {days}, because only the server renders them', () => {
  const numbered = Object.entries(MESSAGES.en)
    .filter(([key, value]) => key.startsWith('guest') && placeholders(value).includes('days'))
    .map(([key]) => key)
    .sort();
  // Any other string that starts quoting a number must be interpolated by the
  // runner as well, or GUEST_DEMO_PREVIEW_TTL_MS and the copy will diverge.
  assert.deepEqual(numbered, ['guestDemoStepLiveUrl', 'guestPreviewExpiryNotice']);
});

test('the retention sentence the catalogue ships is the one the runner renders', () => {
  assert.match(GUEST_DEMO.notice.retention, /\{days\}/,
    'the notice must quote the configured window, not a hard-coded day count');
  assert.match(GUEST_DEMO.notice.retrievability, /cannot be retrieved/,
    'the footer promises non-retrievability; §9 of the guest notice depends on that wording');
});
