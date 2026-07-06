---
name: pull
description: Sync the working branch with the latest origin/main before editing or handing off. Run at kickoff and before every push/handoff.
---

# pull

Keep the branch current with `origin/main` to minimize merge conflicts.

1. `git fetch origin`
2. Integrate: `git merge origin/main` (or `git rebase origin/main` if the repo convention prefers it — check AGENTS.md / CONTRIBUTING).
3. If there are conflicts, resolve them, then re-run the build/tests before continuing.
4. Record the evidence for the Workpad `Notes`:
   - merge source(s),
   - result: `clean` or `conflicts resolved`,
   - resulting `HEAD` short SHA (`git rev-parse --short HEAD`).
