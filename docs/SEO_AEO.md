# SEO / AEO remediation — www.archagentix.com

Date: 2026-11-03 · Branch context: symphony marketing relaunch

## Problem

1. `public/sitemap.xml` published the legacy Firebase preview origin
   (`https://adlc-9e72f.web.app/...`). Search engines indexing
   `www.archagentix.com` were served a sitemap pointing at a different host, and
   every page's `rel="canonical"` / `og:url` repeated the old origin — so the
   canonical brand domain competed with a throwaway `web.app` alias and SEO
   signal was split (and effectively lost).
2. No structured data identified the company (Organization) anywhere.
3. The marketing "Try now" CTAs linked to the same-origin hash route
   (`/#/agent`) instead of the hosted platform.
4. The marketing site had no footer (the platform app does), no company pages
   (About / Careers / Newsroom / Contact), and no Pricing page.

## What was changed

### Canonical domain (SEO)

| File | Change |
|---|---|
| `public/sitemap.xml` | Fully rebuilt. All `<loc>` entries are now `https://www.archagentix.com/...`. 15 URLs, every one backed by a literal `index.html` on disk (crawlable — no hash routes, no SPA-rewrite fall-throughs). |
| `public/robots.txt` | `Sitemap:` directive → `https://www.archagentix.com/sitemap.xml`. AI crawlers (GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, Google-Extended, …) remain explicitly allowed — AEO. |
| `public/index.html` (www root + platform shell) | `canonical`, `og:url`, and all JSON-LD `@id`/`url` re-pointed to `https://www.archagentix.com/`. |
| `public/adlc/**/index.html` (9 pages) | Static `canonical` + `og:url` → `https://www.archagentix.com/adlc/...`. |
| `public/adlc/config.js`, `public/llms.txt`, `public/llms-full.txt` | Legacy `adlc-9e72f.web.app` origin removed; discovery documents now cite `www.archagentix.com`. |
| `.github/workflows/deploy.yml` | Deploy-time regeneration of `adlc/config.js` now defaults `ADLC_TRY_NOW_URL=https://platform.archagentix.com/` and `ADLC_CANONICAL_ORIGIN=https://www.archagentix.com`, so a CI deploy cannot resurrect the old values. |

### Organization structured data (SEO + AEO)

The exact `application/ld+json` `Organization` block (name *Archagentix Private
Limited*, url `https://www.archagentix.com/`, email `archagentix@gmail.com`,
PostalAddress Pune / Maharashtra / 411057 / IN, ADLC description) is now embedded
on:

- `public/index.html` (www root)
- `public/adlc/index.html` (marketing landing)
- `public/pricing/index.html`, `public/about/index.html`,
  `public/careers/index.html`, `public/newsroom/index.html`,
  `public/contact/index.html`

Additional types: `FAQPage` + `Product`/`Offer` (pricing), `AboutPage` (about),
`JobPosting` (careers), `CollectionPage` (newsroom), `ContactPage` +
`contactPoint` (contact), and the pre-existing `WebSite` /
`SoftwareApplication` / `DefinedTerm` graph on the root.

### Try now → platform.archagentix.com

- All `data-try-now` anchors in the 9 `/adlc/` pages changed from `/#/agent` to
  `https://platform.archagentix.com/` (static HTML — works without JS).
- `public/adlc/config.js` → `tryNowUrl: 'https://platform.archagentix.com/'`;
  `app.js` fallback updated to match.
- All new marketing pages use the same CTA.

### New pages + navigation + footer

- New static pages: `/pricing/`, `/about/`, `/careers/`, `/newsroom/`,
  `/contact/` (each a literal `public/<slug>/index.html`).
- **Pricing added to the top navigation** (`<nav aria-label="Primary">`) of
  every marketing page, including the existing `/adlc/` pages.
- **Footer** (`.site-footer`, styled in `public/adlc/styles.css`) added to all
  9 `/adlc/` pages and all 5 new pages. Like the platform footer it carries the
  legal line (© Archagentix Private Limited, Privacy, Terms); **the bottom
  Company column adds About Company, Careers, Newsroom, Contact Us**, plus an
  Explore column (Pricing, Blog, Full brief, Try now).
- The platform SPA footer (`public/index.html`) also gained the same four
  company links in an `aria-label="Company"` nav.

## Proof

All commands were run from the repo root on 2026-11-03.

### 1. Automated test suites — 21/21 pass

```text
$ node --test scripts/seo-archagentix.test.js scripts/seo-discovery.test.js public/adlc/adlc-static.test.mjs
ℹ tests 21
ℹ pass 21
ℹ fail 0
```

The new suite `scripts/seo-archagentix.test.js` asserts:

- every sitemap `<loc>` is on `https://www.archagentix.com` (no legacy host, no
  fragments, no duplicates);
- **every sitemap URL is backed by a literal `index.html` on disk** (proof it is
  crawlable and will not silently fall through to the SPA rewrite);
- sitemap covers home, pricing, the four company pages, and the ADLC hub;
- `robots.txt` advertises the canonical sitemap and keeps AI crawlers allowed;
- zero `adlc-9e72f` references remain in any public page/config/discovery file;
- exactly one valid `Organization` JSON-LD block with the exact fields on all
  seven marketing surfaces; every JSON-LD block under `public/` parses;
- every Try-now/Start-free CTA resolves to `https://platform.archagentix.com/`
  (static HTML + `config.js` + `app.js` + deploy-workflow defaults);
- Pricing appears in the header nav of every marketing page;
- pricing page exposes 3 plans + `Product` (3 offers) + `FAQPage` schema;
- each new page is self-canonical, has a substantial meta description, robots
  directive, og:title, and exactly one H1;
- footer on every page contains About Company / Careers / Newsroom / Contact Us,
  the entity name, and Privacy/Terms — and the platform footer gained the same.

Existing Playwright e2e updated (`e2e/adlc.spec.js`): asserts the Try-now href,
the `www.archagentix.com/adlc/` canonical applied at runtime by `app.js`, and
the footer's company sections.

### 2. Sitemap is well-formed XML

```text
$ xmllint --noout public/sitemap.xml
sitemap.xml: VALID XML (well-formed, schema-conformant namespace)
```

### 3. Legacy domain sweep

```text
$ grep -rn "adlc-9e72f" public/
zero references to adlc-9e72f.web.app under public/
```

### 4. Live crawl of every sitemap URL (local static server emulating Firebase Hosting rules)

All 15 URLs returned `200 [static]` (served from their literal `index.html`, not
the SPA catch-all rewrite), each with a self-referential canonical on
`www.archagentix.com`. Sample:

```text
200 [static] https://www.archagentix.com/            canonical: https://www.archagentix.com/
200 [static] https://www.archagentix.com/pricing/    canonical: https://www.archagentix.com/pricing/
200 [static] https://www.archagentix.com/adlc/       canonical: https://www.archagentix.com/adlc/
200 [static] https://www.archagentix.com/about/      canonical: https://www.archagentix.com/about/
200 [static] https://www.archagentix.com/careers/    canonical: https://www.archagentix.com/careers/
200 [static] https://www.archagentix.com/newsroom/   canonical: https://www.archagentix.com/newsroom/
200 [static] https://www.archagentix.com/contact/    canonical: https://www.archagentix.com/contact/
... (15/15 static; robots sitemap line: Sitemap: https://www.archagentix.com/sitemap.xml)
```

## AEO (answer-engine optimization) notes

- `robots.txt` explicitly allows ChatGPT / Claude / Perplexity / Google / Grok
  crawlers and `User-agent: *`, disallowing only `/api/`.
- `llms.txt` / `llms-full.txt` discovery documents now cite
  `https://www.archagentix.com` as the canonical source, and every page links
  `rel="describedby" → /llms.txt`.
- Question-shaped `FAQPage` markup on Pricing; entity-defining `Organization`
  block site-wide; the "Ask about ADLC on …" assistant launcher is preserved in
  the platform footer.

## How www.archagentix.com is served

`www.archagentix.com` is a **static website hosted in a separate GCP account** —
it is deliberately NOT a Firebase Hosting custom domain of this project (the
Terraform custom-domain resources stay platform-only). Everything the marketing
domain needs lives under `public/`, and every sitemap `<loc>` maps 1:1 to a
path under the static webroot, so publishing is a pure file push (FTP/SFTP):

| Canonical URL (www.archagentix.com) | File in this repo (upload root = `public/`) |
|---|---|
| `/` | `index.html` (+ SPA assets `js/ vendor/ styles/ config.js styles.css` if the www root serves the app shell) |
| `/pricing/` | `pricing/index.html` |
| `/about/` | `about/index.html` |
| `/careers/` | `careers/index.html` |
| `/newsroom/` | `newsroom/index.html` |
| `/contact/` | `contact/index.html` |
| `/adlc/**` | `adlc/**` (landing, blog, brief, `styles.css`, `app.js`; `config.js` is regenerated per-deploy on Firebase — on www it may be uploaded as-is) |
| `/sitemap.xml` `/robots.txt` `/llms.txt` `/llms-full.txt` | same-named files in `public/` |

`platform.archagentix.com` (this Firebase site) keeps serving the application;
the `/adlc/` pages exist on both hosts, and every copy declares the
`www.archagentix.com` canonical — that is intentional and keeps SEO signal on
one domain.

### Publish with FTP (or SFTP)

Run from the repo root. `lftp` mirrors `public/` onto the remote webroot;
`--delete` keeps removals in sync, excludes skip test files that are not web
content:

```bash
FTP_HOST=your-static-host.example.com FTP_USER=archagentix-web FTP_PASS='***' \
FTP_ROOT=/var/www/www.archagentix.com lftp -e "
  set ftp:ssl-force true;
  set ssl:verify-certificate no;
  cd \"$FTP_ROOT\";
  mirror --reverse --delete \
    --exclude 'archagentix/archagentix-static.test.mjs' \
    --exclude 'adlc/adlc-static.test.mjs' \
    --exclude '**/*.test.mjs' \
    public;
  quit;
" -u "$FTP_USER,$FTP_PASS" "ftp://$FTP_HOST"
```

If the host accepts SFTP, swap the URL scheme — same command:

```bash
lftp -e "cd \"$FTP_ROOT\"; mirror --reverse --delete --exclude '**/*.test.mjs' public; quit" \
  -u "$FTP_USER,$FTP_PASS" "sftp://$FTP_HOST"
```

Individual-file push with plain `curl` (handy for hot-fixing the sitemap):

```bash
for f in sitemap.xml robots.txt llms.txt llms-full.txt; do
  curl -sT "public/$f" --user "$FTP_USER:$FTP_PASS" "ftp://$FTP_HOST/$f"
done
```

### Post-publish verification

```bash
curl -s https://www.archagentix.com/robots.txt            | grep Sitemap
curl -s https://www.archagentix.com/sitemap.xml | xmllint --noout - && echo "sitemap OK"
for u in pricing about careers newsroom contact; do
  curl -s -o /dev/null -w "/$u/ -> %{http_code}\n" "https://www.archagentix.com/$u/"
done
curl -s https://www.archagentix.com/ | grep -A2 '"@type": "Organization"'
```

All 15 sitemap URLs must return `200` with their own canonical (the repo test
`every sitemap URL is backed by a literal crawlable file on disk` guarantees
this before you push).

## Remaining operational steps

- Submit the new sitemap in Google Search Console / Bing WMT for
  `www.archagentix.com` after the FTP publish.
- On the Firebase side, request CDN re-invalidation after `firebase deploy`
  (sitemap.xml/robots.txt are served `no-cache` per `firebase.json` headers).
- If the old `adlc-9e72f.web.app` host stays reachable, add a 301 →
  `https://www.archagentix.com` (hosting redirects) to pass residual link equity.
