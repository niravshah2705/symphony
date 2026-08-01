"""Shared foundation for the developer-tool registry (port of agent/tools/exec.js).

Every tool in ``tools/`` DELEGATES to a pre-installed standard CLI rather than
re-implementing its behaviour — this module is the one safe door those
delegations go through.

Security posture (see infrastructure-misconfig / secret-leakage checklists):
  - Commands run via ``asyncio.create_subprocess_exec`` with an ARGUMENT ARRAY
    and NEVER a shell string, so tool inputs can never be interpreted as shell
    metacharacters (no command injection).
  - The child inherits the real environment (build tools need $HOME/$PATH/
    $ANDROID_HOME/$JAVA_HOME) but every credential-looking variable is STRIPPED
    first, and any known secret value is REDACTED from returned output — secrets
    never reach the model or child processes.
  - A tool's optional ``dir`` is resolved INSIDE the workspace root; traversal
    ("../etc") is refused.
"""

from __future__ import annotations

import asyncio
import os
import re
import signal
import sys

from ai_fleet.config import CONFIG

DEFAULT_TIMEOUT_SEC = 900
DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

_MAX_BUFFER_BYTES = 16 * 1024 * 1024


def _to_number(value):
    """JS ``Number(x)`` returning None for NaN/invalid (so ``x or default`` works)."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n:  # NaN
        return None
    return int(n) if n == int(n) else n


def tool_limits():
    t = getattr(CONFIG, "TOOLS", None)
    return {
        "timeoutSec": _to_number(getattr(t, "timeoutSec", None)) or DEFAULT_TIMEOUT_SEC,
        "maxOutputBytes": _to_number(getattr(t, "maxOutputBytes", None)) or DEFAULT_MAX_OUTPUT_BYTES,
    }


# Env variable names whose VALUE is a credential — matched case-insensitively.
SECRET_KEY_RE = re.compile(
    r"(TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|APIKEY|"
    r"API_KEY|_KEY$|SESSION|COOKIE|BEARER|_PAT$|AUTH_|_AUTH$)",
    re.IGNORECASE,
)

# Non-interactive / reproducible flags forced into every tool subprocess.
NONINTERACTIVE_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "GCM_INTERACTIVE": "Never",
    "DEBIAN_FRONTEND": "noninteractive",
    "PIP_DISABLE_PIP_VERSION_CHECK": "1",
    "PYTHONUNBUFFERED": "1",
    "npm_config_fund": "false",
    "npm_config_audit": "false",
}


def sanitized_tool_env(base_env=None):
    """Split a base environment into the env a tool subprocess may see and the
    list of secret values to redact from its output. Inherit-then-strip: keep
    every variable a real toolchain needs, drop anything that looks like a
    credential. Returns ``{"env": {...}, "secrets": [...]}``.
    """
    if base_env is None:
        base_env = os.environ
    env = {}
    secrets = []
    for key, value in base_env.items():
        if not isinstance(value, str):
            continue
        if SECRET_KEY_RE.search(key):
            if len(value) >= 4:
                secrets.append(value)
            continue  # stripped — never forwarded to the child
        env[key] = value
    return {"env": {**env, **NONINTERACTIVE_ENV}, "secrets": secrets}


_AUTH_RE = re.compile(
    r"((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[A-Za-z0-9._~+/=-]{8,}",
    re.IGNORECASE,
)
_KV_SECRET_RE = re.compile(
    r"((?:private-token|x-api-key|api[_-]?key|access[_-]?token|secret|password|passwd|pwd)"
    r"[\"']?\s*[:=]\s*[\"']?)[^\s'\";,&]+",
    re.IGNORECASE,
)
_GH_TOKEN_RE = re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}\b")
_GLPAT_RE = re.compile(r"\bglpat-[A-Za-z0-9_-]{16,}\b")
_SK_RE = re.compile(r"\bsk-[A-Za-z0-9]{16,}\b")
_XOX_RE = re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")

REDACTED = "«redacted»"  # «redacted»


def redact_secrets(text, secrets=None, max_bytes=None):
    """Redact known secret values and common credential patterns, then bound length."""
    out = str("" if text is None else text)
    for secret in secrets or []:
        s = str(secret)
        if len(s) >= 4:
            out = out.replace(s, REDACTED)
    out = _AUTH_RE.sub(r"\g<1>" + REDACTED, out)
    out = _KV_SECRET_RE.sub(r"\g<1>" + REDACTED, out)
    out = _GH_TOKEN_RE.sub(REDACTED, out)
    out = _GLPAT_RE.sub(REDACTED, out)
    out = _SK_RE.sub(REDACTED, out)
    out = _XOX_RE.sub(REDACTED, out)
    return truncate(out, max_bytes or tool_limits()["maxOutputBytes"])


def truncate(text, max_bytes):
    """Bound output to ``max_bytes``, keeping the head and tail (errors cluster at the end)."""
    s = str("" if text is None else text)
    if len(s) <= max_bytes:
        return s
    head = int(max_bytes * 0.6)
    tail = max_bytes - head
    dropped = len(s) - max_bytes
    return f"{s[:head]}\n…[truncated {dropped} chars]…\n{s[len(s) - tail:]}"


def resolve_workdir(ctx=None, dir=None):
    """Resolve a tool's working directory INSIDE the workspace root carried on
    ctx. Refuses any ``dir`` that escapes the root (path traversal).
    """
    ctx = ctx or {}
    base = os.path.abspath(ctx.get("cwd") or ctx.get("rootDir") or os.getcwd())
    if not dir:
        return base
    target = os.path.abspath(os.path.join(base, str(dir)))
    relative = os.path.relpath(target, base)
    if relative == ".." or relative.startswith(".." + os.sep) or os.path.isabs(relative):
        raise Exception(f'refusing to operate outside the workspace: "{dir}"')
    return target


def _decode(data) -> str:
    if data is None:
        return ""
    if isinstance(data, (bytes, bytearray)):
        return bytes(data).decode("utf-8", errors="replace")
    return str(data)


async def run_command(command, args=None, opts=None):
    """Run one command with an argument array (never a shell). Resolves with a
    normalized result and NEVER raises on non-zero exit — callers format the
    outcome for the model. Raises only on programmer error (bad arguments).

    Returns a dict: ``{ok, code, signal, stdout, stderr, timedOut, notFound}``.
    """
    if not isinstance(command, str) or not command:
        raise Exception("run_command: command must be a non-empty string")
    if args is None:
        args = []
    if not isinstance(args, list) or any(not isinstance(a, str) or "\0" in a for a in args):
        raise Exception("run_command: args must be an array of strings without null bytes")
    opts = opts or {}
    limits = tool_limits()
    timeout_sec = _to_number(opts.get("timeoutSec")) or limits["timeoutSec"]
    env = opts["env"] if opts.get("env") else sanitized_tool_env()["env"]

    try:
        proc = await asyncio.create_subprocess_exec(
            command,
            *args,
            cwd=opts.get("cwd"),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=_MAX_BUFFER_BYTES,
        )
    except FileNotFoundError:
        return {"ok": False, "code": 127, "signal": None, "stdout": "", "stderr": "", "timedOut": False, "notFound": True}

    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        try:
            out, err = await proc.communicate()
        except Exception:
            out, err = b"", b""
        return {
            "ok": False,
            "code": None,
            "signal": "SIGTERM",
            "stdout": _decode(out),
            "stderr": _decode(err),
            "timedOut": True,
            "notFound": False,
        }

    rc = proc.returncode
    stdout = _decode(out)
    stderr = _decode(err)
    if rc == 0:
        return {"ok": True, "code": 0, "signal": None, "stdout": stdout, "stderr": stderr, "timedOut": False, "notFound": False}
    if rc is not None and rc < 0:
        try:
            signame = signal.Signals(-rc).name
        except ValueError:
            signame = str(-rc)
        return {"ok": False, "code": None, "signal": signame, "stdout": stdout, "stderr": stderr, "timedOut": False, "notFound": False}
    return {"ok": False, "code": rc, "signal": None, "stdout": stdout, "stderr": stderr, "timedOut": False, "notFound": False}


def platform_cmd(name):
    """Append the platform command-shim suffix (``.cmd``) on Windows for node CLIs."""
    return f"{name}.cmd" if sys.platform.startswith("win") else name


def _step_fn(ctx):
    step = ctx.get("step") if ctx else None
    return step if callable(step) else (lambda *a, **k: None)


async def exec_tool(*, ctx=None, label, command, args, dir=None, timeout_sec=None, not_found_hint=None):
    """The DRY core each executing tool calls: resolve cwd, announce progress,
    run, then return a redacted, bounded, model-readable summary string.
    """
    ctx = ctx or {}
    step = _step_fn(ctx)
    cwd = resolve_workdir(ctx, dir)
    senv = sanitized_tool_env()
    env, secrets = senv["env"], senv["secrets"]
    printable = f"{command} {' '.join(args)}".strip()
    step(f"\U0001f6e0️  {label}: {printable[:120]}")
    result = await run_command(command, args, {"cwd": cwd, "timeoutSec": timeout_sec, "env": env})
    if result["notFound"]:
        hint = not_found_hint or f"Install the {command} CLI (this tool delegates to it) and retry."
        return f"❌ {label}: `{command}` is not installed / not on PATH.\n{hint}"
    return format_result(label=label, command=command, args=args, cwd=cwd, result=result, secrets=secrets)


async def command_exists(command, version_arg="--version"):
    """Whether a CLI is available on PATH (cheap probe via its version flag)."""
    try:
        env = sanitized_tool_env()["env"]
        result = await run_command(command, [version_arg], {"env": env, "timeoutSec": 30})
        return not result["notFound"]
    except Exception:
        return False


async def run_sequence(*, ctx=None, dir=None, steps=None, timeout_sec=None):
    """Run an ordered list of steps in one working directory, stopping at the
    first failure. Returns ``{"ok": bool, "output": str}``.
    """
    ctx = ctx or {}
    steps = steps or []
    cwd = resolve_workdir(ctx, dir)
    senv = sanitized_tool_env()
    env, secrets = senv["env"], senv["secrets"]
    step = _step_fn(ctx)
    chunks = []
    for s in steps:
        step(f"\U0001f6e0️  {s['label']}: {s['command']} {' '.join(s['args'])}"[:140])
        result = await run_command(s["command"], s["args"], {"cwd": cwd, "env": env, "timeoutSec": s.get("timeoutSec") or timeout_sec})
        if result["notFound"]:
            hint = s.get("notFoundHint") or f"Install {s['command']} and retry."
            chunks.append(f"❌ {s['label']}: `{s['command']}` is not installed / not on PATH.\n{hint}")
            return {"ok": False, "output": "\n\n".join(chunks)}
        chunks.append(format_result(label=s["label"], command=s["command"], args=s["args"], cwd=cwd, result=result, secrets=secrets))
        if not result["ok"]:
            return {"ok": False, "output": "\n\n".join(chunks)}
    return {"ok": True, "output": "\n\n".join(chunks)}


def format_result(*, label, command, args, cwd, result, secrets=None):
    """Format a completed command result into the string returned to the model."""
    secrets = secrets or []
    max_output_bytes = tool_limits()["maxOutputBytes"]
    if result["ok"]:
        status = "✅ ok"
    elif result["timedOut"]:
        status = "⏱️ timed out"
    else:
        signal_suffix = f" ({result['signal']})" if result["signal"] else ""
        status = f"❌ exit {result['code']}{signal_suffix}"
    header = f"{status} — {label}\n$ {command} {' '.join(args)}\n(cwd: {cwd})"
    body = "\n".join(
        s for s in ((result["stdout"] or "").strip(), (result["stderr"] or "").strip()) if s
    )
    redacted = redact_secrets(body, secrets, max_output_bytes)
    return f"{header}\n\n{redacted}" if redacted else header


def define_tool(def_, handler):
    """Build a LangChain tool factory with a lazy langchain import (matching the
    registry convention) and a uniform try/except that returns an error string
    instead of raising — one thrown tool must not abort the agent run.

    ``def_`` is a dict ``{"name", "description", "schema"}`` where ``schema`` is a
    pydantic ``BaseModel`` subclass (the JS zod schema, ported to pydantic).
    ``handler`` is ``async (input: dict, ctx: dict) -> str``.
    """

    def factory(ctx=None):
        ctx = ctx or {}
        from langchain_core.tools import StructuredTool

        async def _run(**kwargs):
            try:
                return await handler(kwargs, ctx)
            except Exception as err:
                msg = getattr(err, "message", None) or str(err)
                return f"❌ {def_['name']} failed: {redact_secrets(msg)}"

        return StructuredTool(
            name=def_["name"],
            description=def_["description"],
            args_schema=def_["schema"],
            coroutine=_run,
        )

    return factory
