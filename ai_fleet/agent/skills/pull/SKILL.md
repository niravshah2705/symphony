---
name: pull
description: Safely sync the working branch with the server-scoped base branch before editing or handing off.
---

# pull

Keep the task branch current without giving shell commands repository credentials.

1. Call `repository_broker` with `{ "action": "fetch" }`. Read `branch` and `baseBranch` from its result.
2. If `git show-ref --verify --quiet refs/remotes/origin/<branch>` succeeds, first integrate that exact scoped task ref with `git merge --no-edit -- origin/<branch>`. This recovers work published by an earlier run without force-pushing.
3. Integrate the fetched base using local Git only: `git merge --no-edit -- origin/<baseBranch>`.
4. If there are conflicts, resolve them, then re-run the build/tests before continuing.
5. Record the evidence for the Workpad `Notes`:
   - merge source(s),
   - result: `clean` or `conflicts resolved`,
   - resulting `HEAD` short SHA (`git rev-parse --short HEAD`).

Never run `git fetch`, `git pull`, or change the origin URL/config. Remote fetch is exclusively a broker action.
