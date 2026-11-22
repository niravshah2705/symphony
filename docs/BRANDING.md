# Branding — findings as found

Audited 2026-11-22 from `public/` at `d5923876`, during a Hallmark redesign pre-flight
(`main` untouched; **this document changes no code, CSS or markup**).

Method: file and token inventory of all 21 HTML pages, 8 stylesheets and `js/views/`;
the local fleet served via `npm start` on `:1456`; a baseline recorded with
`sloplint --render --before` (the full record is local-only, in `.hallmark/`).
Every line below is a citation, not a recollection — nothing here is themed from memory.

## 1. The brand as it is stated

| Signal | Where | What it is |
| --- | --- | --- |
| Name | `index.html:12`, JSON-LD `Brand` `index.html:57` | **Archagentix** |
| Product | `index.html:52`, `alternateName` `index.html:41,53` | **Software Factory**, alias **ADLC Workspace**, alias **AI Fleet** |
| Wordmark | `index.html:143`–`145`, `:258` | `.brand-mark` — three 4px bars drawn in CSS `div`s. No logo file exists. |
| Manifest | `adlc/manifest.webmanifest` | `name: "ADLC by Software Factory"`, `theme_color: #16201d` |
| Sites | `firebase.json` | `app` → `public/` (`platform.archagentix.com`), `www` → `marketing/` (`www.archagentix.com`) |

Four names for one thing (Archagentix / Software Factory / ADLC / AI Fleet) is the first
branding finding: the product never says which name is the brand and which is the
surface. `GLOSSARY.md` is canonical for the two egress terms but defines no brand voice.

## 2. There are no brand assets

- **Zero image files in the entire target.** No PNG, JPG, WebP, ICO or AVIF anywhere under
  `public/`. The only graphics are 8 SVGs under `icons/plugins/` and `icons/skills/`, which
  are third-party plugin marks, not ours.
- **The favicon is an emoji.** `index.html:208`–`209` declares the only `rel="icon"` in the
  target as a data-URI SVG wrapping `📋`. The browser tab, bookmark and history icon for the
  product is a clipboard glyph. Gate 30a names emoji-as-icon outright.
- **No social preview image on any page.** `og:image` / `twitter:image` appear on **0 of 21**
  pages; `twitter:card` is `summary` (`index.html:25`), the smallest possible card. Every
  shared link renders as text with no picture.
- **The install icon is a data-URI too** (`adlc/manifest.webmanifest`) — the only logo-like
  artwork in the product is two inline SVG strings, neither reusable as a file.
- `marketing/` is a separate tree with its own `styles.css` and is out of this target, so the
  two hosts can drift without either being wrong.

## 3. The brand typefaces are never delivered

Named in tokens, absent from the wire:

| Token | Value | Delivered? |
| --- | --- | --- |
| `--font-sans` | `styles.css:40` | Inter — **never loaded** |
| `--font-display` | `styles.css:41` | Space Grotesk — **never loaded** |
| `--font-mono` | `styles.css:42` | JetBrains Mono — **never loaded** |
| `--font-serif` | `styles.css:37` | Georgia — a system face, always available |

**Zero `@font-face` rules, zero `fonts.googleapis` links, no `.woff2` under `public/`**
(`vendor/` holds only `firebase/`). The comment at `styles.css:38`–`39` says the names are
"Named first for fidelity; fall back to system stacks until the woff2 files are vendored" —
that vendoring never happened. So the display face the code advertises (Space Grotesk) never
renders on any machine, and what actually ships is Inter → `-apple-system`/Segoe on
whichever OS opens the page.

The consequence is a split voice: the tokens claim a geometric sans, but the real display
type is **Georgia**, because `--font-serif` is what heads actually use —
`.auth-card h1` (`styles.css:488`), `.page-head h1` (`:512`), `.legal-document h1/h2`
(`:409`–`410`), the cookie dialog head (`:384`). A serif is the de-facto display face of the
product while the stylesheet names a sans. The `adlc` site is Inter-never-loaded on
everything (`adlc/styles.css:12`) and `archagentix` is the bare system stack
(`archagentix/styles.css:16`). Gate 37 counts **4 families** at `styles.css:42` against a
ceiling of 3, and the count is generous — none of the three named faces is present.

## 4. Three palettes, one product

| System | Pages | Base | Accent(s) | `theme-color` |
| --- | --- | --- | --- | --- |
| Platform app (dark) | 1 + JS views | `#11141a` `styles.css:3` | `#7088ef` `styles.css:14` | `#15181f` `index.html:13` |
| Platform app (light) | same | `#f6f5f1` `styles.css:47` | `#315cf5` `styles.css:57` — a second accent, not the dark one | not declared |
| ADLC site | 19 | paper `#f7f5ef` `adlc/styles.css:5` | green `#4f8f77`, blue `#476c9b`, orange `#e77d3c` `:8–10` | `#16201d` ×18 |
| Archagentix page | 1 | `#0d1117` `archagentix/styles.css:2` | `#58a6ff` `:7` + `#2ea043`, `#a371f7` | none |

The third row is the finding: `archagentix/styles.css` is GitHub's palette and system-font
stack line for line (`#0d1117`, `#161b22`, `#30363d`, `#58a6ff`, `* { margin:0; padding:0;
font-family: -apple-system… }` at `:13`–`16`), on the page that carries the brand name. A
visitor who lands there is shown another company's identity.

## 5. The look the model chose, not the brand

Things that read as generated, with the file that says so:

- **Inter + periwinkle-indigo on near-black** (`styles.css:14`, `:40`) — the single most
  AI-typical pairing. Not a brand choice; a default.
- **Eyebrows** — `about/index.html:70` "About Company", `adlc/blog/evidence/index.html:56`
  "Process" above `<h1>`; gate 54 fails 25 of them.
- **Tracked-caps / small-caps labels ×60** (gate 67) — e.g. `.article-header .blog-tag`
  11px at `letter-spacing: .05em`, `.actors-card-state` 10px (`styles/operations.css:202`),
  `.sx-eyebrow` / `.sx-scope-kicker` in mono (`settings.css:30`, `:39`).
- **A hand-drawn browser window** — `.terminal-bar` (`adlc/index.html:132`,
  `adlc/styles.css:194`) fakes product chrome instead of showing the product (gate 47b).
- **An emoji as a UI icon** — `✳` in `.omnibox-spark` (`index.html:424`, gate 30a).
- **Middle-dot meta strings** ×6 (`about/index.html:92` "Terms of Service · Privacy Policy ·
  Refund Policy") and **arrows glued to link text** (`adlc/blog/getting-started/index.html:324`
  "Open the workspace →").
- **Em-dashes in copy ×20** (gate 19) and **straight quotes ×11 files** (F1, 53 in one file).
- **A stock legal line** — "All rights reserved" (`index.html:450`, `privacy/index.html:231`).

## 6. Findings the gates hold against the brand

Baseline for the whole target: **Floor 282 FAIL · 732 REFLEX · 93 WARN** across 29 files and
1 URL. Measured per system (each subsystem linted alone):

| System | FAIL | REFLEX | WARN | Files |
| --- | --- | --- | --- | --- |
| Platform app (`index.html`, `styles.css`, `styles/*`) | 115 | 654 | 18 | 7 |
| ADLC site (`adlc/*` + 9 content pages) | 133 | 77 | 56 | 19 |
| Archagentix page | 43 | 2 | 16 | 2 |

Worst offenders, by count:

| Gate | n | What it means for the brand |
| --- | --- | --- |
| 48 | 117 | Colour literals outside tokens — `#f0f5f3` written inline in blog HTML. The palette is not a system, so it cannot be trusted or rotated. |
| 67 | 60 | Tracked-caps labels — the typographic tell across all three systems. |
| 34 | 25 | No `overflow-x: clip` on `html`/`body` anywhere. |
| 54 | 25 | Eyebrows above every content page's `<h1>`. |
| 19 | 20 | Em-dashes in copy. |
| 26a | 18 | **No `:focus-visible` in any of 18 files audited.** The brand is unusable by keyboard. |
| 39a | 7 | Disabled state conveyed by opacity alone (`archagentix/styles.css:364`, `:366`). |
| 40 | 9 | Sub-threshold contrast: `.badge` 3.35:1 (`archagentix/styles.css:43`), `.rank-badge` 2.53:1 (`:158`). |
| 41 | 7 | Dark surfaces setting no text colour (`archagentix/styles.css:81`, `:110`). |
| 24b | 695 | Spacing off the 4px scale — almost entirely in `immersive.css` and `workflows.css`. |
| 56 | 1 | Four sticky `top:0` bars stacked in one column (`styles/immersive.css:13`, `:97`, `:156`, `:446`). |
| 6a | 1 | Hero sized in `vh` (`adlc/styles.css:105`). |
| 10a | 1 | `transition: all` (`adlc/blog/index.html:49`). |
| 29 | 1 | Glass panel: `backdrop-filter` over translucent white (`adlc/styles.css:46`). |
| F15 | 1 | Two container widths on one page: 1680 (`styles/workflows.css:10`) against 1180 in the other five app stylesheets. |

## 7. What a redesign may not break

Recorded and verifiable with `sloplint --kept`: **119 links, 131 ids**. Also:

- `e2e/` is **10 Playwright specs, ~686 assertions, 72 unique class selectors**
  (`.conversation-rail`, `.auth-card`, `.composer-surface`, `.agent-workspace`,
  `.adlc-ai-links .brand-icon`, `.attachment-chip-*`). Recomposing markup breaks these, and
  tests will not be edited to make a redesign pass.
- The baseline recorded **0 fields, 0 handlers, 0 script hooks**: the app's wiring lives in
  `js/views/*.js`, not in HTML. A tool that checks "did anything the page had go missing"
  cannot see the app's own wiring, so the app must be diffed by hand.
- `styles.css` is linked **three times** in `index.html` (`:205` plus two others), one of them
  a deliberate print-swap deferral — not a bug to "fix" blind.

## 8. Open questions only the owner can settle

These are facts, not inferences, so they are listed unfilled rather than guessed:

1. Which name is the brand — **Archagentix**, **Software Factory**, or **ADLC**? What is
   **AI Fleet**, then?
2. Is there a real logo file, or are the three CSS bars (`index.html:143`) the mark?
3. Are Inter / Space Grotesk / JetBrains Mono licensed for the product, or should the brand
   face change? Until a file is vendored, the names in `styles.css:40`–`42` are fiction.
4. Is Georgia-as-display (via `--font-serif`) an accident or the actual voice?
5. Is the GitHub palette on `public/archagentix/` intentional or leftover scaffolding?
6. Which of the three palettes is the brand, and do `public/` and `marketing/` share it?
7. Are the claims carried in copy measured? Anything not given as a real number, quote or
   logo is absent from the redesign, not invented (gate 46a).

## 9. Suggested depth

The three systems are not one job: the app is an **app screen** set (recompose inside the
shell, no hero), the ADLC site is **19 content pages**, `archagentix` is **one page**. One
full pass over all 21 at once is a 210KB-CSS change with 72 selectors at risk. Suggested
order: brand truth (§ 8) → the app → the ADLC site → `archagentix`, with the system locked in
a `design.md` after the first scaffold so later pages inherit rather than drift.
