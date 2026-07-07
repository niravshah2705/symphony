---
name: land
description: Merge the ticket's PR into main as the final step before reporting a `completed` verdict. Do NOT call `gh pr merge` ad-hoc — follow this loop. Do NOT change the ticket state or labels; the orchestrator marks it Done.
---

# land

Run this to MERGE your PR into `main` — the last thing you do before reporting a `completed` verdict.

1. Confirm PR checks are green (`gh pr checks`) and the branch is current with `origin/main` — run the `pull` skill, re-validate, and `push` if needed.
2. Merge via the sanctioned method once checks pass: `gh pr merge --squash --delete-branch` (match the repo's convention).
3. If the merge is blocked (out-of-date branch, failing/pending checks), fix the cause, re-validate, and retry in a loop until it merges — do not give up after one attempt.
4. Do NOT change the ticket's workflow state or labels. The orchestrator moves the ticket to `Done` and stamps `aidone` after your `completed` verdict — merging here guarantees the PR lands BEFORE the issue is marked done. If you cannot merge (no permission, unresolvable conflicts, red checks that can't be fixed), report an `insufficient` verdict explaining why instead of forcing it.
