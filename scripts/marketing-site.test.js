'use strict';

// The www.archagentix.com tree is generated, so these tests check the boundary
// that matters: what the generator writes, and whether firebase.json and
// deploy-www.yml actually publish that tree with the /adlc/ redirects.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const generator = require('./build-marketing-site.js');
const { buildMarketingSite, sitemapLocs, run, CANONICAL_ORIGIN, PLATFORM_ORIGIN } = generator;

const ROOT = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-test-'));
const built = buildMarketingSite({ outDir: OUT });
const read = (...parts) => fs.readFileSync(path.join(OUT, ...parts), 'utf8');
const exists = (urlPath) => fs.existsSync(path.join(OUT, ...fileFor(urlPath)));

function fileFor(urlPath) {
  if (urlPath === '/') return ['index.html'];
  if (urlPath.endsWith('/')) return [urlPath.slice(1, -1), 'index.html'];
  return [urlPath.slice(1)];
}

test.after(() => fs.rmSync(OUT, { recursive: true, force: true }));

test('the marketing tree promotes every ADLC page to the root', () => {
  const files = new Set(built.files);
  for (const rel of [
    'index.html', 'styles.css', 'app.js', 'sw.js', 'manifest.webmanifest', 'config.js',
    'blog/index.html', 'brief/index.html', 'blog/governance/index.html',
    'blog/isolation/index.html', 'blog/evidence/index.html', 'blog/lifecycle/index.html',
    'blog/integration/index.html', 'blog/getting-started/index.html',
    'pricing/index.html', 'about/index.html', 'careers/index.html',
    'newsroom/index.html', 'contact/index.html',
    'robots.txt', 'llms.txt', 'llms-full.txt', 'sitemap.xml',
  ]) {
    assert.ok(files.has(rel), `marketing/${rel} is missing`);
  }
  assert.ok(![...files].some((rel) => rel.startsWith('adlc/')), 'the /adlc/ prefix must not survive promotion');
  assert.ok(![...files].some((rel) => rel.endsWith('.test.mjs')), 'test files must never ship');
});

test('promoted pages self-canonicalise at the root and drop /adlc/ links', () => {
  const landing = read('index.html');
  assert.match(landing, new RegExp(`<link rel="canonical" href="${CANONICAL_ORIGIN}/" />`));
  assert.match(landing, new RegExp(`<meta property="og:url" content="${CANONICAL_ORIGIN}/" />`));
  const first = landing.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/)[1];
  assert.equal(JSON.parse(first).url, `${CANONICAL_ORIGIN}/`);
  for (const rel of built.files) {
    assert.ok(!read(rel).includes('/adlc/'), `marketing/${rel} still references /adlc/`);
  }
});

test('the app site keeps the source copy of /adlc/ canonical', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'adlc', 'index.html'), 'utf8');
  assert.match(source, new RegExp(`<link rel="canonical" href="${CANONICAL_ORIGIN}/adlc/" />`));
});
test('service worker and manifest are root-scoped on www', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');

  const worker = read('sw.js');
  assert.match(worker, /'archagentix-marketing-v1'/, 'the root build needs its own cache key');
  assert.match(worker, /ASSETS\.includes\(url\.pathname\)/, 'a root-scoped worker must not cache-first the whole origin');
  assert.match(read('app.js'), /register\('\/sw\.js', \{ scope: '\/' \}\)/);

  const precached = worker.match(/const ASSETS = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g);
  assert.ok(precached.length > 0, 'the precache list must not be empty');
  for (const quoted of precached) {
    const urlPath = quoted.slice(1, -1);
    assert.ok(exists(urlPath), `precache entry ${urlPath} has no file in the marketing tree`);
  }
});
test('the generated sitemap lists promoted urls backed by files', () => {
  const locs = sitemapLocs(read('sitemap.xml'));
  assert.ok(!locs.includes(`${CANONICAL_ORIGIN}/adlc/`), '/adlc/ is a redirect source, not a canonical url');
  for (const rel of ['/', '/pricing/', '/blog/', '/brief/', '/contact/', '/blog/governance/']) {
    assert.ok(locs.includes(CANONICAL_ORIGIN + rel), `sitemap missing ${rel}`);
  }
  for (const loc of locs) {
    assert.ok(loc.startsWith(`${CANONICAL_ORIGIN}/`), `sitemap url off the canonical origin: ${loc}`);
    assert.ok(exists(new URL(loc).pathname), `sitemap url ${loc} has no file in the marketing tree`);
  }

  const sourceLocs = sitemapLocs(fs.readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8'))
    .filter((loc) => new URL(loc).pathname !== '/adlc/');
  assert.equal(locs.length, sourceLocs.length, 'promotion must not drop sitemap urls');
});

test('legal hash routes point at the SPA on the platform origin', () => {
  for (const rel of built.files.filter((name) => name.endsWith('.html'))) {
    const html = read(rel);
    assert.ok(!html.includes(`${CANONICAL_ORIGIN}/#/`), `marketing/${rel} links a dead www hash route`);
  }
  assert.ok(read('index.html').includes(`${PLATFORM_ORIGIN}/#/privacy`), 'Privacy must resolve to the SPA');
});
test('firebase publishes the generated tree as the www root with /adlc/ 301s', () => {
  const firebase = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const app = firebase.hosting.find((site) => site.target === 'app');
  const www = firebase.hosting.find((site) => site.target === 'www');

  assert.equal(app.public, 'public', 'the app site keeps serving the source tree');
  assert.equal(www.public, 'marketing', 'www must publish the generated tree');
  assert.ok(!www.rewrites, 'a SPA catch-all rewrite would mask 404s by serving the landing page');
  assert.deepEqual(www.redirects, [
    { source: '/adlc', destination: '/', type: 301 },
    { source: '/adlc/', destination: '/', type: 301 },
    // Firebase captures glob segments with ":name" + "*" (":splat" is not a token).
    { source: '/adlc/:path*', destination: '/:path', type: 301 },
  ]);

  const cacheFor = Object.fromEntries(www.headers.map((rule) => [rule.source, rule.headers[0].value]));
  assert.equal(cacheFor['/config.js'], 'no-store', 'the ADLC runtime config must never be cached');
  assert.equal(cacheFor['/sw.js'], 'no-cache');
  assert.equal(cacheFor['/manifest.webmanifest'], 'no-cache');
});

test('deploy-www builds the marketing tree before publishing it', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-www.yml'), 'utf8');
  const build = workflow.indexOf('node scripts/build-marketing-site.js');
  const publish = workflow.indexOf('--only hosting:www');
  assert.ok(build >= 0, 'the generator must run in the www release job');
  assert.ok(publish > build, 'firebase must deploy after the tree is built');
  assert.ok(workflow.includes("- 'scripts/build-marketing-site.js'"), 'generator changes must republish www');

  const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignored.includes('marketing/'), 'the generated tree must stay out of git');
});

test('a freshly built tree passes the staleness check', () => {
  run({ srcDir: path.join(ROOT, 'public'), outDir: OUT, check: true });
});
