# Git hooks

Version-controlled hooks for this repo. Enable them once per clone:

```bash
npm run hooks:install     # git config core.hooksPath .githooks
```

## `pre-commit` — none

There is deliberately **no** commit gate on `code-review-graph`. `docs/code-graph/`
is a generated, gitignored local artifact (like `.code-review-graph/` and
`graphify-out/`), so a commit is never blocked for doc drift and no CRG version
pin has to match across machines. Regenerate the map whenever it looks stale:

```bash
npm run docs:code
```

- Requires the `code-review-graph` CLI (any recent release works, since nothing
  diffs the output against a committed copy):
  ```bash
  pipx install --with igraph code-review-graph
  ```
  or via uv:
  ```bash
  uv tool install --with igraph code-review-graph
  ```

## `post-commit` — background graph refresh

After each commit, regenerates the **local, gitignored** query indexes
(`.code-review-graph/graph.db` and `graphify-out/`) so the two-graph query
workflow (see `CLAUDE.md` → "Querying the code") stays fresh. Runs **detached**
so `git commit` returns immediately, and is PID-locked so concurrent commits
don't pile up rebuilds. Logs to `.code-review-graph/post-commit.log`.

- This only refreshes the local indexes; it never stages or commits anything.
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

> Hooks are a convenience, not a contract: they run **local only**, are absent
> on a clone that hasn't run `npm run hooks:install`, and can be bypassed. CI
> does not depend on any of them.
