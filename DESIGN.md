# Design: ArchAgentix public site

The locked system. Every Hallmark run reads this first and pages share it. Change it on purpose; the file is the rule.

Scope: `public/adlc/**` and the marketing pages that load `/adlc/styles.css` (about, pricing, contact, careers, newsroom, legal), plus `public/archagentix/`. The SPA (`public/index.html`, `public/styles.css`, `public/styles/*`) keeps its own system until its own pass.

## System
- Genre: modern-minimal
- Shape of the first page: Narrative Workflow (later pages differ in shape only: Long Document, Index, Offer, Form)
- Theme: Cobalt (by request; deal draw fca666)
- Axes: light/grotesk-sans/cool · posture: restrained

## Tokens
`public/tokens.css` is the source of truth; `public/base.css` carries the Floor. The roles:
```css
:root {
  --color-paper: oklch(98.6% 0.005 250); --color-paper-2: oklch(96.2% 0.008 252); --color-paper-3: oklch(93% 0.011 252);
  --color-ink: oklch(21% 0.028 262); --color-ink-2: oklch(36% 0.022 260); --color-muted: oklch(50% 0.018 258); --color-rule: oklch(90% 0.009 252);
  --color-accent: oklch(52% 0.19 258); --color-accent-ink: oklch(98.6% 0.005 250); --color-focus: oklch(52% 0.19 258);
  --font-display: "Familjen Grotesk", system-ui, sans-serif; --font-body: "IBM Plex Sans", system-ui, sans-serif; --font-outlier: "JetBrains Mono", ui-monospace, monospace;
  --radius-card: 8px; --radius-input: 6px; --rule-hair: 1px; --shadow-card: 0 1px 2px oklch(21% 0.028 262 / 0.06);
}
```
The spacing scale, the type scale, the easings and the durations are the scaffold's and live in `tokens.css`.

## Controls
- Primary: solid cobalt keycap (3px bottom edge, lifts 1px, sinks on press) · `--radius-input` · 48px
- Secondary: key-face keycap on hairline · same radius and height
- Links: ink, cobalt underline on hover. One filled primary per screen.

## Brand
- Wordmark: ArchAgentix (capital A in Agentix, user-declared 2026-11-24) in Familjen Grotesk 600 beside `/brand/archagentix-mark.svg` (CSS mask, currentColor).
- The registered legal name "Archagentix Private Limited" and its identifiers (CIN, GSTIN) are facts and keep their registered spelling.

## Motion
- Character: still. One reveal at most (hero field settles once); the ASCII run field is the only ambient object, paused off screen and under reduced motion.

## Chrome
- Nav: edge-aligned, wordmark left, links and one keycap action right, solid paper, hairline under.
- Footer: colophon block, wordmark over one closing line, links as a text run, address and legal lines.

## Exports
`tokens.css` in this project. Tailwind, DTCG or shadcn blocks are added here on request, per `export-formats.md`.
