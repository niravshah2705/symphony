#!/usr/bin/env node
'use strict';

/*
 * Obfuscate the SPA's client-side JavaScript before it is published.
 *
 * The SPA in `public/` ships to browsers verbatim — Firebase Hosting
 * (.github/workflows/deploy.yml → `deploy-spa`) and the GCS bucket
 * (cloudbuild.yaml → `spa-publish`) both serve the raw `public/js/**` files.
 * This step rewrites those files with `javascript-obfuscator` so the released
 * bundle is not human-readable, without touching the source in git.
 *
 * CRITICAL constraint — this is a *native* ES-module SPA with NO bundler:
 * `<script type="module" src="/js/app.js">` and the files `import` each other
 * by relative/absolute specifier. So the obfuscation MUST preserve:
 *   - file names + directory layout (import specifiers like './api.js' resolve
 *     to real files),
 *   - exported binding names (`renameGlobals: false` → importers still resolve
 *     `import { api } from './api.js'`),
 *   - property names (`renameProperties: false` → DOM APIs and data fields such
 *     as `.name`, `.dataset`, `.map` keep working).
 * Only function-local identifiers and string literals are scrambled.
 *
 * Usage:
 *   node scripts/obfuscate-spa.js                      # → dist/spa-obfuscated/ (safe copy)
 *   node scripts/obfuscate-spa.js --in-place           # rewrite public/js/** in place (CI)
 *   node scripts/obfuscate-spa.js --strength maximum   # pick a preset (light|balanced|maximum)
 *   node scripts/obfuscate-spa.js --src public --out build/spa
 *
 * `--in-place` mutates the working tree and is intended for the ephemeral CI
 * checkout. Run without it locally — the default writes an obfuscated copy to
 * `dist/spa-obfuscated/` and never clobbers your source.
 *
 * Strength is chosen by (highest precedence first): the `--strength` flag, the
 * `SPA_OBFUSCATION_STRENGTH` env var, then the `balanced` default.
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const REPO_ROOT = path.resolve(__dirname, '..');

// --- Configuration -----------------------------------------------------------

// Only files under this subdirectory of the SPA root are obfuscated. Everything
// else in `public/` (index.html, styles.css, config.js, vendor/) is copied
// verbatim: config.js is a generated one-liner the deploy step overwrites, and
// vendor/ is the pre-minified third-party Firebase SDK.
const JS_SUBDIR = 'js';
const OBFUSCATABLE_EXTENSIONS = Object.freeze(['.js', '.mjs']);
const DEFAULT_SRC = path.join(REPO_ROOT, 'public');
const DEFAULT_OUT = path.join(REPO_ROOT, 'dist', 'spa-obfuscated');

const DEFAULT_STRENGTH = 'balanced';
const STRENGTH_ENV_VAR = 'SPA_OBFUSCATION_STRENGTH';

// Shared, load-bearing base for every preset. The two `rename*: false` flags are
// NON-NEGOTIABLE for this bundler-free native-ESM SPA (see the header): flipping
// them renames exported bindings / DOM+data property names and breaks the module
// graph and DOM access. All presets extend this and never override these flags.
const BASE_OPTIONS = Object.freeze({
  compact: true,
  target: 'browser',
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false, // load-bearing: keep ES-module export/import bindings
  renameProperties: false, // load-bearing: keep DOM + data property names
  transformObjectKeys: false, // object keys double as DOM attrs / API fields
  disableConsoleOutput: false,
  sourceMap: false,
});

// Selectable strength presets, weakest → strongest. Trade-offs:
//   light    — rename locals only; strings stay clear-text. ~1.1x, negligible cost.
//   balanced — + string-array encoding; no control-flow flattening. ~1.5x. (default)
//   maximum  — + control-flow flattening, dead-code injection, self-defending.
//              ~2.5–4x and a real runtime slowdown; strongest deterrent.
// `debugProtection` stays OFF everywhere — it breaks legitimate devtools use.
const PRESETS = Object.freeze({
  light: Object.freeze({
    ...BASE_OPTIONS,
    stringArray: false,
    numbersToExpressions: false,
    simplify: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    selfDefending: false,
    debugProtection: false,
  }),
  balanced: Object.freeze({
    ...BASE_OPTIONS,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    splitStrings: true,
    splitStringsChunkLength: 10,
    numbersToExpressions: true,
    simplify: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    selfDefending: false,
    debugProtection: false,
  }),
  maximum: Object.freeze({
    ...BASE_OPTIONS,
    stringArray: true,
    stringArrayEncoding: ['rc4'],
    stringArrayThreshold: 1,
    stringArrayWrappersCount: 2,
    stringArrayWrappersType: 'function',
    splitStrings: true,
    splitStringsChunkLength: 8,
    numbersToExpressions: true,
    simplify: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    selfDefending: true,
    debugProtection: false,
  }),
});

// --- Pure helpers ------------------------------------------------------------

/**
 * Resolve which preset to use: explicit arg → env var → default. Validates the
 * name at the boundary and fails fast with the valid options.
 * @param {string} [explicit] value from the `--strength` flag
 * @returns {string} a valid key of PRESETS
 */
function resolveStrength(explicit) {
  const name = explicit || process.env[STRENGTH_ENV_VAR] || DEFAULT_STRENGTH;
  if (!Object.prototype.hasOwnProperty.call(PRESETS, name)) {
    throw new Error(`Unknown obfuscation strength '${name}'. Valid presets: ${Object.keys(PRESETS).join(', ')}.`);
  }
  return name;
}

/**
 * Recursively collect obfuscatable JS files under `dir`.
 * @param {string} dir absolute directory to walk
 * @returns {string[]} absolute file paths (a new array; input is not mutated)
 */
function collectJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectJsFiles(full);
    if (!entry.isFile()) return [];
    return OBFUSCATABLE_EXTENSIONS.includes(path.extname(entry.name)) ? [full] : [];
  });
}

/**
 * Obfuscate a single source string. Throws (never returns partial output) so a
 * failure fails the build instead of shipping readable code.
 * @param {string} code
 * @param {string} label file label for error context
 * @param {object} options javascript-obfuscator options (a PRESETS entry)
 * @returns {string}
 */
function obfuscateCode(code, label, options) {
  try {
    return JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to obfuscate ${label}: ${reason}`);
  }
}

// --- Effects -----------------------------------------------------------------

/**
 * Obfuscate one file, writing the result to `destPath`.
 * @returns {{ bytesIn: number, bytesOut: number }}
 */
function obfuscateFile(srcPath, destPath, label, options) {
  const source = fs.readFileSync(srcPath, 'utf8');
  const obfuscated = obfuscateCode(source, label, options);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, obfuscated, 'utf8');
  return { bytesIn: Buffer.byteLength(source), bytesOut: Buffer.byteLength(obfuscated) };
}

/**
 * Obfuscate every JS file under `<root>/js`, writing results into `outRoot`
 * (which may equal `srcRoot` for in-place mode).
 * @param {{ srcRoot: string, outRoot: string, options: object }} opts
 * @returns {{ files: number, bytesIn: number, bytesOut: number }}
 */
function obfuscateTree({ srcRoot, outRoot, options }) {
  const jsDir = path.join(srcRoot, JS_SUBDIR);
  const files = collectJsFiles(jsDir);
  if (files.length === 0) {
    throw new Error(`No .js/.mjs files found under ${jsDir} — nothing to obfuscate.`);
  }

  return files.reduce(
    (acc, srcPath) => {
      const rel = path.relative(srcRoot, srcPath);
      const destPath = path.join(outRoot, rel);
      const { bytesIn, bytesOut } = obfuscateFile(srcPath, destPath, rel, options);
      return { files: acc.files + 1, bytesIn: acc.bytesIn + bytesIn, bytesOut: acc.bytesOut + bytesOut };
    },
    { files: 0, bytesIn: 0, bytesOut: 0 }
  );
}

/**
 * Full run: prepare the output tree (copy everything verbatim, then overwrite
 * the JS files with obfuscated versions) and report a summary.
 * @param {{ src: string, out: string, inPlace: boolean, strength?: string }} opts
 */
function run({ src, out, inPlace, strength }) {
  if (!fs.existsSync(path.join(src, JS_SUBDIR))) {
    throw new Error(`SPA source ${src} has no ${JS_SUBDIR}/ directory.`);
  }

  const strengthName = resolveStrength(strength);
  const options = PRESETS[strengthName];

  const outRoot = inPlace ? src : out;
  if (!inPlace) {
    // Mirror the whole SPA (html/css/config.js/vendor) so the output dir is a
    // complete, deployable site; the JS files are overwritten in place below.
    fs.rmSync(outRoot, { recursive: true, force: true });
    fs.cpSync(src, outRoot, { recursive: true });
  }

  const summary = obfuscateTree({ srcRoot: inPlace ? src : outRoot, outRoot, options });
  const mode = inPlace ? 'in place' : `→ ${path.relative(REPO_ROOT, outRoot) || outRoot}`;
  const ratio = summary.bytesIn ? (summary.bytesOut / summary.bytesIn).toFixed(2) : '0';
  process.stdout.write(
    `Obfuscated ${summary.files} SPA JS file(s) [${strengthName}] ${mode} ` +
      `(${summary.bytesIn} → ${summary.bytesOut} bytes, ${ratio}x)\n`
  );
  return { ...summary, strength: strengthName };
}

/**
 * @param {string[]} argv process args after `node script.js`
 * @returns {{ src: string, out: string, inPlace: boolean, strength?: string }}
 */
function parseArgs(argv) {
  let src = DEFAULT_SRC;
  let out = DEFAULT_OUT;
  let inPlace = false;
  let strength;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--in-place') inPlace = true;
    else if (arg === '--src') src = path.resolve(argv[(i += 1)]);
    else if (arg === '--out') out = path.resolve(argv[(i += 1)]);
    else if (arg === '--strength') strength = argv[(i += 1)];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { src, out, inPlace, strength };
}

// --- CLI ---------------------------------------------------------------------

if (require.main === module) {
  try {
    run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`obfuscate-spa: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  collectJsFiles,
  obfuscateCode,
  obfuscateTree,
  run,
  parseArgs,
  resolveStrength,
  PRESETS,
  DEFAULT_STRENGTH,
  STRENGTH_ENV_VAR,
};
