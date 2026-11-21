#!/usr/bin/env bash
# Secret gate: run after `git add` and before `git commit`. Fails (exit 1) if any
# staged path looks like a credential file, or staged content matches common key
# shapes. Complements fleet-local/.gitignore (which already hides .env, *.pem,
# *.key, secret.yaml) — this catches files staged with -f or keys pasted into
# source/docs. Usage: bash scripts/fixes/secret-gate.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BAD_PATH='(^|/)\.env([^/]*)$|(^|/)secret\.yaml$|(^|/)[^/]*\.(pem|key|p12|pfx)$|id_rsa|credentials\.json'
BAD_CONTENT='sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}'

fail=0
paths=$(git diff --cached --name-only --diff-filter=ACM)
if [ -z "$paths" ]; then echo "secret-gate: nothing staged"; exit 0; fi

while IFS= read -r f; do
  if echo "$f" | grep -qEi "$BAD_PATH"; then
    echo "secret-gate: FORBIDDEN path staged: $f"; fail=1
  fi
done <<<"$paths"

if git diff --cached -U0 | grep -nEi "$BAD_CONTENT"; then
  echo "secret-gate: key-like content found in staged diff (above)"; fail=1
fi

[ "$fail" -eq 0 ] && echo "secret-gate OK ($(echo "$paths" | wc -l | tr -d ' ') files)"
exit "$fail"
