"""Secret-free health snapshot (port of agent/diagnostics.js).

Builds a diagnostic report that probes the isolated agent services, the local
model runtime, a bounded tail of the shared service log, integration
configuration, and SDK package availability. Credentials are *presence checks
only* — the report never returns or logs secrets.

Port notes:
- JS `require.resolve(pkg)` package detection becomes `importlib.util.find_spec`.
  The JS package names map to Python import names inside `sdk_checks`:
  ``deepagents`` -> ``deepagents``, ``@openai/codex-sdk`` -> ``openai_codex``,
  ``@anthropic-ai/claude-agent-sdk`` -> ``claude_agent_sdk``.
- The Node-only ESM fallback (``ERR_PACKAGE_PATH_NOT_EXPORTED`` manifest probe)
  has no Python equivalent — `find_spec` already reports installed-but-not-loaded
  packages — so it is intentionally dropped.
- The HTTP probe keeps an injectable ``fetch`` seam (dependencies["fetch"]) so
  tests inject a fake; the default path uses httpx with the bounded timeout.
- Output dict keys stay camelCase (``httpStatus``, ``generatedAt`` cross the HTTP
  boundary to the SPA) per the store/API contract.
"""

from __future__ import annotations

import asyncio
import errno as errno_module
import importlib.util
import math
import os
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

import httpx

from ai_fleet.config import CONFIG

DEFAULT_TIMEOUT_MS = 1800
MAX_TIMEOUT_MS = 5000
MAX_LOG_TAIL_BYTES = 64 * 1024


# --- date helpers ----------------------------------------------------------
def _to_datetime(value):
    """Coerce an ISO string / epoch-ms number / datetime into an aware UTC dt."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _iso_ms(dt):
    """Format like JS ``Date#toISOString`` — millisecond precision + ``Z``."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _iso_time(value):
    """`new Date(value || Date.now()).toISOString()`."""
    dt = _to_datetime(value) if value is not None else datetime.now(timezone.utc)
    if dt is None:
        dt = datetime.now(timezone.utc)
    return _iso_ms(dt)


def _attr(obj, key):
    """Read ``key`` from a dict (test seam) or an attribute namespace (CONFIG)."""
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def bounded_timeout(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_MS
    if not math.isfinite(number):
        return DEFAULT_TIMEOUT_MS
    return min(MAX_TIMEOUT_MS, max(250, round(number)))


def configured_token(tokens):
    return bool(isinstance(tokens, dict) and (tokens.get("accessToken") or tokens.get("refreshToken")))


def _valid_http_url(value):
    try:
        parsed = urlsplit(str(value or ""))
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https"):
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if not parsed.hostname:
        return None
    return parsed, port


def endpoint(base, pathname):
    """Sanitize ``base`` to a bare http(s) origin and swap in ``pathname``.

    Drops any userinfo, query, and fragment so a configured URL cannot smuggle
    credentials or a redirect into the diagnostic report.
    """
    valid = _valid_http_url(base)
    if not valid:
        return None
    parsed, port = valid
    host = parsed.hostname or ""
    netloc = f"{host}:{port}" if port else host
    return urlunsplit((parsed.scheme, netloc, pathname, "", ""))


async def probe(url, dependencies=None, options=None):
    dependencies = dependencies or {}
    options = options or {}
    if not url:
        return {"status": "not-configured", "summary": "No valid endpoint is configured."}
    fetch_fn = dependencies.get("fetch")
    timeout_ms = bounded_timeout(dependencies.get("timeoutMs"))
    headers = {"accept": "application/json", **(options.get("headers") or {})}
    try:
        if fetch_fn is not None:
            response = await fetch_fn(url, {"method": "GET", "headers": headers})
            body = getattr(response, "body", None)
            cancel = getattr(body, "cancel", None) if body is not None else None
            if callable(cancel):
                try:
                    await cancel()
                except Exception:
                    pass
            ok = bool(getattr(response, "ok"))
            status = getattr(response, "status", None)
        else:
            async with httpx.AsyncClient(timeout=timeout_ms / 1000) as client:
                resp = await client.get(url, headers=headers)
            ok = resp.is_success
            status = resp.status_code
    except Exception:
        return {"status": "unavailable", "summary": "Endpoint could not be reached within the diagnostic timeout."}
    if ok:
        return {"status": "healthy", "summary": "Endpoint responded successfully.", "details": {"httpStatus": status}}
    return {"status": "attention", "summary": "Endpoint responded with an error status.", "details": {"httpStatus": status}}


def package_available(name, resolver=None):
    """Presence check for an installed package.

    Default resolver uses ``importlib.util.find_spec`` (truthy spec == installed).
    An injectable ``resolver`` seam lets tests supply a fake that returns a path
    (installed) or raises (missing), mirroring the JS ``require.resolve`` seam.
    """
    if resolver is None:
        resolver = lambda n: importlib.util.find_spec(n)  # noqa: E731
    try:
        return bool(resolver(name))
    except Exception:
        return False


def check(id, label, status, summary, action, details=None):
    result = {"id": id, "label": label, "status": status, "summary": summary, "action": action}
    if details and len(details):
        result["details"] = details
    return result


def read_bounded_log(file=None, max_bytes=MAX_LOG_TAIL_BYTES):
    if file is None:
        file = CONFIG.LOG_FILE
    try:
        size = os.stat(file).st_size
        length = min(size, max_bytes)
        with open(file, "rb") as handle:
            handle.seek(max(0, size - length))
            buffer = handle.read(length)
        return {"text": buffer.decode("utf-8", errors="replace"), "bytesRead": length, "exists": True}
    except OSError as error:
        code = errno_module.errorcode.get(error.errno, error.errno)
        return {"text": "", "bytesRead": 0, "exists": False, "code": code}


def summarize_log_tail(result):
    source = result if isinstance(result, dict) else {"text": str(result or ""), "bytesRead": 0, "exists": True}
    if not source.get("exists"):
        return check(
            "service-log", "Service log", "attention",
            "The shared service log is not available yet.",
            "Run a workspace service, then retry diagnostics.",
            {"inspectedBytes": 0},
        )
    lines = [line for line in re.split(r"\r?\n", str(source.get("text") or "")) if line]
    error_lines = sum(1 for line in lines if re.search(r"\]\s+ERROR\s", line, re.IGNORECASE))
    warning_lines = sum(1 for line in lines if re.search(r"\]\s+WARN\s", line, re.IGNORECASE))
    latest_timestamp = None
    for line in reversed(lines):
        match = re.match(r"^\[([^\]]+)\]", line)
        if match:
            latest_timestamp = match.group(1)
            break
    status = "attention" if (error_lines or warning_lines) else "healthy"
    summary = (
        f"The bounded log window contains {error_lines} error and {warning_lines} warning entries."
        if (error_lines or warning_lines)
        else "No warning or error entries were found in the bounded log window."
    )
    action = (
        "No action needed."
        if status == "healthy"
        else "Open Agent activity or Trace analysis to inspect the related run without exposing secrets."
    )
    return check(
        "service-log", "Service log", status, summary, action,
        {
            "inspectedBytes": int(source.get("bytesRead") or 0),
            "errorLines": error_lines,
            "warningLines": warning_lines,
            "latestTimestamp": latest_timestamp,
        },
    )


def integration_checks(settings):
    planning_provider = (
        settings.get("planningProvider")
        if settings.get("planningProvider") in ("linear", "jira", "asana")
        else "linear"
    )
    if planning_provider == "linear":
        planning_configured = bool(settings.get("linearApiKey"))
    elif planning_provider == "jira":
        planning_configured = bool(
            settings.get("jiraBaseUrl") and settings.get("jiraEmail") and settings.get("jiraApiToken")
        )
    else:
        planning_configured = bool(settings.get("asanaWorkspaceId") and settings.get("asanaAccessToken"))

    repository_provider = "gitlab" if settings.get("repositoryProvider") == "gitlab" else "github"
    repository_configured = bool(
        settings.get("repositoryUrl")
        and (settings.get("gitlabToken") if repository_provider == "gitlab" else settings.get("githubToken"))
    )
    tracing_configured = bool(
        settings.get("langsmithTracing") and settings.get("langsmithApiKey") and settings.get("langsmithProject")
    )

    return [
        check(
            "planning-integration", "Project planning",
            "healthy" if planning_configured else "attention",
            f"{planning_provider} is configured." if planning_configured else f"{planning_provider} needs configuration.",
            "No action needed." if planning_configured else "Complete the selected planning connector in Settings.",
            {"provider": planning_provider, "credentialVerified": False},
        ),
        check(
            "repository-integration", "Repository",
            "healthy" if repository_configured else "attention",
            f"{repository_provider} is configured." if repository_configured else f"{repository_provider} needs a repository and token.",
            "No action needed." if repository_configured else "Add the repository and matching access token in Settings.",
            {"provider": repository_provider, "credentialVerified": False},
        ),
        check(
            "langsmith-integration", "Tracing and cost",
            "healthy" if tracing_configured else "attention",
            "LangSmith tracing is configured." if tracing_configured else "LangSmith tracing is not ready.",
            "Use Analytics to verify incoming traces." if tracing_configured else "Enable tracing and add a project and API key in Settings.",
            {"credentialVerified": False},
        ),
    ]


def sdk_checks(settings, resolver=None):
    local_provider = (
        settings.get("localLlmProvider")
        if settings.get("localLlmProvider") in ("ollama", "lmstudio", "omlx")
        else "ollama"
    )
    if local_provider == "lmstudio":
        local_ready = bool(settings.get("lmstudioHost") and settings.get("lmstudioModel"))
    elif local_provider == "omlx":
        local_ready = bool(settings.get("omlxHost") and settings.get("omlxModel"))
    else:
        local_ready = bool(settings.get("ollamaHost") and settings.get("ollamaModel"))
    codex_auth = configured_token(settings.get("codexTokens"))
    claude_auth = configured_token(settings.get("claudeTokens"))
    definitions = [
        {
            "id": "deepagents-sdk", "label": "Deep Agents SDK", "packageName": "deepagents",
            "authReady": local_ready or codex_auth or claude_auth,
            "action": "Configure at least one local or hosted model runtime in Settings.",
        },
        {
            "id": "codex-sdk", "label": "Codex SDK", "packageName": "openai_codex",
            "authReady": codex_auth,
            "action": "Install the Codex SDK and sign in with Codex in Settings.",
        },
        {
            "id": "claude-sdk", "label": "Claude Agent SDK", "packageName": "claude_agent_sdk",
            "authReady": claude_auth,
            "action": "Install the Claude Agent SDK and sign in with Claude in Settings.",
        },
    ]

    checks = []
    for definition in definitions:
        installed = package_available(definition["packageName"], resolver)
        ready = bool(installed and definition["authReady"])
        if ready:
            summary = "Package and runtime credentials are configured."
        elif not installed:
            summary = "SDK package is not installed."
        else:
            summary = "SDK package is installed but runtime credentials are not configured."
        checks.append(
            check(
                definition["id"], definition["label"],
                "healthy" if ready else "attention",
                summary,
                "Run a traced agent call to verify provider access." if ready else definition["action"],
                {"installed": installed, "authConfigured": bool(definition["authReady"]), "credentialVerified": False},
            )
        )
    return checks


async def service_checks(services, dependencies):
    definitions = [
        ("planner-service", "Planner service", endpoint(_attr(services, "plannerUrl"), "/api/agent/status")),
        ("coder-service", "Coder service", endpoint(_attr(services, "coderUrl"), "/api/coder")),
    ]

    async def run(definition):
        id_, label, url = definition
        result = await probe(url, dependencies)
        return check(
            id_, label, result["status"], result["summary"],
            "No action needed." if result["status"] == "healthy" else f"Start or inspect the {label.lower()}.",
            result.get("details"),
        )

    return list(await asyncio.gather(*(run(definition) for definition in definitions)))


async def local_model_check(settings, dependencies):
    provider = (
        settings.get("localLlmProvider")
        if settings.get("localLlmProvider") in ("ollama", "lmstudio", "omlx")
        else "ollama"
    )
    if provider == "lmstudio":
        base, model = settings.get("lmstudioHost"), settings.get("lmstudioModel")
    elif provider == "omlx":
        base, model = settings.get("omlxHost"), settings.get("omlxModel")
    else:
        base, model = settings.get("ollamaHost"), settings.get("ollamaModel")
    url = endpoint(base, "/api/tags" if provider == "ollama" else "/v1/models")
    if not model or not url:
        return check(
            "local-model", "Local model", "attention",
            f"{provider} needs a valid host and model.",
            "Complete the local model configuration in Settings.",
            {"provider": provider, "configured": False},
        )
    headers = (
        {"authorization": f"Bearer {settings.get('omlxApiKey')}"}
        if (provider == "omlx" and settings.get("omlxApiKey"))
        else {}
    )
    result = await probe(url, dependencies, {"headers": headers})
    return check(
        "local-model", "Local model", result["status"],
        f"{provider} is reachable." if result["status"] == "healthy" else result["summary"],
        "Run a local enrichment to verify the selected model."
        if result["status"] == "healthy"
        else f"Start {provider} and verify its host in Settings.",
        {"provider": provider, "configured": True, "credentialVerified": False, **(result.get("details") or {})},
    )


def report_status(checks):
    if any(item["status"] == "unavailable" for item in checks):
        return "degraded"
    if any(item["status"] in ("attention", "not-configured") for item in checks):
        return "attention"
    return "healthy"


async def run_diagnostics(settings=None, dependencies=None):
    """Build a secret-free diagnostic snapshot. Credentials are presence checks only."""
    settings = settings or {}
    dependencies = dependencies or {}
    services = dependencies.get("services") or CONFIG.SERVICES
    resolver = dependencies.get("resolvePackage")
    service_results, model_result = await asyncio.gather(
        service_checks(services, dependencies),
        local_model_check(settings, dependencies),
    )
    read_log_tail = dependencies.get("readLogTail")
    if read_log_tail is not None:
        log_result = await read_log_tail(CONFIG.LOG_FILE, MAX_LOG_TAIL_BYTES)
    else:
        log_result = read_bounded_log(CONFIG.LOG_FILE, MAX_LOG_TAIL_BYTES)
    checks = [
        *service_results,
        model_result,
        summarize_log_tail(log_result),
        *integration_checks(settings),
        *sdk_checks(settings, resolver),
    ]
    return {
        "status": report_status(checks),
        "generatedAt": _iso_time(dependencies.get("now")),
        "note": "Credential readiness is configuration-only; this report never returns or logs secrets.",
        "checks": checks,
    }
