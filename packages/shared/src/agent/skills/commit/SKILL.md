---
name: commit
description: Produce clean, logical git commits during implementation. Use whenever there are changes to record.
---

# commit

Record work as small, logical commits — one concern per commit.

1. Review what changed: `git status` and `git diff`.
2. Stage deliberately (never blind `git add -A`): `git add <specific paths>`.
3. Commit with a concise imperative subject (≤72 chars); add a body explaining WHY when non-obvious:
   `git commit -m "<type>: <what changed>"` — type ∈ feat|fix|refactor|docs|test|chore|perf|ci.
4. Never commit secrets, credentials, build artifacts, or unrelated changes.
5. Verify with `git status` / `git log --oneline -1` after committing.
