# Git hooks

Version-controlled hooks for this repo. Enable them once per clone:

```bash
npm run hooks:install     # git config core.hooksPath .githooks
```

## `pre-commit` — code-docs drift gate

Regenerates the code-graph documentation (`docs/code-graph/`) and **blocks the
commit** if the result differs from what you staged. This keeps the docs in
sync with the code that produced them.

- Runs only when the commit touches parseable source (`.js/.cjs/.mjs/.jsx/.ts/.tsx/.py/.sh`)
  or the generated docs themselves — doc-free commits are instant.
- On drift, it regenerates `docs/code-graph/` for you; just `git add -A docs/code-graph`
  and commit again.
- Requires the `code-review-graph` CLI (`pipx install code-review-graph`).
- Emergency bypass: `SKIP_DOCS_HOOK=1 git commit …`

Regenerate the docs manually any time with:

```bash
npm run docs:code
```

> Enforcement is **local only** — a git hook cannot be enforced server-side and
> can be bypassed. To also block *merges*, add `npm run docs:code` as a job in
> `.github/workflows/checks.yml` and mark it a required status check.
