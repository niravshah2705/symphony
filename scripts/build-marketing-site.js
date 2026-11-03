#!/usr/bin/env node
'use strict';

// Builds the www.archagentix.com release tree (marketing/) from public/.
//
// The marketing hosting site serves content at the domain root: "/" is the ADLC
// landing page and "/blog/" + "/brief/" are the ADLC sections promoted out of
// "/adlc/". The app site keeps those pages under "/adlc/", so public/adlc/ stays
// the single source in git and this script rewrites the prefix for the www copy.
//
//   node scripts/build-marketing-site.js                 # write marketing/
//   node scripts/build-marketing-site.js --out build/www # alternate output
//   node scripts/build-marketing-site.js --check         # fail if marketing/ is stale

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CANONICAL_ORIGIN = 'https://www.archagentix.com';
const PLATFORM_ORIGIN = 'https://platform.archagentix.com';
const ADLC_DIR = 'adlc';
const COMPANY_PAGES = ['pricing', 'about', 'careers', 'newsroom', 'contact'];
const DISCOVERY_FILES = ['robots.txt', 'llms.txt', 'llms-full.txt'];

// Specific rewrites first; the generic path promotion last.
const REWRITES = [
  // Hash-routed legal pages live in the SPA, which the marketing root no longer serves.
  [CANONICAL_ORIGIN + '/#/', PLATFORM_ORIGIN + '/#/'],
  // A root-scoped service worker must stay limited to its precached pages, or every
  // path on the origin becomes cache-first and never expires.
  ["url.pathname.startsWith('/adlc/')", 'ASSETS.includes(url.pathname)'],
  ["'adlc-landing-v2'", "'archagentix-marketing-v1'"],
  ['/adlc/', '/'],
];

function rewriteText(text) {
  var out = text;
  for (var i = 0; i < REWRITES.length; i += 1) {
    out = out.split(REWRITES[i][0]).join(REWRITES[i][1]);
  }
  return out;
}

// Every marketing file is text; test files never leave the source tree.
function walkFiles(dir, prefix) {
  var rel = prefix === undefined ? '' : prefix;
  var found = [];
  var names = fs.readdirSync(path.join(dir, rel)).sort();
  for (var i = 0; i < names.length; i += 1) {
    var child = rel ? rel + '/' + names[i] : names[i];
    if (fs.statSync(path.join(dir, child)).isDirectory()) {
      found = found.concat(walkFiles(dir, child));
    } else if (!/\.test\.m?js$/.test(names[i])) {
      found.push(child);
    }
  }
  return found;
}

function copyFile(srcDir, outDir, rel) {
  var text = rewriteText(fs.readFileSync(path.join(srcDir, rel), 'utf8'));
  var dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
}
// public/sitemap.xml documents the app tree, where the ADLC pages sit under /adlc/.
// On www those paths are 301 sources, not canonical urls, so the generated copy
// promotes them and drops the /adlc/ entry ("/" is the landing page, already listed).
function buildSitemap(srcDir) {
  var xml = fs.readFileSync(path.join(srcDir, 'sitemap.xml'), 'utf8');
  var open = xml.slice(0, xml.indexOf('<urlset')) + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
  var entries = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
  var seen = {};
  var kept = [];
  for (var i = 0; i < entries.length; i += 1) {
    var loc = entries[i].match(/<loc>([^<]+)<\/loc>/)[1];
    var pathname = new URL(loc).pathname;
    if (pathname === '/adlc' || pathname === '/adlc/') continue;
    var mapped = CANONICAL_ORIGIN + pathname.replace(/^\/adlc\//, '/');
    if (seen[mapped]) continue;
    seen[mapped] = true;
    kept.push('  ' + entries[i].replace(loc, mapped));
  }
  return open + '\n' + kept.join('\n') + '\n</urlset>\n';
}

function sitemapLocs(xml) {
  return (xml.match(/<loc>[^<]+<\/loc>/g) || []).map(function (tag) {
    return tag.slice('<loc>'.length, -'</loc>'.length);
  });
}

// Firebase Hosting only matches a trailing-slash url against a literal index.html,
// so a sitemap entry without one on disk silently serves the wrong document.
function fileForUrl(outDir, loc) {
  var pathname = new URL(loc).pathname;
  return pathname === '/'
    ? path.join(outDir, 'index.html')
    : path.join(outDir, pathname.slice(1), 'index.html');
}
// Fail loudly on anything that would ship a broken www release: a leftover /adlc/
// reference (that path is now a redirect source), a dead www hash route, or a
// sitemap url whose file is missing from the generated tree.
function validateTree(outDir, srcDir) {
  var files = walkFiles(outDir);
  var i;
  for (i = 0; i < files.length; i += 1) {
    var text = fs.readFileSync(path.join(outDir, files[i]), 'utf8');
    if (text.indexOf('/adlc/') !== -1) {
      throw new Error(files[i] + ' still references /adlc/; www serves that path as a 301');
    }
    if (/\.html$/.test(files[i]) && text.indexOf(CANONICAL_ORIGIN + '/#/') !== -1) {
      throw new Error(files[i] + ' still links a www hash route; the SPA is on the platform origin');
    }
  }

  var xml = fs.readFileSync(path.join(outDir, 'sitemap.xml'), 'utf8');
  var locs = sitemapLocs(xml);
  for (i = 0; i < locs.length; i += 1) {
    if (locs[i].indexOf(CANONICAL_ORIGIN + '/') !== 0) {
      throw new Error('sitemap url off the canonical origin: ' + locs[i]);
    }
    if (!fs.existsSync(fileForUrl(outDir, locs[i]))) {
      throw new Error('sitemap url has no file in the marketing tree: ' + locs[i]);
    }
  }

  var sourceLocs = sitemapLocs(fs.readFileSync(path.join(srcDir, 'sitemap.xml'), 'utf8'))
    .filter(function (loc) {
      var pathname = new URL(loc).pathname;
      return pathname !== '/adlc' && pathname !== '/adlc/';
    });
  if (locs.length !== sourceLocs.length) {
    throw new Error('sitemap url count changed during promotion: ' + sourceLocs.length + ' -> ' + locs.length);
  }

  var landing = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  var canonical = (landing.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
  if (canonical !== CANONICAL_ORIGIN + '/') {
    throw new Error('marketing root must self-canonicalise to ' + CANONICAL_ORIGIN + '/, found ' + canonical);
  }
  return files;
}

function buildMarketingSite(options) {
  var settings = options || {};
  var srcDir = settings.srcDir || path.join(ROOT, 'public');
  var outDir = settings.outDir || path.join(ROOT, 'marketing');
  if (!fs.existsSync(srcDir)) throw new Error('missing source directory ' + srcDir);
  if (settings.clean !== false && fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  var adlcDir = path.join(srcDir, ADLC_DIR);
  var promoted = walkFiles(adlcDir);
  for (var i = 0; i < promoted.length; i += 1) copyFile(adlcDir, outDir, promoted[i]);
  for (i = 0; i < COMPANY_PAGES.length; i += 1) copyFile(srcDir, outDir, COMPANY_PAGES[i] + '/index.html');
  for (i = 0; i < DISCOVERY_FILES.length; i += 1) copyFile(srcDir, outDir, DISCOVERY_FILES[i]);
  fs.writeFileSync(path.join(outDir, 'sitemap.xml'), buildSitemap(srcDir));

  return { outDir: outDir, files: validateTree(outDir, srcDir) };
}
// --check rebuilds into a scratch dir and diffs it against marketing/, so a stale
// tree fails locally without mutating the working copy.
function checkFresh(srcDir, outDir) {
  var scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-check-'));
  try {
    var built = buildMarketingSite({ srcDir: srcDir, outDir: scratch });
    var current = fs.existsSync(outDir) ? walkFiles(outDir) : [];
    var drift = [];
    var i;
    for (i = 0; i < built.files.length; i += 1) {
      var rel = built.files[i];
      if (current.indexOf(rel) === -1) {
        drift.push('missing ' + rel);
      } else if (fs.readFileSync(path.join(scratch, rel), 'utf8') !== fs.readFileSync(path.join(outDir, rel), 'utf8')) {
        drift.push('changed ' + rel);
      }
    }
    for (i = 0; i < current.length; i += 1) {
      if (built.files.indexOf(current[i]) === -1) drift.push('stale ' + current[i]);
    }
    if (drift.length) {
      throw new Error('marketing/ is out of date (' + drift.join(', ') + ') - run node scripts/build-marketing-site.js');
    }
    process.stdout.write('marketing/ is fresh (' + built.files.length + ' files)\n');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  var args = {};
  for (var i = 0; i < argv.length; i += 1) {
    var flag = argv[i];
    if (flag === '--out' || flag === '--src') {
      i += 1;
      if (!argv[i]) throw new Error('missing value for ' + flag);
      args[flag.slice(2)] = argv[i];
    } else if (flag === '--check') {
      args.check = true;
    } else {
      throw new Error('unknown argument ' + flag);
    }
  }
  return args;
}

function run(args) {
  var srcDir = args.src ? path.resolve(ROOT, args.src) : path.join(ROOT, 'public');
  var outDir = args.out ? path.resolve(ROOT, args.out) : path.join(ROOT, 'marketing');
  if (args.check) return checkFresh(srcDir, outDir);
  var built = buildMarketingSite({ srcDir: srcDir, outDir: outDir });
  process.stdout.write('built ' + built.files.length + ' files -> ' + path.relative(ROOT, built.outDir) + '\n');
  return built;
}

if (require.main === module) {
  try {
    run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write('build-marketing-site: ' + error.message + '\n');
    process.exit(1);
  }
}

module.exports = {
  buildMarketingSite: buildMarketingSite,
  buildSitemap: buildSitemap,
  checkFresh: checkFresh,
  fileForUrl: fileForUrl,
  parseArgs: parseArgs,
  rewriteText: rewriteText,
  run: run,
  sitemapLocs: sitemapLocs,
  validateTree: validateTree,
  walkFiles: walkFiles,
  REWRITES: REWRITES,
  COMPANY_PAGES: COMPANY_PAGES,
  DISCOVERY_FILES: DISCOVERY_FILES,
  CANONICAL_ORIGIN: CANONICAL_ORIGIN,
  PLATFORM_ORIGIN: PLATFORM_ORIGIN,
};
