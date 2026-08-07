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

## Quick orientation

- **Code map (read first):** [`docs/code-graph/index.md`](./docs/code-graph/index.md)
- **Product & setup docs:** [`README.md`](./README.md)
- **Agent working guide:** [`CLAUDE.md`](./CLAUDE.md)
- **Per-service guides:** e.g. [`services/org/CLAUDE.md`](./services/org/CLAUDE.md)
- **Run:** `npm start` · **Test:** `npm test` · **Regenerate map:** `npm run docs:code`

## Keeping the map fresh

`.githooks/pre-commit` regenerates `docs/code-graph/` and blocks the commit if it
drifts from the code. Enable once with `npm run hooks:install`; bypass in a pinch
with `SKIP_DOCS_HOOK=1 git commit …`. See [`.githooks/README.md`](./.githooks/README.md).
