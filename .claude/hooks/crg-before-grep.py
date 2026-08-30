#!/usr/bin/env python3
"""PreToolUse(Bash) hook: one-time-per-session nudge toward code-review-graph
(CRG) before a broad/recursive source-code grep, when CRG is built for this
repo. See CLAUDE.md 'Querying the code' and .claude/skills/code-review-graph.
"""
import json
import os
import re
import subprocess
import sys

CRG_INVOCATION_RE = re.compile(
    r"\bcode-review-graph\s+(search|query|impact|status|serve|mcp|"
    r"detect-changes|enrich|dead-code|flows|flow|communities|community|"
    r"architecture|large-functions|refactor)\b"
)
RECURSIVE_FLAG_RE = re.compile(r"(?<!\S)-[a-zA-Z]*[rR][a-zA-Z]*(?!\S)")
INCLUDE_RE = re.compile(r"--include=[\"']?\*\.([A-Za-z0-9]+)[\"']?")
EXCEPTION_EXTS = {"yml", "yaml", "log"}
# CRG has no query kind for var.X interpolation edges (see CLAUDE.md), so a
# grep for Terraform variable *usage* is a real exception, not just a nudge
# the agent should judge on retry.
TF_VAR_USAGE_RE = re.compile(r"\bvar\\?\.[A-Za-z_][A-Za-z0-9_]*")

REASON = (
    "Before grep: this repo has code-review-graph (CRG) built at "
    ".code-review-graph/graph.db. Try `code-review-graph search \"<term>\" "
    "--limit 10` first (see CLAUDE.md 'Querying the code' section, or the "
    "code-review-graph skill) - it's the precise, cheaper tool for "
    "symbol/dependency lookups. Known exceptions where grep is still "
    "correct: config values, log strings, comments, generic YAML, and "
    "Terraform variable *usage* (CRG has no query kind for var.X "
    "interpolation edges). If this grep falls into one of those "
    "exceptions, proceed with grep as normal - this is a one-time "
    "reminder and won't fire again this session."
)


def touch(path):
    try:
        open(path, "a", encoding="utf-8").close()
    except OSError:
        pass


def repo_root_for(cwd):
    try:
        out = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        root = out.stdout.strip()
        if root:
            return root
    except Exception:
        pass
    return cwd


def is_broad_source_grep(command):
    if "grep" not in command:
        return False
    if not RECURSIVE_FLAG_RE.search(command) and "--recursive" not in command:
        return False
    includes = INCLUDE_RE.findall(command)
    if includes and all(ext.lower() in EXCEPTION_EXTS for ext in includes):
        return False
    if TF_VAR_USAGE_RE.search(command):
        return False
    return True


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    if data.get("tool_name") != "Bash":
        return 0

    command = (data.get("tool_input") or {}).get("command") or ""
    cwd = data.get("cwd") or os.getcwd()
    session_id = data.get("session_id") or "unknown"
    safe_session_id = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id)

    repo_root = repo_root_for(cwd)
    crg_db = os.path.join(repo_root, ".code-review-graph", "graph.db")
    if not os.path.isfile(crg_db):
        return 0

    marker = f"/tmp/crg-hook-nudged-{safe_session_id}"

    if CRG_INVOCATION_RE.search(command):
        touch(marker)
        return 0

    if os.path.exists(marker):
        return 0

    if not is_broad_source_grep(command):
        return 0

    touch(marker)
    print(REASON, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
