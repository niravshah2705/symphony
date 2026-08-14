# Contributing to AI Fleet

Thanks for your interest in AI Fleet. This guide covers how to set the project up,
the conventions we follow, and how to propose changes.

> **AI Fleet is proprietary software.** It is licensed under the
> [End User License Agreement](./EULA.md), not an open-source license. Contributions
> are welcome from authorized collaborators, but by submitting one you agree it may be
> incorporated into the Software under the terms of the EULA. Outside contributors may
> be asked to sign a Contributor License Agreement (CLA) before a change can be merged
> — ask a maintainer if you're unsure.

## Code of Conduct

This project follows a [Code of Conduct](./CODE_OF_CONDUCT.md). By participating you
agree to uphold it. Report unacceptable behavior to `nirav.s@uipath.com`.

## Prerequisites

- **Node.js >= 22** (see `engines.node` in `package.json`)
- **npm** — the repo is an npm-workspaces monorepo (`packages/*`, `services/*`)
- Optional, per area: **Python 3.12** for the `org` and `settings` services, and a local
  LLM runtime (Ollama / LM Studio / OMLX) or a hosted provider for agent work.

## Getting started

```bash
npm install        # installs all workspaces
npm start          # boots gateway (:4000) + planner (:4010) + coder (:4020)
```

Then open <http://localhost:4000>. For a guided first run — prerequisites, config, and
the code map — read the [Developer Onboarding guide](./docs/DEVELOPER_ONBOARDING.md).

## Finding your way around

- [`CLAUDE.md`](./CLAUDE.md) — the developer/agent guide to the monorepo.
- [`docs/code-graph/index.md`](./docs/code-graph/index.md) — an auto-generated
  structural map of the whole codebase (functions, classes, and tests grouped into
  communities with `file:line` locations). **Read it before exploring the source.**
- Per-service guides live alongside each service (e.g. `services/org/CLAUDE.md`).

## Running the tests

```bash
npm run checks                         # Node, Playwright, org, and settings
npm run checks -- --suite node         # node | e2e | org | settings
```

The checks script installs reproducible Node dependencies, installs Chrome for
Playwright, and runs each Python service in a temporary Python 3.12 virtual
environment. The [Checks workflow](./.github/workflows/checks.yml) is an optional
manual wrapper around the same command; it does not run automatically for pull
requests or pushes. Dispatch it with `gh workflow run checks.yml -f suite=all`
when a GitHub-hosted run is useful.

## The code-map pre-commit hook (important)

A pre-commit hook regenerates `docs/code-graph/` and **blocks the commit** if the
result differs from what you staged, so the map never drifts from the code.

```bash
npm run hooks:install   # enable the repo git hooks (once per clone)
```

- On a block: `git add -A docs/code-graph` and commit again.
- Regenerate manually anytime: `npm run docs:code`.
- Requires the CLI: `pipx install code-review-graph`.

See [`.githooks/README.md`](./.githooks/README.md) for details.

## Commit messages

Follow **Conventional Commits**:

```
<type>: <description>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Pull requests

1. Branch off `main`.
2. Keep changes focused, and add or update tests for new behavior.
3. Run `npm run checks` locally, or the relevant `--suite` during development and
   the full command before review.
4. Review the full diff with `git diff main...HEAD`, then write a clear description
   with a short test plan.
5. Include the local check results in the pull-request test plan. If a maintainer
   requests a hosted run, manually dispatch the **Checks** workflow and link it.

## Security

Please do **not** open public issues for security vulnerabilities. See
[`SECURITY.md`](./SECURITY.md) for how to report them privately.
