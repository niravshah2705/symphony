# AGENTS.md

This repository's guidance for AI coding agents lives in **[CLAUDE.md](./CLAUDE.md)**.
It is tool-agnostic — read it before making changes.

## Start here: read the code map first

**Before exploring the source, read [`docs/code-graph/index.md`](./docs/code-graph/index.md).**
It is an auto-generated structural map of the whole codebase (functions,
classes, tests grouped into communities, with `file:line` locations and key
execution flows). Use it to find the right module before opening files. The map
is regenerated with `npm run docs:code` and kept in sync by the `pre-commit`
hook — trust the source if they ever disagree, then regenerate.

## Query the code before grepping

Two complementary graphs index this repo — use them before reading whole files
or grepping (full detail in [`CLAUDE.md`](./CLAUDE.md) → "Querying the code"):

1. **code-review-graph (CRG)** — precise symbol lookup ("where is X", "who calls
   X", "impact of changing X"). SQLite graph at `.code-review-graph/graph.db`
   (or its MCP tools if installed).
2. **graphify** — broad architectural exploration on a CRG miss ("what connects
   A to B", subsystem neighborhoods): `graphify query "…"`, `graphify path`,
   `graphify explain`.
3. **grep / read** — last resort, for content the graphs don't index.

Both are local, gitignored indexes: `npm run graph:build` refreshes them (also
auto-refreshed after each commit via `.githooks/post-commit`).

## Quick orientation

- **Code map (read first):** [`docs/code-graph/index.md`](./docs/code-graph/index.md)
- **Product & setup docs:** [`README.md`](./README.md)
- **Agent working guide:** [`CLAUDE.md`](./CLAUDE.md)
- **Per-service guides:** e.g. [`services/org/CLAUDE.md`](./services/org/CLAUDE.md)
- **Run:** `npm start` · **Test:** `npm test` · **Regenerate map:** `npm run docs:code` · **Build query graphs:** `npm run graph:build`

## Keeping the map fresh

`.githooks/pre-commit` regenerates `docs/code-graph/` and blocks the commit if it
drifts from the code. Enable once with `npm run hooks:install`; bypass in a pinch
with `SKIP_DOCS_HOOK=1 git commit …`. See [`.githooks/README.md`](./.githooks/README.md).
