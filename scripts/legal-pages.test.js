'use strict';

// The crawler-facing policy pages are generated from the markdown in public/legal/.
// If a document is edited without regenerating, www keeps serving the previous
// policy text — a silent divergence between what the in-app view shows and what an
// acquirer reads. This test is the gate.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (...parts) => fs.readFileSync(path.join(PUBLIC, ...parts), 'utf8');

const { LEGAL_PAGES, POLICY_LINKS, renderMarkdown } = require('./build-legal-pages.js');

test('generated policy pages match the markdown documents they come from', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-legal-pages.js'), '--check'], { stdio: 'pipe' });
});

test('each policy page carries the whole document, not a summary', () => {
  for (const page of LEGAL_PAGES) {
    const source = read(page.source);
    const html = read(page.slug, 'index.html');
    const sections = [...source.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
    assert.ok(sections.length >= 3, `${page.source} looks truncated`);
    for (const section of sections) {
      const id = section
        .toLowerCase()
        .replace(/[`*_]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      assert.ok(html.includes(`<h2 id="${id}">`), `${page.slug} is missing section "${section}"`);
    }
  }
});

test('policy pages disclose the entity, the office, the phone and the mailbox', () => {
  for (const page of LEGAL_PAGES) {
    const html = read(page.slug, 'index.html');
    assert.match(html, /Archagentix Private Limited/);
    assert.match(html, /Hinjewadi IT Park, Pune 411057, Maharashtra, India/);
    assert.ok(html.includes('+91 93705 80836'), `${page.slug} missing the support phone`);
    assert.ok(html.includes('support@archagentix.com'), `${page.slug} missing the support email`);
    assert.ok(html.includes('tel:+919370580836'), `${page.slug} phone is not callable`);
    for (const [slug, label] of POLICY_LINKS) {
      assert.ok(
        html.includes(`href="/${slug}/">${label.replace(/&/g, '&amp;')}</a>`),
        `${page.slug} footer missing ${label}`,
      );
    }
  }
});

// The underwriter reads these off the site and keys them against MCA master data
// and the GST certificate, so a typo or a page that drifted from the others is a
// review failure rather than a cosmetic one. The shapes are the statutory ones:
// CIN = 21 chars (utilisation, 5-digit NAIKS, state, year, class, RN);
// GSTIN = 15 chars (state code, PAN, entity check char, Z, checksum).
test('every policy page carries the same, well-formed CIN and GSTIN', () => {
  const { CIN, GSTIN } = require('./build-legal-pages.js');
  assert.match(CIN, /^[UA]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/, 'CIN does not match the MCA format');
  assert.match(GSTIN, /^\d{2}[A-Z0-9]{10}[A-Z1-9]Z[A-Z0-9]$/, 'GSTIN does not match the GST format');

  // GSTIN checksum: GF(37) weights 2^i over the first 14 characters, folded mod 38.
  const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const sum = [...GSTIN.slice(0, 14)].reduce((total, ch, i) => total + 2 ** (i + 1) % 37 * charset.indexOf(ch), 0);
  const remainder = sum % 38;
  assert.equal(GSTIN[14], charset[remainder === 1 ? 0 : 38 - remainder], 'GSTIN check digit does not reproduce');

  for (const page of LEGAL_PAGES) {
    const html = read(page.slug, 'index.html');
    assert.ok(html.split(CIN).length >= 3, `${page.slug} must state the CIN in visible text, not only JSON-LD`);
    assert.ok(html.split(GSTIN).length >= 3, `${page.slug} must state the GSTIN in visible text, not only JSON-LD`);
    const ids = JSON.parse(html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/)[1]).identifier;
    assert.deepEqual(
      Object.fromEntries(ids.map((id) => [id.propertyID, id.value])),
      { CIN, GSTIN },
      `${page.slug} JSON-LD identifiers`,
    );
  }
});

test('the refund policy states the windows and timelines a chargeback defence needs', () => {
  const html = read('refund-policy', 'index.html');
  assert.match(html, /cancell?ation/i);
  assert.match(html, /14 (calendar )?days/i, 'must state a cancellation window');
  assert.match(html, /business days/i, 'must state timelines in business days');
  assert.match(html, /original payment method/i, 'must state the refund rail');
  assert.match(html, /chargeback/i);
});

test('the delivery policy states digital provisioning timelines', () => {
  const html = read('shipping-policy', 'index.html');
  assert.match(html, /no physical shipment|digital/i);
  assert.match(html, /5 minutes|instant/i, 'must state how fast access is provisioned');
  assert.match(html, /API keys/i);
  assert.match(html, /business days/i);
});

test('terms and privacy name the company and governing law in Pune', () => {
  for (const slug of ['terms', 'privacy']) {
    const html = read(slug, 'index.html');
    assert.doesNotMatch(html, /Nirav Shah/);
    assert.doesNotMatch(html, /@[a-z0-9.-]*gmail\.com/i);
    assert.match(html, /Archagentix Private Limited/);
  }
  assert.match(read('terms', 'index.html'), /Pune,\s*Maharashtra,\s*India/);
});

test('internal links on a policy page resolve to a real published page', () => {
  const { PUBLISHED_PAGES } = require('./build-marketing-site.js');
  const published = new Set([
    '/', ...PUBLISHED_PAGES.map((slug) => `/${slug}/`),
    // On the marketing host these promote out of /adlc/, but both forms exist in
    // the source tree, which is what the app host serves.
    '/adlc/', '/adlc/blog/', '/adlc/brief/', '/blog/', '/brief/',
    '/legal/terms.md', '/legal/privacy.md', '/legal/refund.md', '/legal/shipping.md',
    '/llms.txt', '/llms-full.txt', '/adlc/styles.css', '/styles.css',
  ]);
  for (const page of LEGAL_PAGES) {
    const html = read(page.slug, 'index.html');
    for (const match of html.matchAll(/href="(\/[^"#]*)"/g)) {
      assert.ok(published.has(match[1]), `${page.slug} links an unpublished path: ${match[1]}`);
    }
    // A leftover #/route would bounce the reader into the app shell.
    assert.doesNotMatch(html, /href="#\//, `${page.slug} still links an SPA hash route`);
  }
});

test('the markdown renderer escapes markup and resolves sibling policy links', () => {
  const rendered = renderMarkdown('# T\n\n<script>alert(1)</script> & [Terms](#/terms)\n');
  assert.doesNotMatch(rendered.html, /<script>/);
  assert.ok(rendered.html.includes('&lt;script&gt;'));
  assert.ok(rendered.html.includes('href="/terms/"'));
});
