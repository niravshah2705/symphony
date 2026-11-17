# Git hooks

Version-controlled hooks for this repo. Enable them once per clone:

```bash
npm run hooks:install     # git config core.hooksPath .githooks
```

## Code-graph docs are local-only (no pre-commit gate)

The `pre-commit` drift gate was retired (2026-11): `docs/code-graph/` is now
**gitignored** and never committed. Generate the human-readable map on demand
into your local checkout with:

```bash
npm run docs:code
```

The old gate's version-pinning advice still applies if you browse those local
docs: cluster reshuffles with the CLI version (`CRG_VERSION` in
`scripts/gen-code-docs.sh`).

## `post-commit` — background graph refresh

After each commit, regenerates the **local, gitignored** query indexes
(`.code-review-graph/graph.db` and `graphify-out/`) and, since the docs gate is
gone, they are the only thing that keeps the local map fresh. Runs **detached**
so `git commit` returns immediately, and is PID-locked so concurrent commits
don't pile up rebuilds. Logs to `.code-review-graph/post-commit.log`.

- Rebuild on demand any time: `npm run graph:build`.
- Bypass: `SKIP_GRAPH_REFRESH=1 git commit …`
- Requires the `graphify` CLI (v0.9+, **with the `terraform` extra** for this
  repo's `deploy/gcp/terraform/` coverage — without it, `.tf` files silently
  contribute 0 nodes):
  ```bash
  uv tool install "graphifyy[terraform]"
  ```
  or via pip: `pip install "graphifyy[terraform]"`.
- A pre-existing `.code-review-graph/graph.db` won't retroactively re-parse
  files under newly-added language support (incremental `update` only
  touches changed files) — force one full rebuild with
  `npm run graph:build -- --clean`.

> Enforcement is **local only**. The generated `docs/code-graph/` pages are
> gitignored, so nothing to gate at commit or merge time.
