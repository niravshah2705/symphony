'use strict';

// SEO/AEO regression suite for the www.archagentix.com relaunch:
// canonical domain, sitemap crawlability, Organization JSON-LD, Try-now
// redirect to platform.archagentix.com, pricing page, and the company footer.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (...parts) => fs.readFileSync(path.join(PUBLIC, ...parts), 'utf8');

const CANONICAL_ORIGIN = 'https://www.archagentix.com';
const PLATFORM_URL = 'https://platform.archagentix.com/';

const MARKETING_PAGES = ['pricing', 'about', 'careers', 'newsroom', 'contact'];
const COMPANY_LINKS = ['About Company', 'Careers', 'Newsroom', 'Contact Us'];

const locsFrom = (source) =>
  [...source.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const sitemapLocs = () => locsFrom(read('sitemap.xml'));
const platformSitemapLocs = () => locsFrom(read('sitemap-platform.xml'));

// A sitemap entry is only a promise that a real, statically served document exists
// behind it. Firebase's `** -> /index.html` rewrite answers anything with the SPA
// shell, so a path that is not a file on disk silently 200s the wrong page.
const isBackedByStaticFile = (loc) => {
  const rel = new URL(loc).pathname;
  const candidates = rel.endsWith('/')
    ? ['index.html', path.join(rel.slice(1), 'index.html')]
    : [rel.slice(1)];
  return candidates.some((candidate) => fs.existsSync(path.join(PUBLIC, candidate)));
};

test('sitemap lists only the www.archagentix.com canonical domain', () => {
  const locs = sitemapLocs();
  assert.ok(locs.length >= 10, `expected a full sitemap, found ${locs.length} urls`);
  for (const loc of locs) {
    assert.ok(loc.startsWith(`${CANONICAL_ORIGIN}/`), `non-canonical sitemap url: ${loc}`);
    assert.doesNotMatch(loc, /adlc-9e72f|web\.app/, `legacy firebase url in sitemap: ${loc}`);
    assert.doesNotMatch(loc, /#/, `fragment url in sitemap: ${loc}`);
  }
  assert.equal(new Set(locs).size, locs.length, 'duplicate <loc> entries');
});

test('every sitemap URL is backed by a literal crawlable file on disk', () => {
  for (const loc of [...sitemapLocs(), ...platformSitemapLocs()]) {
    assert.ok(isBackedByStaticFile(loc), `sitemap url has no static file for ${new URL(loc).pathname}`);
  }
});

test('sitemap covers home, pricing, company pages, and the adlc hub', () => {
  const locs = new Set(sitemapLocs());
  const required = [
    '/', '/pricing/', '/about/', '/careers/', '/newsroom/', '/contact/',
    '/adlc/', '/adlc/blog/', '/adlc/brief/',
  ];
  for (const rel of required) {
    assert.ok(locs.has(CANONICAL_ORIGIN + rel), `sitemap missing ${rel}`);
  }
});

test('robots.txt advertises the canonical sitemap and keeps AI crawlers allowed', () => {
  const robots = read('robots.txt');
  assert.match(robots, new RegExp(`Sitemap: ${CANONICAL_ORIGIN.replace(/[/.]/g, '\\$&')}/sitemap\\.xml`));
  assert.doesNotMatch(robots, /adlc-9e72f/);
  for (const agent of ['Googlebot', 'GPTBot', 'ClaudeBot', 'PerplexityBot', 'OAI-SearchBot']) {
    assert.match(robots, new RegExp(`User-agent: ${agent}\\nAllow: /`), `${agent} must stay allowed`);
  }
});

test('legacy adlc-9e72f.web.app references are gone from all public pages', () => {
  const files = [
    'index.html', 'sitemap.xml', 'robots.txt', 'llms.txt', 'llms-full.txt',
    'adlc/index.html', 'adlc/config.js', 'adlc/app.js', 'adlc/blog/index.html',
    'adlc/brief/index.html',
    ...MARKETING_PAGES.map((slug) => `${slug}/index.html`),
  ];
  for (const file of files) {
    assert.doesNotMatch(read(file), /adlc-9e72f/, `${file} still references the legacy domain`);
  }
});

test('Organization JSON-LD is present and exact on marketing surfaces', () => {
  const expected = {
    '@type': 'Organization',
    name: 'Archagentix Private Limited',
    url: `${CANONICAL_ORIGIN}/`,
    email: 'archagentix@gmail.com',
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'Pune',
      addressRegion: 'Maharashtra',
      postalCode: '411057',
      addressCountry: 'IN',
    },
  };
  const pages = ['index.html', 'adlc/index.html', ...MARKETING_PAGES.map((slug) => `${slug}/index.html`)];
  for (const page of pages) {
    const blocks = [...read(page).matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)];
    const orgs = blocks
      .map((block) => JSON.parse(block[1]))
      .flatMap((data) => (Array.isArray(data['@graph']) ? data['@graph'] : [data]))
      .filter((entity) => entity['@type'] === 'Organization');
    assert.equal(orgs.length, 1, `${page} must expose exactly one Organization block`);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(orgs[0][key], value, `${page} Organization.${key}`);
    }
    assert.match(orgs[0].description, /Agentic Development Life Cycle/);
  }
});

test('every JSON-LD block under public parses as valid JSON', () => {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.html')) {
        const html = fs.readFileSync(full, 'utf8');
        for (const block of html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)) {
          assert.doesNotThrow(() => JSON.parse(block[1]), `invalid JSON-LD in ${full}`);
        }
      }
    }
  };
  walk(PUBLIC);
});

test('Try now links resolve to platform.archagentix.com everywhere', () => {
  const adlcPages = [
    'adlc/index.html', 'adlc/blog/index.html', 'adlc/brief/index.html',
    'adlc/blog/governance/index.html', 'adlc/blog/isolation/index.html',
    'adlc/blog/evidence/index.html', 'adlc/blog/lifecycle/index.html',
    'adlc/blog/integration/index.html', 'adlc/blog/getting-started/index.html',
    ...MARKETING_PAGES.map((slug) => `${slug}/index.html`),
  ];
  for (const page of adlcPages) {
    const html = read(page);
    const tryLinks = [...html.matchAll(/<a[^>]+>(?:Try now|Start free|Open the workspace[^<]*)<\/a>/gi)];
    assert.ok(tryLinks.length > 0, `${page} has no Try now call to action`);
    for (const link of tryLinks) {
      assert.match(link[0], new RegExp(`href="${PLATFORM_URL.replace(/[/.]/g, '\\$&')}"`), `${page}: ${link[0].slice(0, 80)}`);
    }
    assert.doesNotMatch(html, /href="\/#\/agent"/, `${page} still points Try now at the local hash route`);
  }

  const config = read('adlc/config.js');
  assert.match(config, /tryNowUrl:\s*'https:\/\/platform\.archagentix\.com\/'/);
  assert.match(config, /canonicalOrigin:\s*'https:\/\/www\.archagentix\.com'/);
  assert.match(read('adlc/app.js'), /'https:\/\/platform\.archagentix\.com\/'/);
});

test('pricing is linked on top navigation of every marketing page', () => {
  const pages = [
    'adlc/index.html', 'adlc/blog/index.html', 'adlc/brief/index.html',
    ...MARKETING_PAGES.map((slug) => `${slug}/index.html`),
  ];
  for (const page of pages) {
    const html = read(page);
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.match(header, /<a href="\/pricing\/"[^>]*>Pricing<\/a>/, `${page} header lacks Pricing`);
  }
});

test('pricing page exposes plans, FAQ, and product schema for AEO', () => {
  const html = read('pricing/index.html');
  assert.match(html, /<title>Archagentix Pricing/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.archagentix\.com\/pricing\/" \/>/);
  for (const plan of ['Pilot', 'Team', 'Enterprise']) {
    assert.ok(html.includes(plan), `pricing page missing ${plan} plan`);
  }
  const graph = [...html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)]
    .map((block) => JSON.parse(block[1]));
  const types = graph.map((item) => item['@type']);
  assert.ok(types.includes('Product'), 'pricing page missing Product schema');
  assert.ok(types.includes('FAQPage'), 'pricing page missing FAQPage schema');
  const product = graph.find((item) => item['@type'] === 'Product');
  assert.equal(product.offers.length, 3);
});

test('each marketing page is self-canonical, described, and indexable', () => {
  for (const slug of MARKETING_PAGES) {
    const html = read(slug, 'index.html');
    assert.match(html, new RegExp(`<link rel="canonical" href="${CANONICAL_ORIGIN.replace(/[/.]/g, '\\$&')}/${slug}/" \/>`));
    assert.match(html, /<meta\s+name="description"\s+content="[^"]{60,}"/s, `${slug} needs a substantial meta description`);
    assert.match(html, /<meta name="robots" content="index, follow/);
    assert.match(html, /<meta property="og:title"/);
    assert.match(html, /<h1[^>]*>/, `${slug} needs exactly one h1`);
  }
});

test('deploy workflow regenerates adlc config with the canonical defaults', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(workflow, /ADLC_TRY_NOW_URL \|\| 'https:\/\/platform\.archagentix\.com\/'/);
  assert.match(workflow, /ADLC_CANONICAL_ORIGIN \|\| 'https:\/\/www\.archagentix\.com'/);
  assert.match(workflow, /ADLC_TRY_NOW_URL \|\| 'https:\/\/platform\.archagentix\.com\/', canonicalOrigin[\s\S]*ADLC_CANONICAL_ORIGIN \|\| 'https:\/\/www\.archagentix\.com'/);
  assert.match(workflow, /--only hosting:app/, 'app CD must stay scoped to the app hosting target');
});

test('www marketing site has its own CD publishing hosting:www', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-www.yml'), 'utf8');
  assert.match(workflow, /--only hosting:www/);
  assert.match(workflow, /branches: \[main\]/);
  for (const watched of [
    "'public/pricing/**'", "'public/adlc/**'", "'public/sitemap.xml'",
    "'public/robots.txt'", "'public/llms.txt'", "'firebase.json'", "'.firebaserc'",
  ]) {
    assert.ok(workflow.includes(watched), `deploy-www path filter missing ${watched}`);
  }
  assert.match(workflow, /workload_identity_provider/, 'must reuse the keyless WIF auth');

  const terraform = fs.readFileSync(path.join(ROOT, 'deploy/gcp/terraform/firebase.tf'), 'utf8');
  assert.match(terraform, /resource "google_firebase_hosting_site" "marketing"/);
  assert.match(terraform, /resource "google_firebase_hosting_custom_domain" "marketing"/);
  assert.match(terraform, /wait_dns_verification\s+= false/);
  const locals = fs.readFileSync(path.join(ROOT, 'deploy/gcp/terraform/locals.tf'), 'utf8');
  assert.match(locals, /marketing_site_id = "\$\{var\.project_id\}-marketing"/);
});

test('www site moved to GCP: no SPA obfuscation in its CD, scripts wire the domain', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-www.yml'), 'utf8');
  assert.ok(!workflow.includes('obfuscate-spa.js'), 'www CD must not obfuscate — static marketing tree only');

  const bootstrap = fs.readFileSync(path.join(ROOT, 'deploy/gcp/bootstrap.sh'), 'utf8');
  assert.match(bootstrap, /MARKETING_CUSTOM_DOMAIN:-www\.archagentix\.com/, 'bootstrap defaults the www domain');
  assert.match(bootstrap, /marketing\.ghs\.googlehosted\.com/, 'bootstrap lists the DNS cutover manual step');

  const deploySh = fs.readFileSync(path.join(ROOT, 'deploy/gcp/deploy.sh'), 'utf8');
  assert.match(deploySh, /-var="marketing_custom_domain=\$\{MARKETING_CUSTOM_DOMAIN\}"/, 'deploy.sh passes the marketing var');

  const cdApply = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(cdApply, /-var="marketing_custom_domain=/, 'CD Terraform apply controls the marketing domain');
});

test('footer mirrors the platform footer and carries the company sections', () => {
  const pages = [
    'adlc/index.html', 'adlc/blog/index.html', 'adlc/brief/index.html',
    ...MARKETING_PAGES.map((slug) => `${slug}/index.html`),
  ];
  for (const page of pages) {
    const html = read(page);
    const footer = html.slice(html.indexOf('<footer'));
    assert.match(footer, /class="site-footer"/, `${page} missing site footer`);
    for (const label of COMPANY_LINKS) {
      assert.ok(footer.includes(label), `${page} footer missing ${label}`);
    }
    assert.match(footer, /Archagentix Private Limited/);
    assert.match(footer, /href="https:\/\/www\.archagentix\.com\/#\/privacy"/, `${page} footer missing Privacy`);
    assert.match(footer, /href="https:\/\/www\.archagentix\.com\/#\/terms"/, `${page} footer missing Terms`);
  }

  // The SPA (platform) footer gains the same company sections.
  const spa = read('index.html');
  const spaFooter = spa.slice(spa.indexOf('<footer class="app-footer"'));
  for (const label of COMPANY_LINKS) {
    assert.ok(spaFooter.includes(label), `platform footer missing ${label}`);
  }
  assert.match(spaFooter, /aria-label="Company"/);
});

test('the brand query has a landing page: every public title names Archagentix', () => {
  const pages = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name.endsWith('.html')) pages.push(path.relative(PUBLIC, path.join(dir, entry.name)));
    }
  };
  walk(PUBLIC);
  assert.ok(pages.length >= 16, `expected every public page, found ${pages.length}`);
  for (const page of pages) {
    const title = read(page).match(/<title>([^<]*)<\/title>/)?.[1];
    assert.ok(title, `${page} has no <title>`);
    assert.match(title, /Archagentix/, `${page} title drops the brand: ${title}`);
    assert.doesNotMatch(title, /ArchAgentix/, `${page} misspells the brand`);
  }
  // The two surfaces a brand search must win lead with it.
  for (const page of ['index.html', 'adlc/index.html']) {
    assert.match(read(page), /<title>Archagentix\b/, `${page} must lead with the brand`);
  }
});

test('platform owns its sitemap, and www never publishes it', () => {
  const locs = platformSitemapLocs();
  assert.equal(locs.length, 2, `platform sitemap should list its two owned urls, got ${locs.length}`);
  for (const loc of locs) {
    assert.ok(loc.startsWith(PLATFORM_URL), `platform sitemap url off the app origin: ${loc}`);
  }
  assert.ok(locs.includes(PLATFORM_URL), 'platform sitemap must list the app root');

  // The two sitemaps must stay disjoint: one origin each, or Google picks the host
  // that is not the destination and the app root goes back to being a duplicate.
  for (const loc of sitemapLocs()) assert.ok(!loc.startsWith(PLATFORM_URL), `www sitemap lists a platform url: ${loc}`);

  const builder = fs.readFileSync(path.join(ROOT, 'scripts/build-marketing-site.js'), 'utf8');
  const discovery = builder.match(/const DISCOVERY_FILES = \[([\s\S]*?)\];/)[1];
  assert.doesNotMatch(discovery, /sitemap-platform/, 'www must not serve the platform sitemap');
  if (fs.existsSync(path.join(ROOT, 'marketing'))) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'marketing', 'sitemap-platform.xml')), 'platform sitemap leaked into the marketing tree');
  }
});

test('robots.txt advertises a sitemap for each host', () => {
  const robots = read('robots.txt');
  assert.match(robots, new RegExp(`Sitemap: ${PLATFORM_URL.replace(/[/.]/g, '\\$&')}sitemap-platform\\.xml`));
  const lines = robots.split('\n').filter((line) => line.startsWith('Sitemap:'));
  assert.equal(lines.length, 2, `one sitemap line per host, found ${lines.length}`);
});

test('both hosts describe one organization, and only www declares it', () => {
  const wwwRoot = read('adlc/index.html');
  assert.match(wwwRoot, /"@id": "https:\/\/www\.archagentix\.com\/#organization"/, 'the referenced @id must exist on www');

  const spa = read('index.html');
  const orgs = [...spa.matchAll(/"@type": "Organization",\s*"@id": "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(orgs, [`${CANONICAL_ORIGIN}/#organization`], 'platform must reference the org, not redeclare it');
  assert.match(spa, /<link rel="canonical" href="https:\/\/platform\.archagentix\.com\/" \/>/, 'platform root self-canonicalises');

  // Marketing copies on platform still consolidate to www; only the app root is its own destination.
  for (const page of ['adlc/index.html', ...MARKETING_PAGES.map((slug) => `${slug}/index.html`)]) {
    assert.match(read(page), new RegExp(`<link rel="canonical" href="${CANONICAL_ORIGIN}/`), `${page} lost its www canonical`);
  }
});

test('the benchmarks panel is an indexed, self-canonical Archagentix page', () => {
  const html = read('archagentix/index.html');
  assert.match(html, /<link rel="canonical" href="https:\/\/platform\.archagentix\.com\/archagentix\/" \/>/);
  assert.match(html, /<meta name="robots" content="index, follow/);
  const description = html.match(/name="description"\s+content="([^"]+)"/)?.[1];
  assert.ok(description && description.length >= 120 && description.length <= 175, `benchmarks description: ${description?.length}`);
  assert.match(html, /<meta property="og:site_name" content="Archagentix"/);
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)];
  assert.equal(blocks.length, 1, 'the panel page needs exactly one JSON-LD graph');
  const entities = JSON.parse(blocks[0][1])['@graph'];
  assert.ok(entities.some((e) => e.publisher?.['@id'] === `${CANONICAL_ORIGIN}/#organization`));
  assert.equal(entities.filter((e) => e['@type'] === 'Organization').length, 0, 'must not redeclare the org');
});

test('answer engines are told which host does what', () => {
  for (const doc of ['llms.txt', 'llms-full.txt']) {
    const text = read(doc);
    assert.match(text, /^# Archagentix — ADLC/m, `${doc} must lead with the brand entity`);
    assert.match(text, /platform\.archagentix\.com/, `${doc} never mentions the platform host`);
    assert.match(text, /https:\/\/platform\.archagentix\.com\/archagentix\//, `${doc} omits the benchmarks url`);
  }
  assert.match(read('llms.txt'), /operates two hosts/);
});
