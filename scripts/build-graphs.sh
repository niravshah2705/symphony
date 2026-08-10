#!/usr/bin/env bash
#
# build-graphs.sh — build/refresh BOTH local code-intelligence indexes.
#
# These are gitignored local query indexes used to answer "where/who/what
# connects" questions cheaply (see CLAUDE.md → "Querying the code"):
#   * code-review-graph  → .code-review-graph/graph.db  (SQLite, precise)
#   * graphify           → graphify-out/                (AST graph, architectural)
#
# Unlike `npm run docs:code` (which regenerates the *committed* docs/code-graph
# map and is drift-gated in pre-commit), this script only refreshes the local
# indexes — nothing here is committed.
#
# Usage:  npm run graph:build   (or: bash scripts/build-graphs.sh)
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"

resolve() { command -v "$1" 2>/dev/null || { [ -x "$HOME/.local/bin/$1" ] && echo "$HOME/.local/bin/$1"; }; }
CRG="$(resolve code-review-graph)"
GFY="$(resolve graphify)"
DB=".code-review-graph/graph.db"

rc=0

if [ -n "$CRG" ]; then
  # Bootstrap guard (mirrors .githooks/post-commit): the incremental `update`
  # needs an existing graph, so build from scratch when the DB is absent and
  # only refresh incrementally when it already exists.
  if [ -f "$DB" ]; then crg_cmd="update"; else crg_cmd="build"; fi
  echo "▸ code-review-graph $crg_cmd …"
  "$CRG" "$crg_cmd" >/dev/null 2>&1 && echo "  ✅ SQLite graph → $DB" \
    || { echo "  ❌ code-review-graph $crg_cmd failed"; rc=1; }
else
  echo "▸ code-review-graph not installed — skipping (pipx install code-review-graph)"
fi

if [ -n "$GFY" ]; then
  # Clean rebuild: drop the previous graph so graphify's "fewer nodes" guard
  # (which refuses to shrink an existing graph.json) never blocks a full build.
  echo "▸ graphify update . (clean rebuild) …"
  rm -rf "$ROOT/graphify-out"
  "$GFY" update . >/dev/null 2>&1 && echo "  ✅ AST graph → graphify-out/" \
    || { echo "  ❌ graphify update failed"; rc=1; }
else
  echo "▸ graphify not installed — skipping (pip install graphifyy)"
fi

exit "$rc"
