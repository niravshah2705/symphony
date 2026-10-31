#!/usr/bin/env python3
"""PreToolUse(Bash) hook: keep file *search* and *read* out of Bash so the
context stays small and cache-friendly. Steers to the right tool:

  - source/symbol search  -> code-review-graph (if built) else native Grep/Glob
  - file reads (cat/head/tail/sed -n) -> native Read
  - pure `echo` narration / idle markers -> just don't (wasted turns)

Unlike the old hook this (a) fires on every *new* offending command instead of
once per session, (b) catches NON-recursive greps too, and (c) leaves
legitimate output-filtering (`cmd | grep ...`), file writes (`echo x > f`),
and the documented config/log/Terraform-var exceptions alone.
"""
import hashlib
import json
import os
import re
import subprocess
import sys

# --- things we NEVER block -------------------------------------------------
CRG_INVOCATION_RE = re.compile(r"\bcode-review-graph\s+\w")
TF_VAR_USAGE_RE = re.compile(r"\bvar\\?\.[A-Za-z_][A-Za-z0-9_]*")
INCLUDE_RE = re.compile(r"--include=[\"']?\*\.([A-Za-z0-9]+)")
EXCEPTION_EXTS = {"yml", "yaml", "log"}
READERS = {"cat", "head", "tail"}
SEARCHERS = {"grep", "egrep", "fgrep", "rg", "ag", "ack"}


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
        if out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return cwd


def statements(command):
    """Split a compound command on && ; and newlines (NOT on |)."""
    return [s.strip() for s in re.split(r"&&|;|\n", command) if s.strip()]


def stages(statement):
    """Pipe stages of one statement."""
    return [s.strip() for s in statement.split("|") if s.strip()]


def cmd_name(stage):
    m = re.match(r"([A-Za-z0-9_./-]+)", stage)
    return m.group(1).split("/")[-1] if m else ""


def classify(command, crg_available):
    """Return (reason, steer_tool) if this command should be blocked, else None."""
    if CRG_INVOCATION_RE.search(command):
        return None
    for stmt in statements(command):
        pipe_stages = stages(stmt)
        for idx, stage in enumerate(pipe_stages):
            name = cmd_name(stage)

            # 1) searching FILES with grep/rg — only when it's the FIRST stage
            #    (a piped `... | grep` is legit output filtering, leave it).
            if name in SEARCHERS and idx == 0:
                if TF_VAR_USAGE_RE.search(stage):
                    continue
                includes = INCLUDE_RE.findall(stage)
                if includes and all(e.lower() in EXCEPTION_EXTS for e in includes):
                    continue
                tool = "code-review-graph search" if crg_available else "the Grep tool"
                return (
                    f"Use {tool} instead of `{name}` in Bash to search source. "
                    "It's precise and keeps context small/cache-friendly. "
                    "(Exceptions still fine via Bash: config values, log strings, "
                    "comments, generic YAML, Terraform var.X usage — reword and rerun.)",
                    tool,
                )

            # 2) reading a FILE with cat/head/tail (first stage, has a path arg)
            if name in READERS and idx == 0:
                rest = stage[len(cmd_name(stage)):]
                if re.search(r"[\w./-]+\.[A-Za-z0-9]+", rest):  # looks like a file arg
                    return (
                        f"Use the Read tool instead of `{name} <file>` — it's "
                        "cheaper and the output stays out of the re-sent context.",
                        "Read",
                    )

            # 3) sed -n 'N,Mp' file  -> Read with a line range
            if name == "sed" and idx == 0 and re.search(r"-n\s+['\"]?\d", stage):
                return (
                    "Use the Read tool (offset/limit) instead of `sed -n` to view "
                    "a line range — same result, far fewer tokens.",
                    "Read",
                )

            # 4) find ... -name/-path  -> Glob
            if name == "find" and re.search(r"-(name|iname|path)\b", stmt):
                return (
                    "Use the Glob tool instead of `find -name` for filename search.",
                    "Glob",
                )

        # 5) whole statement is just echo(es) with no redirect => wasted turn
        heads = {cmd_name(s) for s in pipe_stages}
        if heads == {"echo"} and ">" not in stmt:
            return (
                "Skip narration/idle `echo` calls — each one is a full LLM turn "
                "that re-sends the whole context from cache. Just proceed with "
                "the real work (or use a Task/todo update if you need a marker).",
                None,
            )
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("tool_name") != "Bash":
        return 0

    command = (data.get("tool_input") or {}).get("command") or ""
    cwd = data.get("cwd") or os.getcwd()
    session_id = re.sub(r"[^A-Za-z0-9_.-]", "_", data.get("session_id") or "unknown")

    crg_db = os.path.join(repo_root_for(cwd), ".code-review-graph", "graph.db")
    crg_available = os.path.isfile(crg_db)

    result = classify(command, crg_available)
    if not result:
        return 0
    reason, _tool = result

    # Dedupe: don't re-block the EXACT same command in the same session (avoids
    # an infinite loop if the agent legitimately retries the identical string),
    # but every *new* offending command still gets caught.
    digest = hashlib.sha1(f"{session_id}:{command}".encode()).hexdigest()[:16]
    marker = f"/tmp/crg-hook-{digest}"
    if os.path.exists(marker):
        return 0
    touch(marker)

    print(reason, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
