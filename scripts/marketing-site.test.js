'use strict';

// The www.archagentix.com tree is generated, so these tests check the boundary
// that matters: what the generator writes, and whether firebase.json and
// deploy-www.yml actually publish that tree and rewrite the legacy /adlc/ urls onto it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const generator = require('./build-marketing-site.js');
const { buildMarketingSite, sitemapLocs, run, CANONICAL_ORIGIN, PLATFORM_ORIGIN, LEGAL_PAGE_SLUGS } = generator;

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

const firebaseConfig = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));

function parseCsp(value) {
  return Object.fromEntries(
    value
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...sources] = d.split(/\s+/);
        return [name, sources];
      })
  );
}

function cspDirectives(target) {
  const site = firebaseConfig().hosting.find((s) => s.target === target);
  const block = site.headers.find((rule) => rule.source === '/**');
  const header = block.headers.find((h) => h.key === 'Content-Security-Policy');
  assert.ok(header, `the ${target} target must publish a Content-Security-Policy`);
  return parseCsp(header.value);
}

// A document can carry a <meta http-equiv="Content-Security-Policy"> next to the
// response header, and the browser enforces BOTH: a source allowed by only one of
// them is still blocked. So every assertion below runs against the merged policy.
function metaPolicies(htmlTexts) {
  const out = [];
  for (const text of htmlTexts) {
    for (const m of text.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/g)) {
      out.push(parseCsp(m[1].replace(/&quot;/g, '"')));
    }
  }
  return out;
}

// Returns allows(directive, host) — true only if the header and every meta policy
// in the served documents permit that host.
function effectiveAllows(target, htmlTexts) {
  const policies = [cspDirectives(target), ...metaPolicies(htmlTexts)];
  return (directive, host) => policies.every((p) => hostAllowed(host, p[directive] || p['default-src']));
}

// Every file a hosting target actually serves, minus vendored SDKs (same origin)
// and the test files that quote third-party URLs without loading them.
function sourceTexts(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|js|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        out.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}

// Origins each tree pulls in from elsewhere, keyed by the directive that has to
// allow them. The payment SDKs and Google sign-in are injected at runtime by JS,
// so a markup-only scan would miss them entirely.
function loadedHosts(texts) {
  const hosts = { script: new Set(), style: new Set(), img: new Set() };
  for (const text of texts) {
    for (const m of text.matchAll(/<script[^>]+\bsrc="(https?:)?\/\/([^/"]+)/g)) hosts.script.add(m[2]);
    for (const m of text.matchAll(/\.src\s*=\s*['"`](https?:)?\/\/([^/'"`]+)/g)) hosts.script.add(m[2]);
    for (const m of text.matchAll(/(?:^|[.\s{])src\s*:\s*['"](https?:)?\/\/([^/'"]+)/gm)) hosts.script.add(m[2]);
    for (const m of text.matchAll(/<link\b[^>]+>/g)) {
      if (!/rel="stylesheet"/.test(m[0])) continue;
      const href = /href="(https?:)?\/\/([^/"]+)/.exec(m[0]);
      if (href) hosts.style.add(href[2]);
    }
    for (const m of text.matchAll(/<img[^>]+\bsrc="(https?:)?\/\/([^/"]+)/g)) hosts.img.add(m[2]);
  }
  return hosts;
}

function hostAllowed(host, sources) {
  return (sources || []).some((source) => {
    const match = /^[a-z+]+:\/\/(.+)$/i.exec(source);
    if (!match) return false;
    const pattern = match[1];
    if (pattern.startsWith('*.')) return host === pattern.slice(2) || host.endsWith('.' + pattern.slice(2));
    return host === pattern;
  });
}

function assertLoadableHosts(texts, allows, target) {
  for (const [kind, directive] of [
    ['script', 'script-src'],
    ['style', 'style-src'],
    ['img', 'img-src']
  ]) {
    for (const host of loadedHosts(texts)[kind]) {
      assert.ok(
        allows(directive, host),
        `${host} is loaded as ${kind} by the ${target} tree but ${directive} does not allow it`
      );
    }
  }

  // A third-party script or stylesheet also fetches its own sourceMappingURL,
  // which is governed by connect-src, not script-src. Missing it only surfaces as
  // a DevTools console error, so it has to be asserted next to the load itself.
  const hosts = loadedHosts(texts);
  for (const host of new Set([...hosts.script, ...hosts.style])) {
    assert.ok(
      allows('connect-src', host),
      `${host} serves code to the ${target} tree, so connect-src must allow its source map too`
    );
  }
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
    'googleca0fdd26d71dc36f.html',
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
  const rootEntity = JSON.parse(first);
  // The www root declares its WebSite entity, and that entity is the one every
  // other surface points at; a flat node is still accepted.
  const website = Array.isArray(rootEntity['@graph'])
    ? rootEntity['@graph'].find((entity) => entity['@type'] === 'WebSite')
    : rootEntity;
  assert.ok(website, 'the promoted landing must declare a WebSite entity');
  assert.equal(website.url, `${CANONICAL_ORIGIN}/`);
  assert.equal(website['@id'], `${CANONICAL_ORIGIN}/#website`);
  assert.equal(website.publisher['@id'], `${CANONICAL_ORIGIN}/#organization`);
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

test('legal documents are static pages on www, never hash routes', () => {
  for (const rel of built.files.filter((name) => name.endsWith('.html'))) {
    const html = read(rel);
    assert.ok(!html.includes(`${CANONICAL_ORIGIN}/#/`), `marketing/${rel} links a dead www hash route`);
  }
  // The policy text an acquirer reads must exist without executing JavaScript.
  for (const slug of LEGAL_PAGE_SLUGS) {
    const html = read(`${slug}/index.html`);
    assert.match(html, /<h2 id="/, `${slug} must carry the document body as headings`);
    assert.ok(html.length > 4000, `${slug} looks like a stub, not the full policy`);
  }
});

test('no published page names an individual or a free-mailbox contact', () => {
  for (const rel of built.files) {
    if (!/\.(html|txt|xml)$/.test(rel)) continue;
    const text = read(rel);
    assert.doesNotMatch(text, /Nirav Shah/, `marketing/${rel} names an individual`);
    assert.doesNotMatch(text, /@[a-z0-9.-]*gmail\.com/i, `marketing/${rel} publishes a gmail address`);
  }
});
test('firebase publishes the generated tree as the www root and rewrites every legacy /adlc/ url onto it', () => {
  const firebase = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const app = firebase.hosting.find((site) => site.target === 'app');
  const www = firebase.hosting.find((site) => site.target === 'www');

  assert.equal(app.public, 'public', 'the app site keeps serving the source tree');
  assert.equal(www.public, 'marketing', 'www must publish the generated tree');
  assert.ok(!www.redirects, 'a legacy 301 costs a hop and a 5xx window on a mis-provisioned domain');
  // One rule per legacy url, derived from the source tree: a glob destination would
  // 404 because Firebase only captures wildcards in redirects, never in rewrites.
  // A page added under public/adlc/ therefore has to be added here too.
  assert.deepEqual(www.rewrites, built.rewrites, 'firebase.json must match legacyRewrites()');
  assert.ok(www.rewrites.every((rule) => rule.source.startsWith('/adlc')), 'www must keep no other rewrite');
  for (const rule of www.rewrites) {
    const target = path.join(OUT, ...rule.destination.slice(1).split('/'));
    assert.ok(fs.existsSync(target), `${rule.source} rewrites to a missing file: ${rule.destination}`);
  }

  const cacheFor = Object.fromEntries(www.headers.map((rule) => [rule.source, rule.headers[0].value]));
  assert.equal(cacheFor['/config.js'], 'no-store', 'the ADLC runtime config must never be cached');
  assert.equal(cacheFor['/sw.js'], 'no-cache');
  assert.equal(cacheFor['/manifest.webmanifest'], 'no-cache');
  assert.equal(cacheFor['/adlc'], cacheFor['/'], 'legacy urls must serve the landing page uncached');
  assert.equal(cacheFor['/adlc/**'], cacheFor['/'], 'rewritten pages must not be cached at the old url');
});

test('the CSP matches what the published pages actually load', () => {
  const directives = cspDirectives('www');

  for (const name of ['default-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors']) {
    assert.ok(directives[name], `${name} must be set`);
  }
  assert.deepEqual(directives['default-src'], ["'self'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);

  // The landing page ships inline <script>/<style> blocks, so a stricter policy
  // would break it; the external origin is the xterm terminal assets on unpkg.
  const texts = [...built.files].filter((rel) => rel.endsWith('.html')).map((rel) => read(rel));
  assert.ok(
    texts.some((t) => /<script>|<style>/.test(t)),
    'expected inline script/style blocks in the published tree'
  );
  assert.ok(directives['script-src'].includes("'unsafe-inline'"), 'inline scripts need unsafe-inline');
  assert.ok(directives['style-src'].includes("'unsafe-inline'"), 'inline styles need unsafe-inline');
  assertLoadableHosts(texts, effectiveAllows('www', texts), 'www');
});

test('the platform SPA CSP covers every origin it loads, including the injected ones', () => {
  const directives = cspDirectives('app');
  const texts = sourceTexts('public');
  assertLoadableHosts(texts, effectiveAllows('app', texts), 'app');

  // The app shell has inline <script> blocks and an onload attribute on the
  // print-media stylesheet, so 'unsafe-inline' is load-bearing here as it is on www.
  assert.ok(directives['script-src'].includes("'unsafe-inline'"));
  assert.ok(directives['connect-src'].length, 'the gateway origin must be reachable');

  // Calls capture the microphone and the screen. A Permissions-Policy copied from
  // the marketing target would silently break public/js/views/calls.js.
  const firebase = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const block = firebase.hosting.find((s) => s.target === 'app').headers.find((r) => r.source === '/**');
  const permissions = block.headers.find((h) => h.key === 'Permissions-Policy');
  if (permissions) {
    assert.doesNotMatch(permissions.value, /microphone=\(\)/, 'the platform needs the microphone for agent calls');
    assert.doesNotMatch(permissions.value, /display-capture=\(\)/, 'the platform needs screen capture for agent calls');
  }
});

test('the secrets CSP stays tight because that app has no inline scripts', () => {
  const directives = cspDirectives('secrets');
  const texts = sourceTexts('secrets');
  assertLoadableHosts(texts, effectiveAllows('secrets', texts), 'secrets');

  assert.equal(
    texts.filter((t) => /<script>/.test(t)).length,
    0,
    'a new inline <script> in secrets/ must move to a file or be reported here'
  );
  assert.deepEqual(
    directives['script-src'],
    ["'self'", 'https://apis.google.com'],
    'secrets serves only local code, plus the gapi bundle Firebase auth loads'
  );
});

// The Firebase auth bundles load code that no page markup references, so the
// markup scan above cannot see it: gapi at apis.google.com, and reCAPTCHA at
// www.google.com. This asserts the reachable one is allowed and pins that the
// unreachable one is not, because a session-token page should not grant Google
// open-ended script execution for a code path this product never enters.
test('the vendored Firebase auth bundles are inside their host CSP', () => {
  const REACHABLE = 'apis.google.com';
  const RECAPTCHA = 'www.google.com';

  for (const [target, bundle, dir] of [
    ['app', 'public/vendor/firebase/firebase-auth.js', 'public'],
    ['secrets', 'secrets/vendor/firebase-auth-compat.js', 'secrets']
  ]) {
    const allows = effectiveAllows(target, sourceTexts(dir));
    const scripts = [
      ...fs.readFileSync(path.join(ROOT, bundle), 'utf8').matchAll(/https:\/\/([a-z0-9.-]+)\/[^\s"'`]*\.js/g)
    ].map((m) => m[1]);

    assert.ok(scripts.includes(REACHABLE), `${bundle} should still load gapi from ${REACHABLE}`);
    assert.ok(
      allows('script-src', REACHABLE),
      `${bundle} loads gapi on sign-in, but ${target} script-src blocks it`
    );
    assert.ok(
      allows('frame-src', REACHABLE),
      `${target} frame-src must allow the gapi iframe ${REACHABLE} creates`
    );

    if (scripts.includes(RECAPTCHA)) {
      const appUsesRecaptcha = sourceTexts('public')
        .concat(target === 'secrets' ? sourceTexts('secrets') : [])
        .some((t) => /RecaptchaVerifier/i.test(t));
      assert.equal(
        appUsesRecaptcha,
        false,
        `a RecaptchaVerifier now exists: add ${RECAPTCHA} to ${target} script-src and frame-src`
      );
      assert.ok(
        !allows('script-src', RECAPTCHA),
        `${RECAPTCHA} is only needed for reCAPTCHA, which this product does not use`
      );
    }
  }
});

// Two more origins that no file in the tree can be scanned for, because they are
// resolved at runtime from the Firebase config rather than written down: the popup
// flow frames `${authDomain}/__/auth/iframe`, which is the project's own
// firebaseapp.com host, and the Google Identity Services client injects a
// stylesheet from accounts.google.com. Both fail silently apart from a console
// line, so a manual sign-in is the only other way to notice.
const FIREBASE_PROJECT = JSON.parse(fs.readFileSync(path.join(ROOT, '.firebaserc'), 'utf8')).projects.default;
const AUTH_DOMAIN = `${FIREBASE_PROJECT}.firebaseapp.com`;

test('the sign-in flow can frame the auth handler and load the GIS stylesheet', () => {
  for (const [target, dir] of [['app', 'public'], ['secrets', 'secrets']]) {
    assert.ok(
      effectiveAllows(target, sourceTexts(dir))('frame-src', AUTH_DOMAIN),
      `${target} must frame https://${AUTH_DOMAIN}/__/auth/iframe or signInWithPopup never returns`
    );
  }
  assert.ok(
    effectiveAllows('app', sourceTexts('public'))('style-src', 'accounts.google.com'),
    'public/js/auth.js loads the GIS client, which then loads https://accounts.google.com/gsi/style'
  );
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
