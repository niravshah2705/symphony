#!/usr/bin/env bash
#
# link-agent-docs.sh — expose each CLAUDE.md under the tool-agnostic AGENTS.md name.
#
# This repo keeps ONE canonical agent guide per directory in CLAUDE.md and
# publishes it as AGENTS.md (the cross-tool agents.md convention) via a *relative*
# symlink, so a single source of truth serves Claude Code and every other agent
# tool (Codex, Cursor, Aider, Gemini CLI, …).
#
# Git stores the symlink natively, so a normal clone already has it. Re-run this
# after checking out on a filesystem/config without symlink support (e.g. Windows
# with core.symlinks=false), where git may have materialized AGENTS.md as a plain
# text file instead of a link.
#
# Idempotent: skips links that are already correct, and never touches a directory
# whose AGENTS.md is a real (non-symlink) file with its own content.
#
# Usage:  npm run docs:agents   (or: bash scripts/link-agent-docs.sh)
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

created=0
skipped=0

# Every tracked CLAUDE.md gets a sibling AGENTS.md symlink pointing at it.
while IFS= read -r claude; do
  dir="$(dirname "$claude")"
  link="$dir/AGENTS.md"

  # Already the correct relative symlink → nothing to do.
  if [ -L "$link" ] && [ "$(readlink "$link")" = "CLAUDE.md" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  # A real (non-symlink) AGENTS.md: only convert it when it is a de-symlinked
  # git link (a checkout without symlink support writes the target path as the
  # file's sole content). Anything with independent content is left untouched
  # and flagged, rather than silently discarding a file we didn't create.
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    if [ "$(cat "$link" 2>/dev/null)" != "CLAUDE.md" ]; then
      echo "  ⚠️  $link is a real file with its own content — skipping (remove it by hand to convert)." >&2
      skipped=$((skipped + 1))
      continue
    fi
  fi

  rm -f "$link"
  ln -s "CLAUDE.md" "$link"      # relative target: resolves against $dir
  echo "  🔗 $link → CLAUDE.md"
  created=$((created + 1))
done < <(git ls-files | grep -E '(^|/)CLAUDE\.md$')

echo "AGENTS.md symlinks: ${created} created/updated, ${skipped} already correct."
