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

### 1. Automated test suites — 24/24 pass

```text
$ node --test scripts/seo-archagentix.test.js scripts/seo-discovery.test.js public/adlc/adlc-static.test.mjs
ℹ tests 24
ℹ pass 24
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
  the entity name, and Privacy/Terms — and the platform footer gained the same;
- the GCP hosting wiring is pinned: `firebase.json` targets `app`/`www` with the
  www site id equal to Terraform's `local.marketing_site_id`, `deploy-www.yml`
  deploys `--only hosting:www` (keyless WIF, **no** SPA-obfuscation step),
  `deploy.yml` deploys `--only hosting:app`, and `bootstrap.sh`/`deploy.sh`
  carry the marketing-domain pass-through plus the DNS-cutover manual steps.

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

## How www.archagentix.com is served — GCP Firebase Hosting, same project

> **The website has moved to GCP.** `www.archagentix.com` was previously a
> static site on Hostinger (pushed by FTP). It is now served entirely from
> this GCP project by Firebase Hosting, and every future change ships through
> the `deploy-www.yml` workflow — the FTP push is retired after the DNS
> cutover below.

| Piece | Where |
|---|---|
| Hosting site | `adlc-9e72f-marketing` (default host: `https://adlc-9e72f-marketing.web.app`) — Terraform-managed by `google_firebase_hosting_site.marketing` in `deploy/gcp/terraform/firebase.tf`. The id is `-marketing`, **not** `-www`: the Hosting API rejects site ids ending in `-www` ("Invalid name …") |
| Custom domain | `google_firebase_hosting_custom_domain.marketing` attaches `www.archagentix.com` to the marketing site (not the app site); `wait_dns_verification = false` keeps the apply non-blocking pre-cutover. Toggle via `var.marketing_custom_domain` |
| Hosting config | `firebase.json` → `hosting` is an array of **target-keyed** configs (`app`, `www`) — each entry may carry `site` OR `target`, never both, so the site ids are bound in `.firebaserc` (`firebase target:apply` format). `app` publishes `public/` (the SPA + `/adlc/**`); `www` publishes the generated `marketing/` tree, where the ADLC pages sit at the **site root** |
| Marketing tree | `scripts/build-marketing-site.js` builds `marketing/` from `public/` on every www release (gitignored artifact, never hand-edited). It promotes `public/adlc/**` to the root, copies the company pages + discovery files, rewrites `/adlc/` paths, and regenerates `sitemap.xml` for the new URL scheme. `node scripts/build-marketing-site.js --check` fails if the local tree is stale |
| Legacy `/adlc/**` URLs | 301 redirects on the `www` target only (`/adlc`, `/adlc/` → `/`, `/adlc/**` → `/:splat`), so the pre-existing links and the old sitemap entries keep their signal. `platform.archagentix.com/adlc/**` still serves the files |
| Continuous deployment | `.github/workflows/deploy-www.yml` — path-filtered to marketing content (`public/pricing/**`, `public/about/**`, `public/careers/**`, `public/newsroom/**`, `public/contact/**`, `public/adlc/**`, `sitemap.xml`, `robots.txt`, `llms*.txt`, the generator, `firebase.json`, `.firebaserc`), keyless WIF auth, regenerates `adlc/config.js`, builds `marketing/`, then `firebase deploy --only hosting:www`. No SPA obfuscation step and no `public/config.js`: the marketing tree has no SPA bundle and no gateway/AI-Analytics config |
| App CD | `deploy.yml` deploy-spa job now publishes `--only hosting:app` only — marketing edits never roll the platform and vice versa |
| Auth & CORS | Identity Platform `authorized_domains` and the gateway's `FIREBASE_CUSTOM_DOMAIN` allowlist include the marketing domain automatically (`local.marketing_domains`) |

Content mapping on `www.archagentix.com` (upload root = generated `marketing/`):

| Canonical URL | Source in this repo | marketing/ path |
|---|---|---|
| `/` | `public/adlc/index.html` | `index.html` (self-canonical `https://www.archagentix.com/`) |
| `/blog/` `/blog/<post>/` `/brief/` | `public/adlc/blog/**`, `public/adlc/brief/**` | promoted, same relative path |
| `/styles.css` `/app.js` `/sw.js` `/manifest.webmanifest` `/config.js` | `public/adlc/*` | root assets (worker + manifest scope `/`) |
| `/pricing/` `/about/` `/careers/` `/newsroom/` `/contact/` | `public/<slug>/index.html` | copied verbatim |
| `/sitemap.xml` | generated by the build script | 14 promoted URLs, every `<loc>` backed by a file |
| `/robots.txt` `/llms.txt` `/llms-full.txt` | `public/*` | copied (path rewrites applied) |
| `/adlc/**` | — | not present; 301 → the promoted path |

Two consequences of moving the marketing site to the root, both intentional:

- The www root no longer serves the workspace shell, so `#/privacy` / `#/terms`
  hash routes are rewritten to `https://platform.archagentix.com/#/…` in the
  generated tree (the SPA that implements them lives on the app host).
- Google Analytics is injected by the SPA (`public/js/google-analytics.mjs` via
  `public/config.js`), so the static marketing pages on www carry no GA tag. The
  platform host keeps reporting as before. Add a per-page `gtag` snippet to the
  generator if www traffic must be measured too.

`platform.archagentix.com` keeps serving the application and the `/adlc/` copy of
every page; each of those copies declares the `www.archagentix.com` canonical —
intentional, it consolidates SEO signal on one domain.

### One-time cutover from Hostinger — manual steps

1. **Provision the GCP side (one-time).** After merge, run Terraform once for
   just the marketing resources (or let the normal CD apply do it — it only
   creates, and `wait_dns_verification = false` keeps it non-blocking):

   ```bash
   terraform -chdir=deploy/gcp/terraform apply \
     -target=google_firebase_hosting_site.marketing \
     -target=google_firebase_hosting_custom_domain.marketing
   ```

   The site `adlc-9e72f-marketing` now exists and the domain is registered in
   **pending** state.
2. **Read the required DNS records** (site-specific): Firebase console →
   Hosting → `adlc-9e72f-marketing` → Manage domains, or
   `terraform -chdir=deploy/gcp/terraform output`/`state show` on the domain
   resource — `pendingVerification.siteConstraint` lists them. For a hosted
   subdomain expect: `CNAME www → adlc-9e72f-marketing.ghs.googlehosted.com`.
3. **Cut DNS at the registrar:** remove the Hostinger A/AAAA records for `www`
   and add the CNAME above. Leave the apex/other records alone. DNS still
   resolves to Hostinger until this flips — the FTP-pushed copy keeps serving.
4. **Verify + certify:** the domain reaches `ACTIVE` and Firebase provisions the
   TLS cert automatically (minutes to a few hours). Then run the workflow once
   manually so the first live release comes from CD, not the old FTP tree:
   `gh workflow run deploy-www.yml --repo niravshah2705/symphony --ref main`
5. **Decommission:** after verifying (below), stop the Hostinger FTP pushes and
   let the old static host expire.

### Post-publish verification

```bash
curl -s https://www.archagentix.com/robots.txt            | grep Sitemap
curl -s https://www.archagentix.com/sitemap.xml | xmllint --noout - && echo "sitemap OK"
for u in pricing about careers newsroom contact blog brief; do
  curl -s -o /dev/null -w "/$u/ -> %{http_code}\n" "https://www.archagentix.com/$u/"
done
curl -s https://www.archagentix.com/ | grep -A2 '"@type": "Organization"'
# the promoted pages answer at the root, and the old /adlc/ urls 301 to them
curl -s https://www.archagentix.com/ | grep -c 'rel="canonical" href="https://www.archagentix.com/"'
for u in /adlc/ /adlc/blog/ /adlc/brief/ /adlc/blog/governance/; do
  curl -s -o /dev/null -w "$u -> %{http_code} %{redirect_url}\n" "https://www.archagentix.com$u"
done
```

All 14 www sitemap URLs must return `200` with their own root canonical, and every
`/adlc/**` URL must return `301` to its promoted path (the repo tests
`every sitemap URL is backed by a literal crawlable file on disk` for the app tree
and `the generated sitemap lists promoted urls backed by files` for the www tree
guarantee this before you push).

### Legacy: direct FTP push to Hostinger (only until the cutover)

`lftp` mirrors `public/` onto the Hostinger webroot; keep using it while DNS
still points there (test files excluded):

```bash
FTP_HOST=your-hostinger-host lftp -e "
  set ftp:ssl-force true; cd /public_html;
  mirror --reverse --delete --exclude '**/*.test.mjs' public; quit;
" -u "$FTP_USER,$FTP_PASS" "ftp://$FTP_HOST"
```

## Remaining operational steps

- Submit the new sitemap in Google Search Console / Bing WMT for
  `www.archagentix.com` after the cutover.
- Request CDN re-invalidation if you change `sitemap.xml`/`robots.txt` outside
  CD (both are served `no-cache` per `firebase.json` headers anyway).
- If the old `adlc-9e72f.web.app` host stays reachable, add a 301 →
  `https://www.archagentix.com` (hosting redirects) to pass residual link equity.
