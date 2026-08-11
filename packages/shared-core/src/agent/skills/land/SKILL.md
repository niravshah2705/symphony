---
name: land
description: Merge the ticket's provider-neutral PR/MR through the scoped repository broker before reporting completion.
---

# land

Run this to merge the review into its server-scoped base branch — the last thing you do before reporting a `completed` verdict.

1. Call `repository_broker` with `{ "action": "review_status", "cursor": 0 }`; inspect checks and every returned feedback item. If `nextFeedbackCursor` is not null, repeat with that cursor until every bounded window has been read. If `feedbackComplete` or `feedbackReadComplete` is false, do not merge.
2. Address actionable feedback. Run the `pull` skill, re-validate, commit, and use the `push` skill if the branch changed. Recheck status.
3. Once the broker reports a merge-ready review with green checks and no blocking feedback, call it with `{ "action": "merge_review" }`.
4. If merge is blocked (out-of-date branch, conflicts, failing/pending checks, requested changes, or unresolved discussions), fix the cause and retry the bounded loop.
5. Do NOT change the ticket's workflow state or labels. The orchestrator moves the ticket to `Done` and stamps `aidone` after your `completed` verdict — merging here guarantees the PR lands BEFORE the issue is marked done. If you cannot merge (no permission, unresolvable conflicts, red checks that can't be fixed), report an `insufficient` verdict explaining why instead of forcing it.

Never run `gh`, `glab`, `git push`, or call a provider API directly. The broker fixes the provider, repository, review, branches, expected SHA, and squash merge method.
