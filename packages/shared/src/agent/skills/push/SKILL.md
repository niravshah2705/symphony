---
name: push
description: Publish the server-scoped task branch through the repository broker after validation passes.
---

# push

1. Run the required validation for the scope and confirm it passes BEFORE pushing.
2. Confirm all intended changes are committed and `git status --porcelain` is empty.
3. Call `repository_broker` with `{ "action": "push" }`. The server chooses the only allowed remote, branch, and non-force refspec.
4. If the remote rejects because the branch moved, run the `pull` skill, re-validate, then call the broker again.

Never run `git push`, `gh`, or `glab`, and never edit credential, proxy, or remote Git configuration.
