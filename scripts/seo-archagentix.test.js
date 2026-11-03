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

const sitemapLocs = () =>
  [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

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
  for (const loc of sitemapLocs()) {
    const rel = new URL(loc).pathname;
    const candidates = rel.endsWith('/')
      ? [path.join('index.html'), path.join(rel.slice(1), 'index.html')]
      : [rel.slice(1)];
    const exists = candidates.some((candidate) =>
      fs.existsSync(path.join(PUBLIC, candidate)),
    );
    assert.ok(exists, `sitemap url has no static file for ${rel}`);
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
    "'public/robots.txt'", "'public/llms.txt'", "'firebase.json'",
  ]) {
    assert.ok(workflow.includes(watched), `deploy-www path filter missing ${watched}`);
  }
  assert.match(workflow, /workload_identity_provider/, 'must reuse the keyless WIF auth');

  const terraform = fs.readFileSync(path.join(ROOT, 'deploy/gcp/terraform/firebase.tf'), 'utf8');
  assert.match(terraform, /resource "google_firebase_hosting_site" "marketing"/);
  assert.match(terraform, /resource "google_firebase_hosting_custom_domain" "marketing"/);
  assert.match(terraform, /wait_dns_verification\s+= false/);
  const locals = fs.readFileSync(path.join(ROOT, 'deploy/gcp/terraform/locals.tf'), 'utf8');
  assert.match(locals, /marketing_site_id = "\$\{var\.project_id\}-www"/);
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
