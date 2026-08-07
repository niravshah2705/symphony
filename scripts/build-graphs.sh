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

rc=0

if [ -n "$CRG" ]; then
  echo "▸ code-review-graph build …"
  "$CRG" build >/dev/null 2>&1 && echo "  ✅ SQLite graph → .code-review-graph/graph.db" \
    || { echo "  ❌ code-review-graph build failed"; rc=1; }
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
