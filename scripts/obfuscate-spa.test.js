'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  run,
  obfuscateCode,
  resolveStrength,
  PRESETS,
  DEFAULT_STRENGTH,
  STRENGTH_ENV_VAR,
} = require('./obfuscate-spa.js');

/** Build a throwaway SPA fixture and return its root dir. */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-obf-'));
  const js = path.join(root, 'js');
  const views = path.join(js, 'views');
  fs.mkdirSync(views, { recursive: true });
  fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });

  // A leaf module with an export, and an importer that consumes it — the cross
  // -module contract we must not break.
  fs.writeFileSync(path.join(js, 'dom.js'), 'export function el(tag) { return { tag }; }\n');
  fs.writeFileSync(
    path.join(views, 'board.js'),
    "import { el } from '../dom.js';\nexport function renderBoard(items) {\n  const secretLabel = 'super-secret-endpoint';\n  return items.map((it) => el(it.name)).concat(secretLabel);\n}\n"
  );
  // A self-contained module we can import and execute to prove runtime equivalence.
  fs.writeFileSync(
    path.join(js, 'pure.mjs'),
    "export function add(a, b) {\n  const tag = 'sum';\n  return { tag, value: a + b };\n}\n"
  );
  fs.writeFileSync(
    path.join(js, 'lazy.mjs'),
    "export async function lazyAdd(a, b) {\n  const { add } = await import('./pure.mjs');\n  return add(a, b);\n}\n"
  );

  // Non-JS + vendor: must be copied verbatim, never obfuscated.
  fs.writeFileSync(
    path.join(root, 'config.js'),
    "window.__API_BASE__ = '';\nwindow.__GA_MEASUREMENT_ID__ = '';\n"
  );
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>fixture</title>\n');
  fs.writeFileSync(path.join(root, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  fs.writeFileSync(path.join(root, 'llms.txt'), '# Fixture AI index\n');
  fs.writeFileSync(path.join(root, 'sitemap.xml'), '<urlset></urlset>\n');
  fs.writeFileSync(path.join(root, 'vendor', 'lib.js'), 'export const VENDOR = 1;\n');
  return root;
}

test('preserves ES-module export/import names while scrambling locals and strings', () => {
  // Arrange
  const src = makeFixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-obf-out-'));

  // Act
  const summary = run({ src, out, inPlace: false, strength: 'balanced' });
  const board = fs.readFileSync(path.join(out, 'js', 'views', 'board.js'), 'utf8');
  const original = fs.readFileSync(path.join(src, 'js', 'views', 'board.js'), 'utf8');

  // Assert — module graph intact
  assert.equal(summary.files, 4, 'obfuscates all four JS/MJS files');
  assert.notEqual(board, original, 'output differs from source');
  assert.match(board, /export function renderBoard/, 'exported name preserved');
  assert.match(board, /import\s*\{\s*el\s*\}\s*from\s*['"]\.\.\/dom\.js['"]/, 'import binding + specifier preserved');
  assert.doesNotMatch(board, /super-secret-endpoint/, 'string literal no longer in clear text');
  assert.doesNotMatch(board, /secretLabel/, 'local identifier renamed');
});

test('copies non-JS assets and vendor code verbatim', () => {
  // Arrange
  const src = makeFixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-obf-out-'));

  // Act
  run({ src, out, inPlace: false });

  // Assert
  assert.equal(
    fs.readFileSync(path.join(out, 'config.js'), 'utf8'),
    "window.__API_BASE__ = '';\nwindow.__GA_MEASUREMENT_ID__ = '';\n"
  );
  assert.equal(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), '<!doctype html><title>fixture</title>\n');
  assert.equal(fs.readFileSync(path.join(out, 'robots.txt'), 'utf8'), 'User-agent: *\nAllow: /\n');
  assert.equal(fs.readFileSync(path.join(out, 'llms.txt'), 'utf8'), '# Fixture AI index\n');
  assert.equal(fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8'), '<urlset></urlset>\n');
  assert.equal(fs.readFileSync(path.join(out, 'vendor', 'lib.js'), 'utf8'), 'export const VENDOR = 1;\n');
});

test('obfuscated module is still executable and behaviourally identical', async () => {
  // Arrange
  const src = makeFixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-obf-out-'));
  run({ src, out, inPlace: false });

  // Act — dynamically import the obfuscated ES module and call its export.
  const mod = await import(path.join(out, 'js', 'pure.mjs'));

  // Assert
  assert.deepEqual(mod.add(2, 3), { tag: 'sum', value: 5 });
});

test('obfuscated build preserves a native dynamic-import module edge', async () => {
  // This mirrors route-level code splitting in the browser: the entry module
  // is obfuscated independently, then resolves another obfuscated file at run
  // time using its unchanged relative specifier.
  const src = makeFixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-obf-dynamic-'));
  run({ src, out, inPlace: false });

  const entry = await import(path.join(out, 'js', 'lazy.mjs'));

  assert.deepEqual(await entry.lazyAdd(20, 22), { tag: 'sum', value: 42 });
});

test('in-place mode rewrites source files without a copy', () => {
  // Arrange
  const src = makeFixture();
  const before = fs.readFileSync(path.join(src, 'js', 'dom.js'), 'utf8');

  // Act
  run({ src, out: src, inPlace: true });
  const after = fs.readFileSync(path.join(src, 'js', 'dom.js'), 'utf8');

  // Assert
  assert.notEqual(after, before, 'file rewritten in place');
  assert.match(after, /export function el/, 'export preserved in place');
});

test('every preset keeps the rename guards off so the module graph cannot break', () => {
  // These two flags are the contract that keeps cross-module imports resolving.
  for (const [name, options] of Object.entries(PRESETS)) {
    assert.equal(options.renameGlobals, false, `${name}.renameGlobals`);
    assert.equal(options.renameProperties, false, `${name}.renameProperties`);
  }
});

test('resolveStrength: flag > env var > default, and rejects unknown names', () => {
  const saved = process.env[STRENGTH_ENV_VAR];
  try {
    delete process.env[STRENGTH_ENV_VAR];
    assert.equal(DEFAULT_STRENGTH, 'light', 'performance-safe preset is the default');
    assert.equal(resolveStrength(), DEFAULT_STRENGTH, 'falls back to default');
    assert.equal(resolveStrength('maximum'), 'maximum', 'explicit flag wins');

    process.env[STRENGTH_ENV_VAR] = 'light';
    assert.equal(resolveStrength(), 'light', 'env var used when no flag');
    assert.equal(resolveStrength('maximum'), 'maximum', 'flag overrides env var');

    assert.throws(() => resolveStrength('turbo'), /Unknown obfuscation strength 'turbo'/);
  } finally {
    if (saved === undefined) delete process.env[STRENGTH_ENV_VAR];
    else process.env[STRENGTH_ENV_VAR] = saved;
  }
});

test('light leaves strings in clear text; balanced and maximum encode them', () => {
  const src = makeFixture();
  const readBoard = (strength) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `spa-obf-${strength}-`));
    run({ src, out, inPlace: false, strength });
    return fs.readFileSync(path.join(out, 'js', 'views', 'board.js'), 'utf8');
  };
  assert.match(readBoard('light'), /super-secret-endpoint/, 'light keeps string literals');
  assert.doesNotMatch(readBoard('balanced'), /super-secret-endpoint/, 'balanced encodes strings');
  assert.doesNotMatch(readBoard('maximum'), /super-secret-endpoint/, 'maximum encodes strings');
});

test('maximum preset still produces an executable, correct module', async () => {
  const src = makeFixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-obf-max-'));
  run({ src, out, inPlace: false, strength: 'maximum' });
  const mod = await import(path.join(out, 'js', 'pure.mjs'));
  assert.deepEqual(mod.add(2, 3), { tag: 'sum', value: 5 });
});

test('obfuscateCode surfaces a labelled error on invalid input', () => {
  assert.throws(() => obfuscateCode('const = = =;', 'broken.js', PRESETS.balanced), /Failed to obfuscate broken\.js/);
});
