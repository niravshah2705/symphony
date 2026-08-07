# Git hooks

Version-controlled hooks for this repo. Enable them once per clone:

```bash
npm run hooks:install     # git config core.hooksPath .githooks
```

## `pre-commit` — code-docs drift gate

Regenerates the code-graph documentation (`docs/code-graph/`) and **blocks the
commit** if the result differs from what you staged. This keeps the docs in
sync with the code that produced them.

- Runs only when the commit touches source in a language code-review-graph
  supports (`.py`, `.ts`, `.go`, `.rs`, `.java`, `.tf`, … — the full `CODE_RE`
  list in `pre-commit`) or the generated docs — other commits are instant.
  (`.yml/.yaml` is excluded on purpose: this repo's YAML is CI/config, not Ansible.)
- On drift, it regenerates `docs/code-graph/` for you; just `git add -A docs/code-graph`
  and commit again.
- Requires the `code-review-graph` CLI (`pipx install code-review-graph`).
- Emergency bypass: `SKIP_DOCS_HOOK=1 git commit …`

Regenerate the docs manually any time with:

```bash
npm run docs:code
```

## `post-commit` — background graph refresh

After each commit, regenerates the **local, gitignored** query indexes
(`.code-review-graph/graph.db` and `graphify-out/`) so the two-graph query
workflow (see `CLAUDE.md` → "Querying the code") stays fresh. Runs **detached**
so `git commit` returns immediately, and is PID-locked so concurrent commits
don't pile up rebuilds. Logs to `.code-review-graph/post-commit.log`.

- This does **not** touch committed docs — that's the `pre-commit` gate above.
- Rebuild on demand any time: `npm run graph:build`.
- Bypass: `SKIP_GRAPH_REFRESH=1 git commit …`

> Enforcement is **local only** — a git hook cannot be enforced server-side and
> can be bypassed. To also block *merges*, add `npm run docs:code` as a job in
> `.github/workflows/checks.yml` and mark it a required status check.
