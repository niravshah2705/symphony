#!/usr/bin/env node
'use strict';

// Renders the markdown legal documents in public/legal/ into static pages at the
// site root, so a payment-acquirer crawler that does not execute JavaScript still
// retrieves the full policy text.
//
// The markdown stays the only copy of the prose: public/index.html's SPA renders
// the same files through public/js/views/legal.js, so the in-app view and the
// crawled page cannot disagree.
//
// The generated HTML is committed, because the app hosting target serves public/
// as-is and scripts/build-marketing-site.js copies these files into the www tree.
// Regenerate after editing any document in public/legal/:
//
//   node scripts/build-legal-pages.js          # write the pages
//   node scripts/build-legal-pages.js --check  # fail if they are stale

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CANONICAL_ORIGIN = 'https://www.archagentix.com';
const PLATFORM_ORIGIN = 'https://platform.archagentix.com';
const ENTITY = 'Archagentix Private Limited';
const ADDRESS = 'Hinjewadi IT Park, Pune 411057, Maharashtra, India';
// Acquirers match these against MCA master data and the GST certificate, so they
// live in one place here rather than being retyped per page.
const CIN = 'U62011PN2026PTC260563';
const GSTIN = '27ABGCA7851D1ZN';
const SUPPORT_EMAIL = 'support@archagentix.com';
const SUPPORT_PHONE_DISPLAY = '+91 93705 80836';
const SUPPORT_PHONE_URI = '+919370580836';
const SUPPORT_PHONE_SCHEMA = '+91-9370580836';

// slug: where the page is served; source: the document it is rendered from;
// route: the SPA hash route that renders the same document, which is what the
// markdown uses for a cross-reference.
const LEGAL_PAGES = [
  {
    slug: 'terms',
    route: 'terms',
    source: 'legal/terms.md',
    title: 'Terms of Service — ArchAgentix',
    ogType: 'website',
  },
  {
    slug: 'privacy',
    route: 'privacy',
    source: 'legal/privacy.md',
    title: 'Privacy Policy — ArchAgentix',
    ogType: 'website',
  },
  {
    slug: 'refund-policy',
    route: 'refund',
    source: 'legal/refund.md',
    title: 'Refund and Cancellation Policy — ArchAgentix',
    ogType: 'website',
  },
  {
    slug: 'shipping-policy',
    route: 'shipping',
    source: 'legal/shipping.md',
    title: 'Delivery Policy — ArchAgentix',
    ogType: 'website',
  },
];

const ROUTE_TO_SLUG = Object.fromEntries(LEGAL_PAGES.map((page) => [page.route, page.slug]));

// One line per contents entry: a heading is cut to the clause a reader scans for, so no
// link in the table of contents wraps at 320px (the full heading stays as the h2). Keyed
// by the heading's generated id; an id that is not listed falls back to the full text.
const TOC_LABELS = {
  'terms/1-acceptance-of-this-agreement': '1. Acceptance',
  'terms/5-ai-generated-output-your-responsibility': '5. AI-generated output',
  'terms/6-autonomous-execution-and-local-shell-risk': '6. Autonomous execution',
  'terms/7-third-party-services-and-data-processing': '7. Third-Party Services',
  'terms/8-credentials-and-security-responsibility': '8. Credentials and security',
  'terms/10-third-party-components-open-source-notice': '10. Third-Party Components',
  'terms/14-term-subscriptions-and-termination': '14. Term and termination',
  'terms/15-export-compliance-and-lawful-use': '15. Export and lawful use',
  'terms/16-governing-law-and-dispute-resolution': '16. Governing law',
  'privacy/1-who-we-are-and-your-two-possible-relationships-with-us': '1. Who we are',
  'privacy/2-the-personal-data-we-handle-and-the-purpose-of-each': '2. The data we handle',
  'privacy/3-consent-and-how-you-take-it-back': '3. Consent and withdrawal',
  'privacy/4-identity-and-authentication-data': '4. Identity data',
  'privacy/5-workspace-and-operational-data': '5. Workspace data',
  'privacy/6-credentials-and-security-safeguards': '6. Credentials and safeguards',
  'privacy/7-browser-storage-cookies-and-essential-functionality': '7. Cookies and storage',
  'privacy/8-optional-google-analytics-4-telemetry': '8. Analytics telemetry',
  'privacy/10-transfers-of-personal-data-outside-india': '10. Data outside India',
  'privacy/11-how-long-we-keep-it-and-deletion': '11. Retention and deletion',
  'privacy/12-your-rights-and-how-to-exercise-each': '12. Your rights',
  'privacy/14-if-our-security-fails-breach-notification': '14. Breach notification',
  'refund-policy/3-cancelling-your-subscription': '3. Cancelling',
  'shipping-policy/2-what-is-delivered-and-how-fast': '2. What is delivered',
  'shipping-policy/5-if-delivery-does-not-happen': '5. Failed delivery',
  'shipping-policy/6-taxes-and-statutory-documents': '6. Taxes and documents',
};

// The footer an acquirer reads must name the entity, the office, the phone and all
// five policy documents on every page, including the policy pages themselves.
const POLICY_LINKS = [
  ['terms', 'Terms of Service'],
  ['privacy', 'Privacy Policy'],
  ['refund-policy', 'Refund & Cancellation'],
  ['shipping-policy', 'Delivery Policy'],
];

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// In-document links use the SPA's hash routes; on a static page they must name the
// static sibling instead, or they leave the document for an app shell.
function rewriteLinkHref(href) {
  if (!href.startsWith('#/')) return href;
  const [route] = href.slice(2).split(/[/?]/);
  const slug = ROUTE_TO_SLUG[route];
  if (!slug) return href;
  return `/${slug}/`;
}

function renderInline(source) {
  let out = '';
  let index = 0;
  let literal = '';
  const flush = () => {
    if (literal) out += escapeHtml(literal);
    literal = '';
  };
  while (index < source.length) {
    const rest = source.slice(index);
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/u.exec(rest);
    if (link) {
      flush();
      out += `<a href="${escapeHtml(rewriteLinkHref(link[2]))}">${escapeHtml(link[1])}</a>`;
      index += link[0].length;
      continue;
    }
    const strong = /^\*\*([^*]+)\*\*|^__([^_]+)__/u.exec(rest);
    if (strong) {
      flush();
      out += `<strong>${escapeHtml(strong[1] || strong[2])}</strong>`;
      index += strong[0].length;
      continue;
    }
    const code = /^`([^`]+)`/u.exec(rest);
    if (code) {
      flush();
      out += `<code>${escapeHtml(code[1])}</code>`;
      index += code[0].length;
      continue;
    }
    literal += source[index];
    index += 1;
  }
  flush();
  return out;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// An item's text wraps onto indented continuation lines, which belong to the item
// rather than becoming a paragraph of their own.
function collectList(lines, start, opener) {
  const items = [];
  let index = start;
  while (index < lines.length) {
    const raw = lines[index];
    const item = opener.exec(raw.trim());
    if (item) {
      items.push(item[1].trim());
      index += 1;
      continue;
    }
    if (items.length && /^[ \t]+\S/u.test(raw)) {
      items[items.length - 1] += ` ${raw.trim()}`;
      index += 1;
      continue;
    }
    break;
  }
  return { items, next: index };
}

// A deliberately small Markdown subset — headings, paragraphs, lists, blockquotes,
// rules, links, bold and code — covering what the documents in public/legal/ use.
// It mirrors the intent of public/js/legal-markdown.mjs rather than sharing it: this
// runs in node at build time, that one runs in the browser.
function renderMarkdown(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const headings = [];
  let paragraph = [];
  let index = 0;

  const closeParagraph = () => {
    if (paragraph.length) {
      blocks.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      closeParagraph();
      index += 1;
      continue;
    }
    if (/^-{3,}$|^\*{3,}$|^_{3,}$/u.test(trimmed)) {
      closeParagraph();
      blocks.push('<hr />');
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(trimmed);
    if (heading) {
      closeParagraph();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugify(text);
      headings.push({ level, text, id });
      blocks.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`);
      index += 1;
      continue;
    }
    if (trimmed.startsWith('>')) {
      closeParagraph();
      const quote = [];
      while (index < lines.length && /^\s*>/u.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>[\t ]?/u, '').trim());
        index += 1;
      }
      blocks.push(`<blockquote>\n<p>${renderInline(quote.filter(Boolean).join(' '))}</p>\n</blockquote>`);
      continue;
    }
    // A pipe table must have a separator row under its first row; without one, the
    // line is ordinary text that happens to contain a pipe.
    if (trimmed.startsWith('|') && /^\|?[\s:|-]+\|?$/u.test((lines[index + 1] || '').trim()) && /-/.test(lines[index + 1] || '')) {
      closeParagraph();
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const header = cells(trimmed);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(cells(lines[index]));
        index += 1;
      }
      const thead = `  <thead>\n    <tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr>\n  </thead>`;
      const tbody = rows
        .map((row) => `    <tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
        .join('\n');
      blocks.push(`<table>\n${thead}\n  <tbody>\n${tbody}\n  </tbody>\n</table>`);
      continue;
    }
    const bullet = /^[-+*]\s+(.+)$/u.exec(trimmed);
    if (bullet) {
      closeParagraph();
      const items = collectList(lines, index, /^[-+*]\s+(.+)$/u);
      blocks.push(`<ul>\n${items.items.map((item) => `  <li>${renderInline(item)}</li>`).join('\n')}\n</ul>`);
      index = items.next;
      continue;
    }
    const numbered = /^\d{1,9}[.)]\s+(.+)$/u.exec(trimmed);
    if (numbered) {
      closeParagraph();
      const items = collectList(lines, index, /^\d{1,9}[.)]\s+(.+)$/u);
      blocks.push(`<ol>\n${items.items.map((item) => `  <li>${renderInline(item)}</li>`).join('\n')}\n</ol>`);
      index = items.next;
      continue;
    }
    paragraph.push(trimmed);
    index += 1;
  }
  closeParagraph();

  // The H1 is the page title the template already prints, so drop it from the body.
  const body = blocks.filter((block) => !/^<h1 /u.test(block)).join('\n');
  return { html: body, headings };
}

function pageTemplate(page, bodyHtml, headings) {
  const url = `${CANONICAL_ORIGIN}/${page.slug}/`;
  const description = `${page.title.split(' — ')[0]} for the Archagentix platform: terms, cancellation and refund windows, and delivery timelines. Contact ${SUPPORT_EMAIL}.`;
  // The published pages carry the wordmark in <title> and the registered name in
  // og:title; the redesign edit caught one and not the other. Reproduced here so the
  // generator emits the shipped bytes, and worth unifying in its own change.
  const ogTitle = page.title.replace('ArchAgentix', 'Archagentix');
  const toc = headings
    .filter((heading) => heading.level === 2)
    .map((heading) => {
      const label = TOC_LABELS[`${page.slug}/${heading.id}`] || heading.text;
      return `<li><a href="#${heading.id}">${escapeHtml(label)}</a></li>`;
    })
    .join('\n          ');
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(page.title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
    <meta name="theme-color" content="#f8f9f9" />
    <link rel="icon" type="image/svg+xml" href="/brand/favicon.svg" />
    <link rel="icon" type="image/png" sizes="16x16" href="/brand/favicon-16.png" />
    <link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/brand/apple-touch-icon.png" />
    <link rel="canonical" href="${url}" />
    <link rel="describedby" type="text/markdown" href="/llms.txt" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600&family=IBM+Plex+Sans:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/adlc/styles.css" />
    <meta property="og:type" content="${page.ogType}" />
    <meta property="og:site_name" content="ArchAgentix" />
    <meta property="og:url" content="${url}" />
    <meta property="og:title" content="${escapeHtml(ogTitle)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:image" content="${CANONICAL_ORIGIN}/brand/og-image.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Archagentix — the Agentic Development Life Cycle" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="${CANONICAL_ORIGIN}/brand/og-image.png" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": "https://www.archagentix.com/#organization",
        "name": "${ENTITY}",
        "identifier": [
          { "@type": "PropertyValue", "propertyID": "CIN", "value": "${CIN}" },
          { "@type": "PropertyValue", "propertyID": "GSTIN", "value": "${GSTIN}" }
        ],
        "url": "${CANONICAL_ORIGIN}/",
        "logo": "${CANONICAL_ORIGIN}/brand/icon-512.png",
        "email": "${SUPPORT_EMAIL}",
        "telephone": "${SUPPORT_PHONE_SCHEMA}",
        "address": {
          "@type": "PostalAddress",
          "streetAddress": "Hinjewadi IT Park",
          "addressLocality": "Pune",
          "addressRegion": "Maharashtra",
          "postalCode": "411057",
          "addressCountry": "IN"
        },
        "description": "Creators of the Agentic Development Life Cycle (ADLC). Ship software with agents in the loop and humans in control."
      }
    </script>
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "WebPage",
        "url": "${url}",
        "name": "${escapeHtml(page.title.split(' — ')[0])}",
        "inLanguage": "en",
        "isPartOf": { "@id": "https://www.archagentix.com/#organization" },
        "publisher": { "@id": "https://www.archagentix.com/#organization" }
      }
    </script>
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>

    <header class="site-header">
      <a class="brand wm" href="/adlc/" aria-label="ArchAgentix home">
        <span class="brand-mark" aria-hidden="true"></span>
        <span>ArchAgentix</span>
      </a>
      <div class="header-side">
        <details class="nav-menu">
          <summary>Menu</summary>
          <nav aria-label="Primary">
            <a href="/adlc/">ADLC</a>
            <a href="/archagentix/">Model intelligence</a>
            <a href="/pricing/">Pricing</a>
            <a href="/adlc/blog/">Blog</a>
            <a href="/about/">About</a>
            <a href="/contact/">Contact</a>
          </nav>
        </details>
        <a class="key" href="${PLATFORM_ORIGIN}/" data-try-now>Try now</a>
      </div>
    </header>

    <main id="main">
      <section class="page-head" aria-labelledby="page-title">
        <div class="container">
          <h1 id="page-title">${escapeHtml(page.title.split(' — ')[0])}</h1>
          <p class="lede">Published by ${ENTITY}, ${ADDRESS}. CIN ${CIN}, GSTIN ${GSTIN}.</p>
          <div class="head-actions">
            <a class="textlink" href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>
            <a class="textlink" href="tel:${SUPPORT_PHONE_URI}">${SUPPORT_PHONE_DISPLAY}</a>
          </div>
        </div>
      </section>
      <section class="prose">
        <div class="container">
          <div class="measure">
        <nav class="toc" aria-label="Contents">
          <p class="toc-title">Contents</p>
          <ul>
          ${toc}
          </ul>
        </nav>
${bodyHtml}
                </div>
        </div>
      </section>

    </main>

    <footer class="site-footer" aria-label="Site footer">
      <div class="container colophon">
        <p class="wordmark wm"><span class="brand"><span class="brand-mark" aria-hidden="true"></span> ArchAgentix</span></p>
        <p>Creators of the Agentic Development Life Cycle (ADLC). Ship software with agents in the loop and humans in control.</p>
        <nav aria-label="Site">
          <a href="/about/">About Company</a>
          <a href="/careers/">Careers</a>
          <a href="/newsroom/">Newsroom</a>
          <a href="/contact/">Contact Us</a>
          <a href="/pricing/">Pricing</a>
          <a href="/adlc/blog/">Blog</a>
          <a href="/archagentix/">Model intelligence</a>
          <a href="/adlc/brief/">Full brief</a>
          <a href="${PLATFORM_ORIGIN}/" rel="noopener">ArchAgentix Platform</a>
        </nav>
        <p class="legal">
            © 2026 ${ENTITY}<br />
            ${ADDRESS}
            <span class="legal-links"><a href="tel:${SUPPORT_PHONE_URI}">${SUPPORT_PHONE_DISPLAY}</a><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></span>
            <span class="legal-links">${POLICY_LINKS.map(([slug, label]) => `<a href="/${slug}/">${escapeHtml(label)}</a>`).join('')}</span>
          </p>
      </div>
    </footer>
    <script src="/adlc/config.js"></script>
    <script defer src="/adlc/app.js"></script>
  </body>
</html>
`;
}

function buildLegalPages(options) {
  const settings = options || {};
  const srcDir = settings.srcDir || path.join(ROOT, 'public');
  const written = [];
  for (const page of LEGAL_PAGES) {
    const markdown = fs.readFileSync(path.join(srcDir, page.source), 'utf8');
    const rendered = renderMarkdown(markdown);
    const html = pageTemplate(page, rendered.html, rendered.headings);
    const dest = path.join(srcDir, page.slug, 'index.html');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== html) {
      fs.writeFileSync(dest, html);
      written.push(path.relative(srcDir, dest));
    }
  }
  return written;
}

function checkFresh(srcDir) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-pages-check-'));
  const publicScratch = path.join(scratch, 'public');
  fs.cpSync(srcDir, publicScratch, { recursive: true });
  try {
    const written = buildLegalPages({ srcDir: publicScratch });
    if (written.length) {
      throw new Error(`generated legal pages are out of date (${written.join(', ')}) - run node scripts/build-legal-pages.js`);
    }
    process.stdout.write('legal pages are fresh\n');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = {};
  for (const flag of argv) {
    if (flag === '--check') args.check = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.check) checkFresh(path.join(ROOT, 'public'));
    else process.stdout.write(`wrote ${buildLegalPages().length} legal pages\n`);
  } catch (error) {
    process.stderr.write(`build-legal-pages: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  LEGAL_PAGES,
  POLICY_LINKS,
  ROUTE_TO_SLUG,
  TOC_LABELS,
  CIN,
  GSTIN,
  buildLegalPages,
  checkFresh,
  escapeHtml,
  pageTemplate,
  parseArgs,
  renderInline,
  renderMarkdown,
  slugify,
};
