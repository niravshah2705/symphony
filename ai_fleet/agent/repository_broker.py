"""Security-critical credentialed Git/forge engine.

Faithful port of ``packages/shared/src/agent/repository-broker.js``. Every guard
in the JS is preserved:

- git always runs via ``asyncio.create_subprocess_exec`` (never a shell) with the
  hardening flags ``core.hooksPath=/dev/null``, an empty ``credential.helper``,
  ``GIT_CONFIG_NOSYSTEM=1`` and ``GIT_TERMINAL_PROMPT=0``.
- The token is released only through git's credential stdin protocol, by an
  inline ``!``-prefixed shell credential helper that is handed the token via the
  ``TECHSYMPHONY_BROKER_GIT_{TOKEN,HOST,USER}`` environment variables and refuses
  to emit it for any host other than the scoped one. The token never appears in
  argv and is never written to the agent workspace.
- Pushes go workspace ``.git`` -> broker-private bare staging (via a ``file://``
  URL with ``protocol.file.allow=always``) -> authenticated network push, so the
  agent's hooks/config never run in the credentialed child.
- Path-scope containment, ``.git/config`` token-leak scanning, unsafe local git
  config sanitization and every workspace-escape assertion are reproduced.
- The forge REST layer (GitHub/GitLab) uses an injectable async ``fetch_impl`` so
  tests can supply a fake; git execution uses an injectable ``exec_file_impl``.

The concurrency guarantee of the JS private ``#queue`` promise chain (all
``execute()`` calls serialized per instance) is reproduced with an
``asyncio.Lock``. Private ``#fields`` map to ``_``-prefixed attributes; the token
is wiped on ``dispose()``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json as _json
import math
import os
import re
import shutil
import stat as _stat
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit

# --------------------------------------------------------------------------- #
# Constants (mirror the JS Object.freeze maps; immutable by convention).
# --------------------------------------------------------------------------- #

PROVIDERS = {
    "github": {
        "host": "github.com",
        "apiOrigin": "https://api.github.com",
        "username": "x-access-token",
    },
    "gitlab": {
        "host": "gitlab.com",
        "apiOrigin": "https://gitlab.com",
        "username": "oauth2",
    },
}

LIMITS = {
    "toolCalls": 64,
    "retryBranches": 20,
    "titleChars": 240,
    "bodyChars": 8_000,
    "feedbackItems": 20,
    "feedbackChars": 600,
    "responseBytes": 1_000_000,
    "toolOutputChars": 24_000,
    "gitOutputChars": 4_000,
    "gitTimeoutMs": 120_000,
    "apiTimeoutMs": 20_000,
}

SAFE_ENV_KEYS = (
    "PATH",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "CI",
)

BROKER_TOKEN_ENV = "TECHSYMPHONY_BROKER_GIT_TOKEN"
BROKER_HOST_ENV = "TECHSYMPHONY_BROKER_GIT_HOST"
BROKER_USER_ENV = "TECHSYMPHONY_BROKER_GIT_USER"
FRAMEWORK_SKILLS_EXCLUDE = "/.agent-skills/"
AVAILABILITY_ERROR_CODES = frozenset(["missing_token", "provider_unavailable"])

REMOTE_GIT_FAILURE = re.compile(
    r"(?:authentication failed|could not resolve host|could not read username|"
    r"could not read from remote repository|unable to access|"
    r"connection (?:refused|reset|timed?\s*out)|network (?:is unreachable|error)|"
    r"remote:\s*[^\r\n]*(?:permission denied|not allowed|forbidden)|"
    r"permission to [^\r\n]+ denied|repository not found|not authorized|"
    r"requested url returned error:\s*(?:401|403|404|408|429|5\d\d)|"
    r"http\s*(?:401|403|404|408|429|5\d\d))\b",
    re.IGNORECASE,
)

_RETURNED_STATUS = re.compile(r"returned (?:401|403|404|408|429|5\d\d)\b")

# Inline git credential helper. Reproduces the JS ``BROKER_CREDENTIAL_HELPER``
# string byte-for-byte (the JS template literal resolves ``$${VAR}`` to a literal
# ``$`` followed by the env-var NAME, and ``\n`` to a real newline). Supplied only
# with ``git -c`` in broker-owned child processes; never persisted in a workspace.
# Git streams the requested host on stdin and this helper refuses to release the
# credential for any other origin. POSIX only, matching the source (no win32
# branch exists in the JS to preserve).
BROKER_CREDENTIAL_HELPER = (
    "!f() { test \"$1\" = get || exit 0; host=''; "
    "while IFS='=' read -r key value; do test \"$key\" = host && host=\"$value\"; done; "
    'test "$host" = "$' + BROKER_HOST_ENV + '" || exit 0; '
    'test -n "$' + BROKER_TOKEN_ENV + '" || exit 0; '
    "printf 'username=%s\npassword=%s\n' "
    '"$' + BROKER_USER_ENV + '" "$' + BROKER_TOKEN_ENV + '"; }; f'
)


# --------------------------------------------------------------------------- #
# Error type.
# --------------------------------------------------------------------------- #


class RepositoryBrokerError(Exception):
    """Mirrors the JS ``RepositoryBrokerError`` (carries ``code``)."""

    def __init__(self, message, code="repository_broker_error"):
        super().__init__(message)
        self.name = "RepositoryBrokerError"
        self.message = message
        self.code = code


# --------------------------------------------------------------------------- #
# Default git executor (used when no ``exec_file_impl`` is injected).
# --------------------------------------------------------------------------- #


class _ExecResult:
    __slots__ = ("stdout",)

    def __init__(self, stdout):
        self.stdout = stdout


class _ExecError(Exception):
    def __init__(self, message, stdout="", stderr=""):
        super().__init__(message)
        self.message = message
        self.stdout = stdout
        self.stderr = stderr


async def _default_exec_file(command, args, options):
    """Run a subprocess without a shell (mirrors ``execFile(..., {shell:false})``)."""
    env = options.get("env")
    cwd = options.get("cwd")
    timeout_ms = options.get("timeout")
    proc = await asyncio.create_subprocess_exec(
        command,
        *args,
        cwd=cwd,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        timeout = (timeout_ms / 1000) if timeout_ms else None
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise _ExecError(f"{command} timed out", "", "")
    out = stdout.decode("utf-8", "replace") if stdout else ""
    err = stderr.decode("utf-8", "replace") if stderr else ""
    if proc.returncode != 0:
        raise _ExecError(
            f"{command} exited with code {proc.returncode}", out, err
        )
    return _ExecResult(out)


# --------------------------------------------------------------------------- #
# Default forge fetch (used when no ``fetch_impl`` is injected).
# --------------------------------------------------------------------------- #


class _FetchHeaders:
    def __init__(self, headers):
        self._headers = headers

    def get(self, name):
        try:
            return self._headers.get(name)
        except Exception:
            return None


class _FetchResponse:
    def __init__(self, response):
        self._response = response
        self.status = response.status_code
        self.ok = 200 <= response.status_code < 300
        self.headers = _FetchHeaders(response.headers)

    async def text(self):
        return self._response.text


async def _default_fetch(url, options):
    """Injectable seam default: issue the request via httpx (lazy import)."""
    import httpx

    method = options.get("method", "GET")
    headers = options.get("headers") or {}
    body = options.get("body")
    timeout = LIMITS["apiTimeoutMs"] / 1000
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        response = await client.request(
            method, url, headers=headers, content=body
        )
    return _FetchResponse(response)


# --------------------------------------------------------------------------- #
# Numeric / text helpers.
# --------------------------------------------------------------------------- #


def _to_number(value):
    """Mirror JS ``Number(value)`` for the narrow cases this module needs."""
    if value is None:
        return float("nan")
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def _is_safe_integer(number):
    return math.isfinite(number) and number == int(number) and abs(number) <= (2 ** 53 - 1)


def _int_id(value):
    """Normalized review id: an int when integer-valued (so URLs read '17')."""
    number = _to_number(value)
    if math.isfinite(number) and number == int(number):
        return int(number)
    return number


def clean_text(value, max_len=None):
    text = "" if value is None else str(value)
    text = re.sub(r"\r\n?", "\n", text).strip()
    return text if max_len is None else text[:max_len]


def one_line(value, max_len=None):
    text = re.sub(r"\s+", " ", clean_text(value))
    if max_len is not None:
        text = text[:max_len]
    return text.strip()


def redact(value, secrets=None):
    text = "" if value is None else str(value)
    for secret in secrets or []:
        if secret:
            text = text.replace(str(secret), "***")
    text = re.sub(
        r"(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+",
        r"\1***",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"(private-token\s*[:=]\s*)[^\s,;]+", r"\1***", text, flags=re.IGNORECASE
    )
    text = re.sub(r"(password=)[^\s]+", r"\1***", text, flags=re.IGNORECASE)
    return text[: LIMITS["gitOutputChars"]]


def is_availability_failure(error):
    if not error:
        return False
    code = getattr(error, "code", None)
    if code in AVAILABILITY_ERROR_CODES:
        return True
    message = str(getattr(error, "message", None) or "")
    if code == "provider_error":
        return bool(_RETURNED_STATUS.search(message)) or bool(
            REMOTE_GIT_FAILURE.search(message)
        )
    return code == "git_failed" and bool(REMOTE_GIT_FAILURE.search(message))


# --------------------------------------------------------------------------- #
# Path containment guards (mirror path.relative + fs.realpathSync semantics).
# --------------------------------------------------------------------------- #


def is_path_inside(root, candidate):
    relative = os.path.relpath(os.path.abspath(candidate), os.path.abspath(root))
    if not relative or relative == ".":
        return False
    if relative == "..":
        return False
    if relative.startswith(".." + os.sep):
        return False
    if os.path.isabs(relative):
        return False
    return True


def assert_scoped_path(root, candidate):
    if not is_path_inside(root, candidate):
        raise RepositoryBrokerError(
            "Repository workspace is outside its allowed root.", "workspace_scope"
        )


def _safe_home_for(work_dir):
    digest = hashlib.sha256(
        os.path.abspath(work_dir).encode("utf-8")
    ).hexdigest()[:16]
    home = os.path.join(tempfile.gettempdir(), "techsymphony-agent-home", digest)
    os.makedirs(home, mode=0o700, exist_ok=True)
    return home


def build_safe_agent_env(base_env=None, work_dir=None):
    """Minimal environment for the unrestricted LocalShellBackend."""
    if base_env is None:
        base_env = os.environ
    if work_dir is None:
        work_dir = os.getcwd()
    env = {}
    for key in SAFE_ENV_KEYS:
        value = base_env.get(key)
        if isinstance(value, str) and value:
            env[key] = value
    env["HOME"] = _safe_home_for(work_dir)
    env["XDG_CONFIG_HOME"] = os.path.join(env["HOME"], ".config")
    env["XDG_CACHE_HOME"] = os.path.join(env["HOME"], ".cache")
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = "NUL" if sys.platform == "win32" else "/dev/null"
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "Never"
    return env


# --------------------------------------------------------------------------- #
# Validators.
# --------------------------------------------------------------------------- #

_BRANCH_UNSAFE = re.compile(r"[\s~^:?*\\\[\]]")
_BRANCH_ALLOWED = re.compile(r"^[A-Za-z0-9._/-]+$")


def validate_branch(value, name="branch"):
    branch = str(value or "").strip()
    if (
        not branch
        or len(branch) > 120
        or branch.startswith("-")
        or branch.startswith("/")
        or branch.endswith("/")
        or branch.endswith(".")
        or branch.endswith(".lock")
        or ".." in branch
        or "@{" in branch
        or _BRANCH_UNSAFE.search(branch)
        or not _BRANCH_ALLOWED.match(branch)
    ):
        raise RepositoryBrokerError(
            f"{name} is not a safe Git branch name.", "invalid_branch"
        )
    return branch


_SEGMENT_ALLOWED = re.compile(r"^[A-Za-z0-9_.-]+$")


def validate_repository(repository, provider):
    selected = str(provider or "").lower()
    if selected not in PROVIDERS:
        raise RepositoryBrokerError(
            "Repository provider is not supported.", "invalid_provider"
        )
    expected = PROVIDERS[selected]
    if not repository or repository.get("provider") != selected:
        raise RepositoryBrokerError(
            "Repository provider does not match the selected provider.",
            "provider_mismatch",
        )
    https = repository.get("https")
    try:
        if not https or "://" not in str(https):
            raise ValueError("no scheme")
        url = urlsplit(str(https))
        if not url.scheme or url.hostname is None:
            raise ValueError("invalid url")
    except ValueError:
        raise RepositoryBrokerError("Repository URL is invalid.", "invalid_repository")

    if (
        url.scheme != "https"
        or (url.hostname or "").lower() != expected["host"]
        or url.port
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        raise RepositoryBrokerError(
            "Repository URL is outside the selected provider host.",
            "provider_mismatch",
        )
    owner = str(repository.get("owner") or "")
    name = str(repository.get("name") or "")
    full_name = str(repository.get("fullName") or f"{owner}/{name}")
    segments = [s for s in full_name.split("/") if s]
    url_repository = re.sub(
        r"\.git$", "", re.sub(r"^/+|/+$", "", url.path), flags=re.IGNORECASE
    )
    if (
        not name
        or not owner
        or full_name != f"{owner}/{name}"
        or url_repository != full_name
        or len(segments) < 2
        or (selected == "github" and len(segments) != 2)
        or any(
            (not _SEGMENT_ALLOWED.match(segment) or segment in (".", ".."))
            for segment in segments
        )
    ):
        raise RepositoryBrokerError(
            "Repository namespace is invalid.", "invalid_repository"
        )
    return {
        "provider": selected,
        "host": expected["host"],
        "apiOrigin": expected["apiOrigin"],
        "owner": owner,
        "name": name,
        "fullName": full_name,
        "https": f"https://{expected['host']}/{full_name}.git",
    }


# --------------------------------------------------------------------------- #
# Result / error text extraction from git executor return values.
# --------------------------------------------------------------------------- #


def _result_text(result):
    if isinstance(result, str):
        return result
    if result is None:
        return ""
    if isinstance(result, dict):
        value = result.get("stdout")
        return value if isinstance(value, str) else ""
    value = getattr(result, "stdout", None)
    return value if isinstance(value, str) else ""


def _error_text(error):
    if not error:
        return "Unknown repository operation error."
    if isinstance(error, str):
        return error
    message = getattr(error, "message", None)
    if message is None and isinstance(error, BaseException):
        message = str(error)
    parts = [message, getattr(error, "stderr", None), getattr(error, "stdout", None)]
    return "\n".join(part for part in parts if part)


# --------------------------------------------------------------------------- #
# Forge response normalizers.
# --------------------------------------------------------------------------- #


def _as_list(value):
    return value if isinstance(value, list) else []


def status_from_github(check_runs, combined):
    checks = _as_list(check_runs.get("check_runs")) if isinstance(check_runs, dict) else []
    statuses = _as_list(combined.get("statuses")) if isinstance(combined, dict) else []
    check_count = _to_number(check_runs.get("total_count")) if isinstance(check_runs, dict) else float("nan")
    status_count = _to_number(combined.get("total_count")) if isinstance(combined, dict) else float("nan")
    complete = (
        check_runs is not None
        and combined is not None
        and (not math.isfinite(check_count) or check_count <= len(checks))
        and (not math.isfinite(status_count) or status_count <= len(statuses))
    )
    successful_conclusions = {"success", "neutral", "skipped"}
    pending_checks = any(item.get("status") != "completed" for item in checks)
    failed_checks = any(
        item.get("status") == "completed"
        and item.get("conclusion") not in successful_conclusions
        for item in checks
    )
    legacy_state = combined.get("state") if statuses else "none"
    if not complete:
        state = "unknown"
    elif failed_checks or legacy_state in ("failure", "error"):
        state = "failure"
    elif pending_checks or legacy_state == "pending":
        state = "pending"
    elif checks or statuses:
        state = "success"
    else:
        state = "none"
    return {
        "state": state,
        "complete": complete,
        "checkRuns": [
            {
                "name": one_line(item.get("name"), 160),
                "status": one_line(item.get("status"), 40),
                "conclusion": one_line(item.get("conclusion"), 40)
                if item.get("conclusion")
                else None,
                "url": item.get("html_url")
                if isinstance(item.get("html_url"), str)
                else None,
            }
            for item in checks[:20]
        ],
        "statuses": [
            {
                "context": one_line(item.get("context"), 160),
                "state": one_line(item.get("state"), 40),
                "description": one_line(item.get("description"), 240),
                "url": item.get("target_url")
                if isinstance(item.get("target_url"), str)
                else None,
            }
            for item in statuses[:20]
        ],
    }


def _label_name(label):
    if isinstance(label, str):
        return one_line(label, 100)
    if isinstance(label, dict):
        return one_line(label.get("name"), 100)
    return one_line(label, 100)


def normalize_review(provider, value):
    if provider == "github":
        head = value.get("head") or {}
        base = value.get("base") or {}
        return {
            "provider": provider,
            "id": _int_id(value.get("number")),
            "url": value.get("html_url") or None,
            "state": "merged" if value.get("merged") else (value.get("state") or "unknown"),
            "title": one_line(value.get("title"), LIMITS["titleChars"]),
            "sourceBranch": head.get("ref"),
            "targetBranch": base.get("ref"),
            "headSha": head.get("sha"),
            "draft": bool(value.get("draft")),
            "mergeable": None if value.get("mergeable") is None else bool(value.get("mergeable")),
            "labels": [
                name
                for name in (_label_name(label) for label in _as_list(value.get("labels")))
                if name
            ],
        }
    diff_refs = value.get("diff_refs") or {}
    return {
        "provider": provider,
        "id": _int_id(value.get("iid")),
        "url": value.get("web_url") or None,
        "state": value.get("state") or "unknown",
        "title": one_line(value.get("title"), LIMITS["titleChars"]),
        "sourceBranch": value.get("source_branch"),
        "targetBranch": value.get("target_branch"),
        "headSha": value.get("sha") or diff_refs.get("head_sha") or None,
        "draft": bool(value.get("draft")),
        "mergeable": value.get("detailed_merge_status") == "mergeable",
        "detailedMergeStatus": value.get("detailed_merge_status") or None,
        "blockingDiscussionsResolved": None
        if value.get("blocking_discussions_resolved") is None
        else bool(value.get("blocking_discussions_resolved")),
        "labels": [
            name
            for name in (one_line(label, 100) for label in _as_list(value.get("labels")))
            if name
        ],
    }


def feedback_window(items, cursor=0):
    start = cursor if isinstance(cursor, int) and not isinstance(cursor, bool) and cursor >= 0 else 0
    feedback = items[start : start + LIMITS["feedbackItems"]]
    nxt = start + len(feedback)
    return {
        "feedback": feedback,
        "feedbackCursor": start,
        "nextFeedbackCursor": nxt if nxt < len(items) else None,
        "feedbackTotal": len(items),
    }


def bound_feedback(items):
    limit = LIMITS["feedbackItems"] * (LIMITS["toolCalls"] - 8)
    return {"items": items[:limit], "complete": len(items) <= limit}


# --------------------------------------------------------------------------- #
# The broker.
# --------------------------------------------------------------------------- #

_UNSET = object()


class RepositoryBroker:
    def __init__(
        self,
        provider,
        repository,
        token="",
        workspace_root=None,
        work_dir=None,
        branch=None,
        label="",
        step=None,
        fetch_impl=None,
        exec_file_impl=None,
        staging_root=None,
        # camelCase aliases so callers can mirror the JS options object.
        workspaceRoot=None,
        workDir=None,
        fetchImpl=None,
        execFileImpl=None,
        stagingRoot=None,
    ):
        workspace_root = workspace_root if workspace_root is not None else workspaceRoot
        work_dir = work_dir if work_dir is not None else workDir
        fetch_impl = fetch_impl if fetch_impl is not None else fetchImpl
        exec_file_impl = exec_file_impl if exec_file_impl is not None else execFileImpl
        staging_root = staging_root if staging_root is not None else stagingRoot

        self.repository = validate_repository(repository, provider)
        self.workspace_root = os.path.abspath(workspace_root)
        self.work_dir = os.path.abspath(work_dir)
        assert_scoped_path(self.workspace_root, self.work_dir)
        self.branch = validate_branch(branch, "task branch")
        self._scope_branch = self.branch
        self.base_branch = None
        self.label = one_line(label, 100)
        self.step_fn = step if callable(step) else (lambda *args, **kwargs: None)

        self._token = str(token or "")
        self._fetch_impl = fetch_impl if fetch_impl is not None else _default_fetch
        self._exec_file_impl = (
            exec_file_impl if exec_file_impl is not None else _default_exec_file
        )
        self._calls = 0
        self._lock = asyncio.Lock()
        self._disposed = False
        self._feedback_reads = {}
        self._availability_error = None
        self._remote_empty = False

        private_root = os.path.abspath(
            staging_root
            or os.path.join(tempfile.gettempdir(), "techsymphony-repository-broker")
        )
        os.makedirs(private_root, mode=0o700, exist_ok=True)
        self.staging_dir = tempfile.mkdtemp(prefix="scope-", dir=private_root)
        os.chmod(self.staging_dir, 0o700)
        self.git_dir = os.path.join(self.staging_dir, "repository.git")

    # -- camelCase convenience accessors (mirror the JS property name) -------- #
    @property
    def baseBranch(self):
        return self.base_branch

    @baseBranch.setter
    def baseBranch(self, value):
        self.base_branch = value

    @property
    def step(self):
        return self.step_fn

    def _call_step(self, message, level="info"):
        try:
            self.step_fn(message, level)
        except TypeError:
            self.step_fn(message)

    def public_info(self):
        return {
            "provider": self.repository["provider"],
            "repository": self.repository["fullName"],
            "branch": self.branch,
            "baseBranch": self.base_branch,
        }

    publicInfo = public_info

    def availability_error(self):
        return self._availability_error

    availabilityError = availability_error

    def _assert_active(self):
        if self._disposed:
            raise RepositoryBrokerError(
                "Repository broker scope is closed.", "scope_closed"
            )

    def _safe_error(self, error):
        return redact(_error_text(error), [self._token])

    def _base_env(self, auth=False):
        env = build_safe_agent_env(os.environ, self.staging_dir)
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        env["GIT_CONFIG_GLOBAL"] = "NUL" if sys.platform == "win32" else "/dev/null"
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["GCM_INTERACTIVE"] = "Never"
        env.pop("GIT_ASKPASS", None)
        env.pop("SSH_ASKPASS", None)
        if auth and self._token:
            env[BROKER_TOKEN_ENV] = self._token
            env[BROKER_HOST_ENV] = self.repository["host"]
            env[BROKER_USER_ENV] = PROVIDERS[self.repository["provider"]]["username"]
        return env

    async def _git(
        self,
        args,
        cwd=None,
        auth=False,
        allow_failure=False,
        output_limit=None,
    ):
        self._assert_active()
        if cwd is None:
            cwd = self.staging_dir
        if output_limit is None:
            output_limit = LIMITS["gitOutputChars"]
        config = [
            "-c", "core.hooksPath=/dev/null",
            "-c", "credential.helper=",
            "-c", "http.extraHeader=",
            "-c", "http.proxy=",
            "-c", "http.sslVerify=true",
        ]
        if auth:
            config += ["-c", f"credential.helper={BROKER_CREDENTIAL_HELPER}"]
        try:
            result = await self._exec_file_impl(
                "git",
                [*config, *args],
                {
                    "cwd": cwd,
                    "env": self._base_env(auth=auth),
                    "timeout": LIMITS["gitTimeoutMs"],
                    "maxBuffer": 4 * 1024 * 1024,
                    "windowsHide": True,
                },
            )
            return clean_text(_result_text(result), output_limit)
        except Exception as error:
            if isinstance(error, RepositoryBrokerError):
                raise
            if allow_failure:
                return None
            raise RepositoryBrokerError(self._safe_error(error), "git_failed")

    async def _bare(self, args, **options):
        return await self._git([f"--git-dir={self.git_dir}", *args], **options)

    async def _workspace(self, args, **options):
        self._assert_workspace()
        return await self._git(["-C", self.work_dir, *args], **options)

    def _assert_workspace(self):
        assert_scoped_path(self.workspace_root, self.work_dir)
        git_path = os.path.join(self.work_dir, ".git")
        if not os.path.exists(git_path):
            raise RepositoryBrokerError(
                "Repository workspace is not initialized.", "workspace_missing"
            )
        root_real = os.path.realpath(self.workspace_root)
        work_real = os.path.realpath(self.work_dir)
        if not is_path_inside(root_real, work_real):
            raise RepositoryBrokerError(
                "Repository workspace escaped its allowed root.", "workspace_scope"
            )
        git_stat = os.lstat(git_path)
        git_real = os.path.realpath(git_path)
        if not _stat.S_ISDIR(git_stat.st_mode) or not is_path_inside(work_real, git_real):
            raise RepositoryBrokerError(
                "Workspace Git metadata escaped its allowed directory.",
                "workspace_scope",
            )

    async def _sanitize_workspace_config(self):
        await self._workspace(
            ["config", "--local", "--unset-all", "credential.helper"],
            allow_failure=True,
        )
        await self._workspace(
            ["config", "--local", "--unset-all", "http.extraHeader"], allow_failure=True
        )
        await self._workspace(
            ["config", "--local", "--unset-all", "http.proxy"], allow_failure=True
        )
        await self._workspace(
            ["config", "--local", "--unset-all", "remote.origin.proxy"],
            allow_failure=True,
        )
        await self._workspace(
            ["config", "user.name", "AI Fleet Agent"], allow_failure=True
        )
        await self._workspace(
            ["config", "user.email", "ai-fleet@localhost"], allow_failure=True
        )
        git_dir = os.path.realpath(os.path.join(self.work_dir, ".git"))
        info_dir = os.path.join(self.work_dir, ".git", "info")
        if os.path.exists(info_dir):
            info_stat = os.lstat(info_dir)
            if not _stat.S_ISDIR(info_stat.st_mode) or _stat.S_ISLNK(info_stat.st_mode):
                raise RepositoryBrokerError(
                    "Workspace Git exclude directory is unsafe.", "workspace_scope"
                )
        else:
            os.makedirs(info_dir, mode=0o700)
        if not is_path_inside(git_dir, os.path.realpath(info_dir)):
            raise RepositoryBrokerError(
                "Workspace Git exclude directory escaped its scope.", "workspace_scope"
            )
        exclude_path = os.path.join(info_dir, "exclude")
        if os.path.exists(exclude_path):
            exclude_stat = os.lstat(exclude_path)
            if (
                not _stat.S_ISREG(exclude_stat.st_mode)
                or _stat.S_ISLNK(exclude_stat.st_mode)
                or not is_path_inside(git_dir, os.path.realpath(exclude_path))
            ):
                raise RepositoryBrokerError(
                    "Workspace Git exclude file is unsafe.", "workspace_scope"
                )
        existing_exclude = ""
        if os.path.exists(exclude_path):
            with open(exclude_path, "r", encoding="utf-8") as handle:
                existing_exclude = handle.read()
        exclude_lines = [line.strip() for line in re.split(r"\r?\n", existing_exclude)]
        if FRAMEWORK_SKILLS_EXCLUDE not in exclude_lines:
            separator = "\n" if existing_exclude and not existing_exclude.endswith("\n") else ""
            with open(exclude_path, "a", encoding="utf-8") as handle:
                handle.write(f"{separator}{FRAMEWORK_SKILLS_EXCLUDE}\n")
        self._assert_safe_workspace_exclude()
        with open(
            os.path.join(self.work_dir, ".git", "config"), "r", encoding="utf-8"
        ) as handle:
            config_text = handle.read()
        if self._token and self._token in config_text:
            raise RepositoryBrokerError(
                "Repository credential was found in workspace configuration.",
                "credential_persisted",
            )

    async def _assert_origin_url(self):
        remote = await self._workspace(["remote", "get-url", "origin"])
        if re.sub(r"\.git$", "", remote, flags=re.IGNORECASE) != re.sub(
            r"\.git$", "", self.repository["https"], flags=re.IGNORECASE
        ):
            raise RepositoryBrokerError(
                "Workspace origin does not match the scoped repository.",
                "origin_mismatch",
            )

    async def _assert_canonical_origin(self):
        await self._assert_origin_url()
        dangerous = await self._workspace(
            [
                "config", "--local", "--get-regexp",
                r"^(credential\..*|credential\.helper|url\..*\.insteadof|"
                r"http\..*extraheader|http\.proxy|remote\.origin\.proxy|include\.path|"
                r"includeif\..*\.path|extensions\.worktreeconfig|"
                r"core\.(fsmonitor|sparsecheckout|sparsecheckoutcone|ignorestat|"
                r"checkstat|excludesfile|worktree)|status\.showuntrackedfiles|"
                r"diff\.ignoresubmodules|submodule\..*\.ignore)$",
            ],
            allow_failure=True,
        )
        if dangerous:
            raise RepositoryBrokerError(
                "Workspace Git configuration contains an unsafe local override.",
                "unsafe_git_config",
            )

    def _assert_safe_workspace_exclude(self):
        git_dir = os.path.realpath(os.path.join(self.work_dir, ".git"))
        exclude_path = os.path.join(self.work_dir, ".git", "info", "exclude")
        if not os.path.exists(exclude_path):
            return
        exclude_stat = os.lstat(exclude_path)
        if (
            not _stat.S_ISREG(exclude_stat.st_mode)
            or _stat.S_ISLNK(exclude_stat.st_mode)
            or not is_path_inside(git_dir, os.path.realpath(exclude_path))
        ):
            raise RepositoryBrokerError(
                "Workspace Git exclude file is unsafe.", "workspace_scope"
            )
        with open(exclude_path, "r", encoding="utf-8") as handle:
            content = handle.read()
        unsafe = [
            line
            for line in (raw.strip() for raw in re.split(r"\r?\n", content))
            if line and not line.startswith("#") and line != FRAMEWORK_SKILLS_EXCLUDE
        ]
        if unsafe:
            raise RepositoryBrokerError(
                "Workspace Git exclude file contains an untrusted ignore rule.",
                "unsafe_git_config",
            )

    async def _workspace_status(self):
        await self._assert_canonical_origin()
        self._assert_safe_workspace_exclude()
        output_limit = 4 * 1024 * 1024
        index_flags = await self._workspace(
            ["-c", "core.fsmonitor=false", "ls-files", "-v"], output_limit=output_limit
        )
        if re.search(r"(^|\n)(?:S|[a-z]) ", index_flags):
            raise RepositoryBrokerError(
                "Workspace index uses skip-worktree or assume-unchanged flags.",
                "unsafe_index_flags",
            )
        fsmonitor_flags = await self._workspace(
            ["-c", "core.fsmonitor=false", "ls-files", "-f"], output_limit=output_limit
        )
        if re.search(r"(^|\n)[a-z] ", fsmonitor_flags):
            raise RepositoryBrokerError(
                "Workspace index contains fsmonitor-valid flags.", "unsafe_index_flags"
            )
        return await self._workspace(
            [
                "-c", "core.fsmonitor=false",
                "-c", "core.checkStat=default",
                "-c", "core.fileMode=true",
                "-c", "status.showUntrackedFiles=all",
                "status", "--porcelain", "--untracked-files=all",
                "--ignore-submodules=none",
            ]
        )

    async def _prepare_bare(self):
        if not os.path.exists(self.git_dir):
            await self._git(["init", "--bare", self.git_dir])
        await self._bare(["remote", "remove", "origin"], allow_failure=True)
        await self._bare(["remote", "add", "origin", self.repository["https"]])
        symref = await self._bare(
            ["ls-remote", "--symref", "origin", "HEAD"], auth=True
        )
        match = re.search(r"^ref:\s+refs/heads/([^\s]+)\s+HEAD", symref, flags=re.MULTILINE)
        discovered_base = validate_branch(
            match.group(1) if match else "main", "base branch"
        )
        if not self.base_branch:
            self.base_branch = discovered_base
        await self._bare(
            ["fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"],
            auth=True,
        )
        mirrored = await self._bare(
            ["for-each-ref", "--count=1", "refs/remotes/origin/"], allow_failure=True
        )
        self._remote_empty = not mirrored or not mirrored.strip()

    async def _seed_empty_remote(self):
        has_commit = await self._workspace(
            ["rev-parse", "--verify", "--quiet", "HEAD"], allow_failure=True
        )
        if has_commit is None:
            await self._workspace(["checkout", "--orphan", self.base_branch])
            await self._workspace(
                ["commit", "--allow-empty", "-m", "Initialize repository"]
            )
        else:
            await self._workspace(["checkout", "-B", self.base_branch, "HEAD"])
        await self._publish_base()
        await self._bare(
            ["fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"],
            auth=True,
        )
        await self._export_remote_refs()
        self._remote_empty = False

    async def _publish_base(self):
        if not self._token:
            raise RepositoryBrokerError(
                "No repository token is configured.", "missing_token"
            )
        current = await self._workspace(["branch", "--show-current"])
        if current != self.base_branch:
            raise RepositoryBrokerError(
                "Base-branch initialization must run on the scoped base branch.",
                "branch_scope",
            )
        dirty = await self._workspace_status()
        if dirty:
            raise RepositoryBrokerError(
                "Commit all workspace changes before publishing the base branch.",
                "workspace_dirty",
            )
        workspace_git = os.path.join(self.work_dir, ".git")
        local_url = Path(workspace_git).as_uri()
        head_sha = await self._workspace(["rev-parse", "HEAD"])
        await self._bare(
            [
                "-c", "protocol.file.allow=always",
                "fetch", "--no-tags", local_url,
                f"+{head_sha}:refs/heads/{self.base_branch}",
            ]
        )
        staged_sha = await self._bare(["rev-parse", f"refs/heads/{self.base_branch}"])
        if staged_sha != head_sha:
            raise RepositoryBrokerError(
                "Broker staging SHA did not match base HEAD.", "sha_mismatch"
            )
        await self._bare(
            ["push", "origin", f"refs/heads/{self.base_branch}:refs/heads/{self.base_branch}"],
            auth=True,
        )
        self._call_step(
            f"Repository broker initialized {self.repository['fullName']} on "
            f"{self.base_branch} at {head_sha[:12]}."
        )

    async def _export_remote_refs(self):
        await self._assert_canonical_origin()
        stage_url = Path(self.git_dir).as_uri()
        await self._workspace(
            [
                "-c", "protocol.file.allow=always",
                "fetch", "--prune", "--no-tags", stage_url,
                "+refs/remotes/origin/*:refs/remotes/origin/*",
            ]
        )

    async def prepare(self, shallow=False):
        self._assert_active()
        os.makedirs(self.workspace_root, exist_ok=True)
        assert_scoped_path(self.workspace_root, self.work_dir)
        has_git = os.path.exists(os.path.join(self.work_dir, ".git"))
        if has_git:
            await self._assert_origin_url()
        await self._prepare_bare()

        if not has_git:
            if os.path.exists(self.work_dir) and os.listdir(self.work_dir):
                raise RepositoryBrokerError(
                    "Workspace exists but is not a Git repository.", "workspace_invalid"
                )
            os.makedirs(os.path.dirname(self.work_dir), exist_ok=True)
            clone_args = ["clone", "--no-hardlinks", "--origin", "origin"]
            if shallow:
                clone_args += ["--depth", "1"]
            clone_args += [self.git_dir, self.work_dir]
            await self._git(clone_args, cwd=self.workspace_root)
            await self._workspace(
                ["remote", "set-url", "origin", self.repository["https"]]
            )

        await self._sanitize_workspace_config()
        await self._assert_canonical_origin()
        await self._export_remote_refs()

        dirty = await self._workspace_status()
        if dirty:
            self._call_step(
                "Discarding uncommitted changes left by an earlier run.", "warn"
            )
            await self._workspace(["reset", "--hard"])
            await self._workspace(["clean", "-fd"])
            still_dirty = await self._workspace_status()
            if still_dirty:
                raise RepositoryBrokerError(
                    "Workspace could not be reset to a clean state.", "workspace_dirty"
                )
        if self._remote_empty:
            await self._seed_empty_remote()
        exists = await self._workspace(
            ["show-ref", "--verify", "--quiet", f"refs/heads/{self.branch}"],
            allow_failure=True,
        )
        remote_task_ref = f"refs/remotes/origin/{self.branch}"
        remote_exists = await self._workspace(
            ["show-ref", "--verify", "--quiet", remote_task_ref], allow_failure=True
        )
        if exists is not None:
            await self._workspace(["checkout", self.branch])
            if remote_exists is not None:
                refreshed = await self._workspace(
                    ["merge", "--ff-only", "--no-edit", remote_task_ref],
                    allow_failure=True,
                )
                if refreshed is None:
                    self._call_step(
                        f"Scoped branch {self.branch} diverged from its remote; "
                        "the pull skill must merge it.",
                        "warn",
                    )
        elif remote_exists is not None:
            await self._workspace(["checkout", "-b", self.branch, remote_task_ref])
        else:
            base_local = await self._workspace(
                ["show-ref", "--verify", "--quiet", f"refs/heads/{self.base_branch}"],
                allow_failure=True,
            )
            base_start = (
                self.base_branch
                if base_local is not None
                else f"refs/remotes/origin/{self.base_branch}"
            )
            await self._workspace(["checkout", "-b", self.branch, base_start])
        await self._sanitize_workspace_config()
        self._call_step(
            f"Repository broker ready for {self.repository['fullName']} on {self.branch}."
        )
        return self.public_info()

    async def fetch_remote(self):
        await self._prepare_bare()
        await self._export_remote_refs()
        return {**self.public_info(), "fetched": True}

    fetchRemote = fetch_remote

    async def _assert_current_branch(self):
        await self._assert_canonical_origin()
        current = await self._workspace(["branch", "--show-current"])
        if current != self.branch:
            raise RepositoryBrokerError(
                f"Workspace must stay on scoped branch {self.branch}.", "branch_scope"
            )
        return await self._workspace(["rev-parse", "HEAD"])

    def _retry_branch(self, review, ordinal):
        numeric_id = _to_number(review.get("id") if review else None)
        if _is_safe_integer(numeric_id) and numeric_id > 0:
            review_key = str(int(numeric_id))
        else:
            review_key = hashlib.sha256(
                (
                    f"{self.repository['provider']}:{self._scope_branch}:"
                    f"{review.get('url') if review else None}:"
                    f"{review.get('state') if review else None}"
                ).encode("utf-8")
            ).hexdigest()[:12]
        suffix = f"-retry-{review_key}" + (f"-{ordinal}" if ordinal > 1 else "")
        prefix = re.sub(r"[/.]+$", "", self._scope_branch[: 120 - len(suffix)])
        return validate_branch(f"{prefix or 'task'}{suffix}", "retry branch")

    async def _branch_refs(self, branch):
        local_ref = f"refs/heads/{branch}"
        remote_ref = f"refs/remotes/origin/{branch}"
        local = await self._workspace(
            ["show-ref", "--verify", "--quiet", local_ref], allow_failure=True
        )
        remote = await self._workspace(
            ["show-ref", "--verify", "--quiet", remote_ref], allow_failure=True
        )
        return {
            "local": local is not None,
            "remote": remote is not None,
            "localRef": local_ref,
            "remoteRef": remote_ref,
        }

    async def _can_resume_retry_review(self, review, terminal_review, refs, current_sha):
        if not review.get("headSha"):
            return False
        if terminal_review.get("headSha") and terminal_review["headSha"] == current_sha:
            return True
        if review["headSha"] == current_sha:
            return True
        comparison_ref = (
            refs["remoteRef"]
            if refs["remote"]
            else (refs["localRef"] if refs["local"] else None)
        )
        if not comparison_ref:
            return False
        ref_sha = await self._workspace(
            ["rev-parse", comparison_ref], allow_failure=True
        )
        if not ref_sha or ref_sha != review["headSha"]:
            return False
        unchanged = await self._workspace(
            [
                "-c", "core.fsmonitor=false", "-c", "core.checkStat=default",
                "diff", "--quiet", comparison_ref, "HEAD", "--",
            ],
            allow_failure=True,
        )
        return unchanged is not None

    async def _checkout_retry_review(self, branch, review, refs):
        previous = self.branch
        if refs["local"]:
            switched = await self._workspace(["checkout", branch], allow_failure=True)
            if switched is not None and refs["remote"]:
                switched = await self._workspace(
                    ["merge", "--ff-only", "--no-edit", refs["remoteRef"]],
                    allow_failure=True,
                )
        elif refs["remote"]:
            switched = await self._workspace(
                ["checkout", "-b", branch, refs["remoteRef"]], allow_failure=True
            )
        else:
            return False
        if switched is None:
            restored = await self._workspace(["checkout", previous], allow_failure=True)
            if restored is None:
                current = await self._workspace(
                    ["branch", "--show-current"], allow_failure=True
                )
                if current == branch:
                    self.branch = branch
                raise RepositoryBrokerError(
                    "Could not restore the original scoped branch.", "branch_scope"
                )
            return False
        head_sha = await self._workspace(["rev-parse", "HEAD"], allow_failure=True)
        if not head_sha or head_sha != review["headSha"]:
            restored = await self._workspace(["checkout", previous], allow_failure=True)
            if restored is None:
                self.branch = branch
                raise RepositoryBrokerError(
                    "Could not restore the original scoped branch.", "branch_scope"
                )
            return False
        self.branch = branch
        self._feedback_reads.clear()
        return True

    async def _recover_terminal_review(self, review):
        dirty = await self._workspace_status()
        if dirty:
            raise RepositoryBrokerError(
                "Commit all workspace changes before creating a retry branch.",
                "workspace_dirty",
            )
        await self._prepare_bare()
        await self._export_remote_refs()
        current_sha = await self._workspace(["rev-parse", "HEAD"])
        for ordinal in range(1, LIMITS["retryBranches"] + 1):
            candidate = self._retry_branch(review, ordinal)
            candidate_review = await self._find_review(candidate)
            refs = await self._branch_refs(candidate)
            if candidate_review:
                normalized = await self._review_details(
                    normalize_review(self.repository["provider"], candidate_review),
                    candidate,
                )
                if (
                    normalized["state"] in ("open", "opened")
                    and await self._can_resume_retry_review(
                        normalized, review, refs, current_sha
                    )
                    and await self._checkout_retry_review(candidate, normalized, refs)
                ):
                    self._call_step(
                        f"Resumed existing review on server-scoped retry branch {candidate}.",
                        "warn",
                    )
                    return {"branch": candidate, "review": normalized}
                continue
            if refs["local"] or refs["remote"]:
                continue

            await self._workspace(["checkout", "-b", candidate])
            previous = self.branch
            self.branch = candidate
            self._feedback_reads.clear()
            try:
                await self.push_branch()
            except Exception as error:
                self._call_step(
                    f"Retry branch {candidate} was selected but could not be "
                    f"published: {self._safe_error(error)}",
                    "warn",
                )
                restored = await self._workspace(
                    ["checkout", previous], allow_failure=True
                )
                if restored is not None:
                    self.branch = previous
                raise
            self._call_step(
                f"Terminal review on {previous} detected; continuing on "
                f"server-scoped retry branch {candidate}.",
                "warn",
            )
            return {"branch": candidate, "review": None}
        raise RepositoryBrokerError(
            "No unused server-scoped retry branch is available.",
            "retry_branch_exhausted",
        )

    async def push_branch(self):
        if not self._token:
            raise RepositoryBrokerError(
                "No repository token is configured.", "missing_token"
            )
        head_sha = await self._assert_current_branch()
        dirty = await self._workspace_status()
        if dirty:
            raise RepositoryBrokerError(
                "Commit all workspace changes before pushing.", "workspace_dirty"
            )
        workspace_git = os.path.join(self.work_dir, ".git")
        local_url = Path(workspace_git).as_uri()
        await self._bare(
            [
                "-c", "protocol.file.allow=always",
                "fetch", "--no-tags", local_url,
                f"+{head_sha}:refs/heads/{self.branch}",
            ]
        )
        staged_sha = await self._bare(["rev-parse", f"refs/heads/{self.branch}"])
        if staged_sha != head_sha:
            raise RepositoryBrokerError(
                "Broker staging SHA did not match workspace HEAD.", "sha_mismatch"
            )
        await self._bare(
            ["push", "origin", f"refs/heads/{self.branch}:refs/heads/{self.branch}"],
            auth=True,
        )
        self._call_step(
            f"Repository broker pushed {self.branch} at {head_sha[:12]}."
        )
        return {**self.public_info(), "pushed": True, "headSha": head_sha}

    pushBranch = push_branch

    def _api_path(self):
        if self.repository["provider"] == "github":
            return (
                f"/repos/{quote(self.repository['owner'], safe='')}/"
                f"{quote(self.repository['name'], safe='')}"
            )
        return f"/api/v4/projects/{quote(self.repository['fullName'], safe='')}"

    async def _request(
        self, method, endpoint, body=_UNSET, allow404=False, with_meta=False
    ):
        if not self._token:
            raise RepositoryBrokerError(
                "No repository token is configured.", "missing_token"
            )
        github = self.repository["provider"] == "github"
        if github:
            headers = {
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "tech-symphony-repository-broker",
            }
        else:
            headers = {
                "Accept": "application/json",
                "PRIVATE-TOKEN": self._token,
                "User-Agent": "tech-symphony-repository-broker",
            }
        if body is not _UNSET:
            headers["Content-Type"] = "application/json"
        url = f"{self.repository['apiOrigin']}{endpoint}"
        try:
            response = await self._fetch_impl(
                url,
                {
                    "method": method,
                    "headers": headers,
                    "body": None if body is _UNSET else _json.dumps(body),
                    "redirect": "error",
                    "signal": None,
                },
            )
            raw = await response.text()
            if len(raw.encode("utf-8")) > LIMITS["responseBytes"]:
                raise RepositoryBrokerError(
                    "Repository provider response exceeded the size limit.",
                    "response_too_large",
                )
            data = None
            if raw:
                try:
                    data = _json.loads(raw)
                except ValueError:
                    data = {"message": one_line(raw, 500)}
            if allow404 and response.status == 404:
                return None
            if not response.ok:
                message = None
                if isinstance(data, dict):
                    message = (
                        data.get("message")
                        or data.get("error_description")
                        or data.get("error")
                    )
                raise RepositoryBrokerError(
                    f"Repository provider returned {response.status}: "
                    f"{self._safe_error(one_line(message or 'request failed', 500))}",
                    "provider_error",
                )
            if with_meta:
                def header(name):
                    getter = getattr(response.headers, "get", None)
                    return getter(name) if callable(getter) else None

                link = header("link") or ""
                next_page = header("x-next-page") or ""
                has_next = bool(
                    re.search(r'rel\s*=\s*"?next"?', link, flags=re.IGNORECASE)
                ) or bool(str(next_page).strip())
                return {"data": data, "hasNext": has_next}
            return data
        except RepositoryBrokerError:
            raise
        except Exception as error:
            raise RepositoryBrokerError(
                self._safe_error(error), "provider_unavailable"
            )

    async def _find_review(self, branch=None):
        if branch is None:
            branch = self.branch
        scoped_branch = validate_branch(branch, "review branch")
        api = self._api_path()
        if self.repository["provider"] == "github":
            query = urlencode(
                {
                    "state": "all",
                    "head": f"{self.repository['owner']}:{scoped_branch}",
                    "base": self.base_branch,
                    "per_page": "20",
                }
            )
            listing = await self._request("GET", f"{api}/pulls?{query}")
            exact = [
                item
                for item in _as_list(listing)
                if item
                and item.get("head")
                and item.get("base")
                and item["head"].get("ref") == scoped_branch
                and item["base"].get("ref") == self.base_branch
            ]
            return (
                next((item for item in exact if item.get("state") == "open"), None)
                or (exact[0] if exact else None)
            )
        query = urlencode(
            {
                "scope": "all",
                "state": "all",
                "source_branch": scoped_branch,
                "target_branch": self.base_branch,
                "per_page": "20",
            }
        )
        listing = await self._request("GET", f"{api}/merge_requests?{query}")
        exact = [
            item
            for item in _as_list(listing)
            if item
            and item.get("source_branch") == scoped_branch
            and item.get("target_branch") == self.base_branch
        ]
        return (
            next((item for item in exact if item.get("state") == "opened"), None)
            or (exact[0] if exact else None)
        )

    async def _apply_review_label(self, review_id):
        if not self.label:
            return
        api = self._api_path()
        if self.repository["provider"] == "github":
            await self._request(
                "POST", f"{api}/issues/{review_id}/labels", {"labels": [self.label]}
            )
        else:
            await self._request(
                "PUT", f"{api}/merge_requests/{review_id}", {"add_labels": self.label}
            )

    async def _review_details(self, review, branch=None):
        if branch is None:
            branch = self.branch
        api = self._api_path()
        if self.repository["provider"] == "github":
            return self._assert_review_scope(
                normalize_review(
                    "github", await self._request("GET", f"{api}/pulls/{review['id']}")
                ),
                branch,
            )
        return self._assert_review_scope(
            normalize_review(
                "gitlab",
                await self._request(
                    "GET",
                    f"{api}/merge_requests/{review['id']}?include_rebase_in_progress=true",
                ),
            ),
            branch,
        )

    def _assert_review_scope(self, review, branch=None):
        if branch is None:
            branch = self.branch
        if (
            not review
            or review.get("sourceBranch") != branch
            or review.get("targetBranch") != self.base_branch
        ):
            raise RepositoryBrokerError(
                "Review source or target branch moved outside the broker scope.",
                "review_scope",
            )
        return review

    async def _merged_review_has_no_new_work(self, review, local_sha):
        dirty = await self._workspace_status()
        if dirty:
            raise RepositoryBrokerError(
                "Commit or discard workspace changes before resolving a merged review.",
                "workspace_dirty",
            )
        if review.get("headSha") and review["headSha"] == local_sha:
            return True
        await self._prepare_bare()
        await self._export_remote_refs()
        unchanged = await self._workspace(
            ["diff", "--quiet", f"refs/remotes/origin/{self.base_branch}", "HEAD", "--"],
            allow_failure=True,
        )
        return unchanged is not None

    async def open_review(self, title=None, body="", **_ignored):
        local_sha = await self._assert_current_branch()
        review_title = one_line(title, LIMITS["titleChars"])
        review_body = clean_text(body, LIMITS["bodyChars"])
        if not review_title:
            raise RepositoryBrokerError("A review title is required.", "invalid_input")
        existing = await self._find_review()
        if existing:
            normalized = await self._review_details(
                normalize_review(self.repository["provider"], existing)
            )
            if normalized["state"] in ("open", "opened"):
                warning = None
                try:
                    await self._apply_review_label(normalized["id"])
                except Exception as error:
                    warning = f"Review reused, but label could not be applied: {self._safe_error(error)}"
                return {
                    **self.public_info(),
                    **normalized,
                    "reused": True,
                    "labelApplied": (not self.label) or (not warning),
                    "warning": warning,
                }
            if normalized["state"] == "merged" and await self._merged_review_has_no_new_work(
                normalized, local_sha
            ):
                warning = None
                try:
                    await self._apply_review_label(normalized["id"])
                except Exception as error:
                    warning = f"Merged review reused, but label could not be applied: {self._safe_error(error)}"
                return {
                    **self.public_info(),
                    **normalized,
                    "reused": True,
                    "alreadyMerged": True,
                    "labelApplied": (not self.label) or (not warning),
                    "warning": warning,
                }
            recovery = await self._recover_terminal_review(normalized)
            if recovery["review"]:
                warning = None
                try:
                    await self._apply_review_label(recovery["review"]["id"])
                except Exception as error:
                    warning = f"Review resumed, but label could not be applied: {self._safe_error(error)}"
                return {
                    **self.public_info(),
                    **recovery["review"],
                    "reused": True,
                    "resumed": True,
                    "labelApplied": (not self.label) or (not warning),
                    "warning": warning,
                }

        api = self._api_path()
        warning = None
        if self.repository["provider"] == "github":
            created = await self._request(
                "POST",
                f"{api}/pulls",
                {
                    "title": review_title,
                    "body": review_body,
                    "head": self.branch,
                    "base": self.base_branch,
                    "draft": False,
                },
            )
        else:
            mr_body = {
                "source_branch": self.branch,
                "target_branch": self.base_branch,
                "title": review_title,
                "description": review_body,
                "remove_source_branch": True,
                "squash": True,
            }
            if self.label:
                mr_body["labels"] = self.label
            created = await self._request("POST", f"{api}/merge_requests", mr_body)
        normalized = self._assert_review_scope(
            normalize_review(self.repository["provider"], created)
        )
        try:
            await self._apply_review_label(normalized["id"])
        except Exception as error:
            warning = f"Review created, but label could not be applied: {self._safe_error(error)}"
        self._call_step(
            f"Repository broker opened "
            f"{'PR' if self.repository['provider'] == 'github' else 'MR'} "
            f"{normalized.get('url') or normalized['id']}."
        )
        return {
            **self.public_info(),
            **normalized,
            "reused": False,
            "labelApplied": (not self.label) or (not warning),
            "warning": warning,
        }

    openReview = open_review

    async def _optional_request(self, method, endpoint):
        try:
            return await self._request(method, endpoint)
        except Exception:
            return None

    async def _optional_paged_request(self, endpoint, max_pages=3):
        items = []
        try:
            for page in range(1, max_pages + 1):
                separator = "&" if "?" in endpoint else "?"
                result = await self._request(
                    "GET", f"{endpoint}{separator}page={page}", with_meta=True
                )
                if not result or not isinstance(result.get("data"), list):
                    return {"items": items, "complete": False}
                items.extend(result["data"])
                if not result["hasNext"]:
                    return {"items": items, "complete": True}
            return {"items": items, "complete": False}
        except Exception:
            return {"items": items, "complete": False}

    def _feedback_page(self, review, items, cursor, record_read=True):
        page = feedback_window(items, cursor)
        key = f"{review['provider']}:{review['id']}:{review.get('headSha') or 'unknown'}"
        signature = hashlib.sha256(
            _json.dumps(items, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        record = self._feedback_reads.get(key)
        if not record or record["signature"] != signature:
            record = {
                "signature": signature,
                "total": len(items),
                "nextCursor": 0,
                "complete": False,
            }
            self._feedback_reads[key] = record

        if record_read and len(items) > 0 and page["feedbackCursor"] == record["nextCursor"]:
            if page["nextFeedbackCursor"] is None:
                record["complete"] = True
            else:
                record["nextCursor"] = page["nextFeedbackCursor"]

        feedback_read_complete = len(items) == 0 or record["complete"]
        return {
            **page,
            "feedbackReadComplete": feedback_read_complete,
            "expectedFeedbackCursor": None if feedback_read_complete else record["nextCursor"],
        }

    async def _review_status(self, cursor=0, record_read=True):
        found = await self._find_review()
        if not found:
            return {**self.public_info(), "exists": False}
        api = self._api_path()
        review_id = found["number"] if self.repository["provider"] == "github" else found["iid"]
        if self.repository["provider"] == "github":
            review = await self._request("GET", f"{api}/pulls/{review_id}")
            normalized = self._assert_review_scope(normalize_review("github", review))
            sha = normalized["headSha"]
            check_runs, combined, reviews_page, issue_comments_page, review_comments_page = (
                await asyncio.gather(
                    self._optional_request(
                        "GET",
                        f"{api}/commits/{quote(str(sha), safe='')}/check-runs?per_page=100",
                    ),
                    self._optional_request(
                        "GET",
                        f"{api}/commits/{quote(str(sha), safe='')}/status?per_page=100",
                    ),
                    self._optional_paged_request(f"{api}/pulls/{review_id}/reviews?per_page=100"),
                    self._optional_paged_request(f"{api}/issues/{review_id}/comments?per_page=100"),
                    self._optional_paged_request(f"{api}/pulls/{review_id}/comments?per_page=100"),
                )
            )
            reviews = reviews_page["items"]
            issue_comments = issue_comments_page["items"]
            review_comments = review_comments_page["items"]
            latest_by_user = {}
            for item in _as_list(reviews):
                user = (item.get("user") or {}).get("login") if item else None
                if user:
                    latest_by_user[user] = item
            latest_reviews = list(latest_by_user.values())
            feedback = [
                {
                    "id": str(item["id"]),
                    "type": "review",
                    "state": item.get("state") or None,
                    "author": (item.get("user") or {}).get("login"),
                    "path": None,
                    "line": None,
                    "body": clean_text(item.get("body"), LIMITS["feedbackChars"]),
                    "url": item.get("html_url") or None,
                }
                for item in reviews
                if item and item.get("body")
            ] + [
                {
                    "id": str(item["id"]),
                    "type": "inline_comment" if item.get("path") else "comment",
                    "author": (item.get("user") or {}).get("login"),
                    "path": item.get("path") or None,
                    "line": item.get("line") or item.get("original_line") or None,
                    "body": clean_text(item.get("body"), LIMITS["feedbackChars"]),
                    "url": item.get("html_url") or None,
                }
                for item in [*issue_comments, *review_comments]
                if item and item.get("body")
            ]
            bounded_feedback = bound_feedback(feedback)
            return {
                **normalized,
                "exists": True,
                "checks": status_from_github(check_runs, combined),
                "approvals": len(
                    [item for item in latest_reviews if item.get("state") == "APPROVED"]
                ),
                "changesRequested": len(
                    [item for item in latest_reviews if item.get("state") == "CHANGES_REQUESTED"]
                ),
                "feedbackComplete": (
                    reviews_page["complete"]
                    and issue_comments_page["complete"]
                    and review_comments_page["complete"]
                    and bounded_feedback["complete"]
                ),
                "labelApplied": (not self.label)
                or any(
                    label.lower() == self.label.lower() for label in normalized["labels"]
                ),
                **self._feedback_page(normalized, bounded_feedback["items"], cursor, record_read),
            }

        review = await self._request(
            "GET", f"{api}/merge_requests/{review_id}?include_rebase_in_progress=true"
        )
        normalized = self._assert_review_scope(normalize_review("gitlab", review))
        pipelines_page, discussions_page = await asyncio.gather(
            self._optional_paged_request(f"{api}/merge_requests/{review_id}/pipelines?per_page=100"),
            self._optional_paged_request(f"{api}/merge_requests/{review_id}/discussions?per_page=100"),
        )
        pipelines = pipelines_page["items"]
        discussions = discussions_page["items"]
        feedback = []
        for discussion in _as_list(discussions):
            for note in _as_list(discussion.get("notes")):
                if not note or not note.get("body") or note.get("system"):
                    continue
                feedback.append(
                    {
                        "id": str(discussion["id"]),
                        "noteId": str(note["id"]),
                        "author": (note.get("author") or {}).get("username"),
                        "resolved": bool(note.get("resolved")),
                        "body": clean_text(note.get("body"), LIMITS["feedbackChars"]),
                        "url": note.get("web_url") or None,
                    }
                )
        pipeline_history = _as_list(pipelines)
        head_pipeline = review.get("head_pipeline")
        candidates = [c for c in [head_pipeline, *pipeline_history] if c]
        pipeline = next(
            (item for item in candidates if item.get("sha") == normalized["headSha"]), None
        )
        checks_complete = bool(pipeline) or (
            pipelines_page["complete"] and len(candidates) == 0
        )
        bounded_feedback = bound_feedback(feedback)
        feedback_page = self._feedback_page(
            normalized, bounded_feedback["items"], cursor, record_read
        )
        return {
            **normalized,
            "exists": True,
            "checks": {
                "state": "unknown"
                if not checks_complete
                else (pipeline["status"] if pipeline else "none"),
                "complete": checks_complete,
                "url": (pipeline.get("web_url") or None) if pipeline else None,
                "history": [
                    {
                        "id": item.get("id"),
                        "sha": item.get("sha"),
                        "status": item.get("status"),
                        "url": item.get("web_url") or None,
                    }
                    for item in _as_list(pipelines)[:10]
                ],
            },
            "feedbackComplete": discussions_page["complete"] and bounded_feedback["complete"],
            "labelApplied": (not self.label)
            or any(label.lower() == self.label.lower() for label in normalized["labels"]),
            **feedback_page,
        }

    def review_status(self, cursor=0, **_ignored):
        return self._review_status(cursor=cursor, record_read=True)

    reviewStatus = review_status

    async def merge_review(self):
        status = await self._review_status(cursor=0, record_read=False)
        if not status.get("exists"):
            raise RepositoryBrokerError(
                "No review exists for the scoped branch.", "review_missing"
            )
        if status["state"] not in ("open", "opened"):
            if status["state"] == "merged":
                return {**status, "merged": True, "reused": True}
            raise RepositoryBrokerError("The scoped review is not open.", "review_not_open")
        local_sha = await self._assert_current_branch()
        dirty = await self._workspace_status()
        if dirty:
            raise RepositoryBrokerError(
                "Commit or discard all workspace changes before merging.",
                "workspace_dirty",
            )
        if not status.get("headSha") or status["headSha"] != local_sha:
            raise RepositoryBrokerError(
                "Review head changed or does not match local HEAD; push and review again.",
                "sha_mismatch",
            )
        if status.get("feedbackTotal", 0) > 0 and status.get("feedbackReadComplete") is not True:
            raise RepositoryBrokerError(
                "Read every feedback cursor window in this broker run before merging.",
                "feedback_unread",
            )

        check_state = (status.get("checks") or {}).get("state")
        github_blocked = self.repository["provider"] == "github" and (
            status.get("mergeable") is not True
            or check_state not in ("success", "none")
            or status.get("changesRequested", 0) > 0
            or status.get("feedbackComplete") is not True
            or status.get("labelApplied") is not True
        )
        gitlab_blocked = self.repository["provider"] == "gitlab" and (
            status.get("detailedMergeStatus") != "mergeable"
            or check_state not in ("success", "none")
            or status.get("blockingDiscussionsResolved") is False
            or status.get("feedbackComplete") is not True
            or status.get("labelApplied") is not True
        )
        if github_blocked or gitlab_blocked:
            raise RepositoryBrokerError(
                "Review is not merge-ready; resolve checks, conflicts, approvals, "
                "and discussions first.",
                "review_blocked",
            )

        final_review = await self._review_details(status)
        if final_review["state"] == "merged":
            return {**status, **final_review, "merged": True, "reused": True}
        if final_review["state"] not in ("open", "opened"):
            raise RepositoryBrokerError(
                "The scoped review is no longer open.", "review_not_open"
            )
        if (
            not final_review.get("headSha")
            or final_review["headSha"] != local_sha
            or final_review["headSha"] != status["headSha"]
        ):
            raise RepositoryBrokerError(
                "Review head changed before merge; push and review again.", "sha_mismatch"
            )
        if (
            self.repository["provider"] == "github" and final_review.get("mergeable") is not True
        ) or (
            self.repository["provider"] == "gitlab"
            and (
                final_review.get("detailedMergeStatus") != "mergeable"
                or final_review.get("blockingDiscussionsResolved") is False
            )
        ):
            raise RepositoryBrokerError(
                "Review became unmergeable before the merge request.", "review_blocked"
            )

        api = self._api_path()
        if self.repository["provider"] == "github":
            merged = await self._request(
                "PUT",
                f"{api}/pulls/{final_review['id']}/merge",
                {"sha": final_review["headSha"], "merge_method": "squash"},
            )
            if not merged or merged.get("merged") is not True:
                raise RepositoryBrokerError(
                    one_line(merged.get("message") if isinstance(merged, dict) else None, 500)
                    or "GitHub did not merge the pull request.",
                    "merge_failed",
                )
            return {
                **status,
                "merged": True,
                "mergedSha": merged.get("sha") or None,
                "message": one_line(merged.get("message"), 500),
            }
        merged = await self._request(
            "PUT",
            f"{api}/merge_requests/{final_review['id']}/merge",
            {
                "sha": final_review["headSha"],
                "squash": True,
                "should_remove_source_branch": True,
                "auto_merge": False,
            },
        )
        if not merged or merged.get("state") != "merged":
            raise RepositoryBrokerError(
                one_line(merged.get("merge_error") if isinstance(merged, dict) else None, 500)
                or "GitLab did not merge the merge request.",
                "merge_failed",
            )
        return {
            **status,
            "merged": True,
            "mergedSha": merged.get("merge_commit_sha") or merged.get("squash_commit_sha") or None,
        }

    mergeReview = merge_review

    async def _perform_action(self, input_value):
        action = input_value.get("action") if input_value else None
        if action == "info":
            return self.public_info()
        if action == "fetch":
            return await self.fetch_remote()
        if action == "push":
            return await self.push_branch()
        if action == "open_review":
            return await self.open_review(
                title=input_value.get("title"), body=input_value.get("body", "")
            )
        if action == "review_status":
            return await self.review_status(cursor=input_value.get("cursor", 0))
        if action == "merge_review":
            return await self.merge_review()
        raise RepositoryBrokerError(
            "Unknown repository broker action.", "invalid_action"
        )

    async def execute(self, input_value=None):
        # Serialize all execute() calls per instance (mirrors the JS #queue chain).
        async with self._lock:
            self._assert_active()
            self._calls += 1
            if self._calls > LIMITS["toolCalls"]:
                raise RepositoryBrokerError(
                    "Repository broker call limit reached for this run.", "call_limit"
                )
            return await self._perform_action(input_value or {})

    def create_tool(self):
        # Lazy import so the module works without langchain-core installed.
        from typing import Literal, Optional

        from langchain_core.tools import StructuredTool
        from pydantic import BaseModel, ConfigDict, Field, model_validator

        limits = LIMITS

        class _RepositoryBrokerArgs(BaseModel):
            model_config = ConfigDict(extra="forbid")

            action: Literal[
                "info", "fetch", "push", "open_review", "review_status", "merge_review"
            ]
            title: Optional[str] = Field(default=None, min_length=1, max_length=limits["titleChars"])
            body: Optional[str] = Field(default=None, max_length=limits["bodyChars"])
            cursor: Optional[int] = Field(
                default=None, ge=0, le=limits["feedbackItems"] * limits["toolCalls"]
            )

            @model_validator(mode="after")
            def _refine(self):
                if self.action == "open_review" and not self.title:
                    raise ValueError("title is required for open_review")
                if self.action != "open_review" and (
                    self.title is not None or self.body is not None
                ):
                    raise ValueError("title/body are only valid for open_review")
                if self.action != "review_status" and self.cursor is not None:
                    raise ValueError("cursor is only valid for review_status")
                return self

        async def _run(**kwargs):
            input_value = {k: v for k, v in kwargs.items() if v is not None}
            try:
                value = await self.execute(input_value)
                output = _json.dumps({"ok": True, **value})
                if len(output) > limits["toolOutputChars"]:
                    return _json.dumps(
                        {
                            "ok": False,
                            "code": "output_limit",
                            "error": "Repository broker output exceeded its limit.",
                        }
                    )
                return output
            except Exception as error:
                if is_availability_failure(error):
                    self._availability_error = error
                return _json.dumps(
                    {
                        "ok": False,
                        "error": self._safe_error(error),
                        "code": getattr(error, "code", None),
                    }
                )[: limits["toolOutputChars"]]

        return StructuredTool.from_function(
            coroutine=_run,
            name="repository_broker",
            description=(
                "Perform one credentialed operation against the single repository, "
                "workspace, task branch, and base branch scoped by the server. "
                "Use fetch before syncing, push after committing, open_review after "
                "push, review_status for CI/review feedback, and merge_review only "
                "when ready. When review_status returns nextFeedbackCursor, call it "
                "again with that cursor until every bounded feedback window is read. "
                "merge_review is blocked until those windows have been read in this "
                "broker run and the workspace is clean. You cannot choose a "
                "repository, URL, token, branch, refspec, force flag, or review number."
            ),
            args_schema=_RepositoryBrokerArgs,
        )

    createTool = create_tool

    def dispose(self):
        if self._disposed:
            return
        self._token = ""
        self._disposed = True
        shutil.rmtree(self.staging_dir, ignore_errors=True)
