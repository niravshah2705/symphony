---
name: land
description: Safely merge an approved PR when the ticket is in Merging. Do NOT call `gh pr merge` ad-hoc — follow this loop.
---

# land

Run this ONLY when the ticket state is `Merging` (human-approved).

1. Confirm PR checks are green (`gh pr checks`) and the branch is current with `origin/main` — run the `pull` skill, re-validate, and `push` if needed.
2. Merge via the sanctioned method once checks pass: `gh pr merge --squash --delete-branch` (match the repo's convention).
3. If the merge is blocked (out-of-date branch, failing/pending checks), fix the cause, re-validate, and retry in a loop until it merges — do not give up after one attempt.
4. After the merge completes, move the ticket to `Done` via the `linear` skill.
