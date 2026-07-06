---
name: push
description: Publish the current branch and keep the remote up to date. Use after validation passes and before requesting review.
---

# push

1. Run the required validation for the scope and confirm it passes BEFORE pushing.
2. First push: `git push -u origin <branch>`; thereafter: `git push`.
3. If the remote rejects because upstream moved, run the `pull` skill, re-validate, then push again.
4. Never force-push a shared branch without an explicit, recorded reason.
