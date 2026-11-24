import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..');

/**
 * Each shipped app carries its own theme block, and a `var(--token)` that no
 * stylesheet in that app declares does not error — it computes to nothing, so
 * the property falls back to its initial value. `background` becomes
 * transparent and the page behind the component shows through, which is how a
 * gate dialog once rendered over the canvas. The three apps are checked
 * separately on purpose: `--surface` is real in adlc and meaningless to the
 * SPA, so a shared pool would hide exactly the mistake worth catching.
 */
const APPS = [
  {
    name: 'spa',
    css: [
      'styles.css',
      ...fs.readdirSync(path.join(publicDir, 'styles')).filter((file) => file.endsWith('.css')).sort()
        .map((file) => path.join('styles', file)),
    ],
    html: ['index.html'],
  },
  {
    name: 'adlc',
    css: [
      'tokens.css',
      'base.css',
      'adlc/styles.css',
      ...(fs.existsSync(path.join(publicDir, 'adlc', 'pages')) ? fs.readdirSync(path.join(publicDir, 'adlc', 'pages')).filter((file) => file.endsWith('.css')).sort().map((file) => path.join('adlc', 'pages', file)) : []),
    ],
    html: ['adlc/index.html'],
  },
  { name: 'archagentix', css: ['tokens.css', 'base.css', 'archagentix/styles.css'], html: [] },
];

const DECLARATION = /(--[a-z0-9-]+)\s*:/g;
const REFERENCE = /var\(\s*(--[a-z0-9-]+)\s*(,)?/g;

function readCss(absolute) {
  const text = fs.readFileSync(absolute, 'utf8');
  if (!absolute.endsWith('.html')) return [text];
  return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
}

function collect(app) {
  const blocks = [];
  for (const file of [...app.css, ...app.html]) {
    const absolute = path.join(publicDir, file);
    if (!fs.existsSync(absolute)) continue;
    if (file.endsWith('.html')) {
      readCss(absolute).forEach((style, index) => blocks.push([`${file}#style${index}`, style]));
    } else {
      blocks.push([file, readCss(absolute).join('\n')]);
    }
  }
  const declared = new Set();
  for (const [, block] of blocks) {
    for (const match of block.matchAll(DECLARATION)) declared.add(match[1]);
  }
  const unresolved = [];
  for (const [label, block] of blocks) {
    for (const match of block.matchAll(REFERENCE)) {
      // var(--x, fallback) is safe by construction; a bare var(--x) is not.
      if (!match[2] && !declared.has(match[1])) unresolved.push(`${label}: var(${match[1]})`);
    }
  }
  return { declared, unresolved: [...new Set(unresolved)], filesRead: blocks.length };
}

test('every app declares the theme tokens its stylesheets use', () => {
  for (const app of APPS) {
    const { declared, unresolved, filesRead } = collect(app);
    assert.ok(filesRead > 0, `${app.name}: no stylesheet was found, so this check proves nothing`);
    assert.ok(declared.size > 0, `${app.name}: no theme tokens are declared, so nothing can resolve`);
    assert.deepEqual(unresolved, [],
      `${app.name} reads tokens it never defines. An undefined var(--token) computes to nothing, `
      + 'so the property silently falls back (a background becomes transparent). Define it in that '
      + `app's own theme block — ${unresolved.join(', ')}\n`);
  }
});

test('the SPA theme defines the surface tokens its components paint with', () => {
  const { declared } = collect(APPS[0]);
  for (const token of ['--bg', '--panel', '--panel-2', '--surface-subtle', '--surface-inset', '--panel-sunken', '--code-bg']) {
    assert.ok(declared.has(token), `${token} is gone from the SPA theme`);
  }
  // --surface belongs to the adlc marketing bundle only; the SPA has never
  // defined it, so any rule that reaches for it paints nothing.
  assert.equal(declared.has('--surface'), false,
    '--surface was added to the SPA theme; the SPA already has --panel / --surface-subtle / --surface-inset');
});
