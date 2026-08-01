"""Agent readiness probes + error classification (port of availability.js).

Two responsibilities:
* Classify arbitrary errors as model- or repository-availability failures so the
  agent orchestrator can pause queued work on a real provider/repo outage
  (``is_model_availability_error`` / ``is_repository_availability_error``) and
  render a stable, nontechnical pause reason (``pause_reason_for`` /
  ``public_availability_message``) that never leaks tokens or raw provider text.
* Actively preflight a selected model or repository before dispatch
  (``probe_model_availability`` / ``probe_repository_availability``) and raise a
  sanitized ``AgentAvailabilityError`` on failure.

HTTP probes go through an injectable ``dependencies["fetch_impl"]`` seam (default
httpx) shaped like the JS ``fetch`` response contract (``.ok`` / ``.status`` /
async ``.json()``). The repository probe resolves ``repo_parts`` lazily from
``ai_fleet.agent.workspace`` (ported in parallel); until that module lands a
faithful local fallback port of ``repoParts`` is used.

Pause-reason dict keys and probe-context keys stay camelCase (UI / stored
contract). Public functions are snake_case.
"""

from __future__ import annotations

import math
import re
import time
from datetime import datetime, timezone
from urllib.parse import quote

from ai_fleet.config import CONFIG
from ai_fleet.agent.model_presets import MODEL_ROLES
from ai_fleet.agent.model_discovery import discover_models

# Roles that may be surfaced on a public pause reason (deployment slots plus the
# purpose roles). Anything else is dropped so the UI never shows a stray value.
KNOWN_PAUSE_ROLES = {"local", "global", *MODEL_ROLES}

PROBE_TIMEOUT_MS = 5000
MODEL_ERROR_CODES = {
    "model_unavailable",
    "model_not_found",
    "runtime_auth_unavailable",
    "runtime_auth_setup_failed",
    "runtime_unavailable",
    "authentication_error",
    "permission_error",
    "rate_limit_error",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENETUNREACH",
    "ETIMEDOUT",
}
REPOSITORY_AVAILABILITY_CODES = {"missing_token", "provider_unavailable"}
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
MODEL_MESSAGE = re.compile(
    r"model[^.]{0,80}(not found|not available|unavailable|not loaded)|"
    r"connection refused|fetch failed|network error|timed?\s*out|unauthorized|"
    r"forbidden|permission denied|quota|rate limit|"
    r"http\s*(?:401|403|404|408|429|5\d\d)\b|"
    r"status(?:\s+code)?\s*[:=]?\s*(?:401|403|404|408|429|5\d\d)\b"
)


class AgentAvailabilityError(Exception):
    def __init__(self, resource, message, status=503, code=None):
        super().__init__(message)
        self.name = "AgentAvailabilityError"
        self.message = message
        self.resource = resource
        self.status = status
        self.code = code if code is not None else f"{resource}_unavailable"


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _attr(obj, key, default=None):
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _js_number(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if s == "":
        return 0.0
    try:
        return float(s)
    except ValueError:
        return float("nan")


def _error_message(error) -> str:
    """JS ``String(error.message || error)``."""
    msg = _attr(error, "message")
    if msg:
        return str(msg)
    return str(error)


def _iso_from_ms(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _strip_trailing_slash(value) -> str:
    return re.sub(r"/$", "", str(value))


async def _default_fetch(url, options=None):
    import httpx

    options = options or {}
    headers = options.get("headers") or {}
    method = options.get("method") or "GET"
    timeout = (options.get("timeout_ms") or PROBE_TIMEOUT_MS) / 1000
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        resp = await client.request(method, url, headers=headers)
    return _FetchResponse(resp)


class _FetchResponse:
    def __init__(self, resp):
        self._resp = resp
        self.status = resp.status_code
        self.ok = 200 <= resp.status_code < 300

    async def json(self):
        return self._resp.json()


_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


def _fallback_repo_parts(repo_url, selected_provider="github"):
    """Local port of workspace.js ``repoParts`` used until the parallel
    ``ai_fleet.agent.workspace`` port lands (see ``_repo_parts``)."""
    s = str(repo_url or "").strip()
    provider = str(selected_provider or "").lower()
    if provider != "github" and provider != "gitlab":
        return None
    expected_host = "gitlab.com" if provider == "gitlab" else "github.com"

    def clean_path(value):
        v = re.sub(r"^/+|/+$", "", str(value or ""))
        return re.sub(r"\.git$", "", v, flags=re.IGNORECASE)

    def from_path(host, value):
        repo_path = clean_path(value)
        segments = [seg for seg in repo_path.split("/") if seg]
        if host != expected_host:
            return None
        if (
            len(segments) < 2
            or (provider == "github" and len(segments) != 2)
            or any(seg in (".", "..") or not _SEGMENT_RE.match(seg) for seg in segments)
        ):
            return None
        name = segments[-1]
        owner = "/".join(segments[:-1])
        return {
            "provider": provider,
            "owner": owner,
            "name": name,
            "fullName": f"{owner}/{name}",
            "https": f"https://{expected_host}/{owner}/{name}.git",
        }

    if re.match(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+(?:\.git)?$", s):
        return from_path(expected_host, s)
    match = re.match(r"^https://(github\.com|gitlab\.com)/(.+)$", s, re.IGNORECASE)
    if match:
        return from_path(match.group(1).lower(), match.group(2))
    match = re.match(r"^git@(github\.com|gitlab\.com):(.+)$", s, re.IGNORECASE)
    if match:
        return from_path(match.group(1).lower(), match.group(2))
    return None


def _repo_parts(repo_ref, provider):
    # Lazy import: workspace.py is ported in parallel and may be absent; prefer
    # its repo_parts when present, otherwise use the local fallback port.
    try:
        from ai_fleet.agent import workspace

        fn = getattr(workspace, "repo_parts", None)
        if callable(fn):
            return fn(repo_ref, provider)
    except Exception:
        pass
    return _fallback_repo_parts(repo_ref, provider)


# --------------------------------------------------------------------------- #
# classification
# --------------------------------------------------------------------------- #
def status_of(error):
    candidates = [
        _attr(error, "status"),
        _attr(error, "statusCode"),
        _attr(_attr(error, "response"), "status"),
    ]
    nums = [_js_number(c) for c in candidates]
    first_finite = next((v for v in nums if math.isfinite(v)), None)
    if first_finite is None:
        return None
    value = int(first_finite) if first_finite == int(first_finite) else first_finite
    return value or None  # JS `|| null`: 0 → None


def public_availability_message(resource, context=None):
    context = context or {}
    if resource == "git":
        provider = "GitLab" if context.get("provider") == "gitlab" else "GitHub"
        return f"{provider} repository access is unavailable. Check the repository and token in Settings, then resume agent jobs."
    p = context.get("provider")
    provider = (
        "LM Studio" if p == "lmstudio"
        else "oMLX" if p == "omlx"
        else "Ollama" if p == "ollama"
        else "Claude" if p == "claude"
        else "Codex" if p == "codex"
        else "Hugging Face" if p == "huggingface"
        else "selected"
    )
    return f"The {provider} model is unavailable. Check the model in Settings, then resume agent jobs."


def pause_reason_for(resource, error, context=None, now=None):
    context = context or {}
    if now is None:
        now = int(time.time() * 1000)
    reason = {
        "code": f"{resource}-unavailable",
        "resource": resource,
        "message": public_availability_message(resource, context),
        "since": _iso_from_ms(now),
    }
    if context.get("taskIdentifier"):
        reason["taskIdentifier"] = str(context["taskIdentifier"])
    if context.get("role") in KNOWN_PAUSE_ROLES:
        reason["role"] = context["role"]
    if context.get("provider"):
        reason["provider"] = str(context["provider"])
    if context.get("model"):
        reason["model"] = str(context["model"])
    return reason


def is_repository_availability_error(error):
    if not error:
        return False
    if _attr(error, "resource") == "git":
        return True
    if _attr(error, "name") != "RepositoryBrokerError":
        return False
    code = _attr(error, "code")
    if code in REPOSITORY_AVAILABILITY_CODES:
        return True
    message = str(_attr(error, "message") or "")
    if code == "provider_error":
        return bool(re.search(r"returned (?:401|403|404|408|429|5\d\d)\b", message)) or bool(REMOTE_GIT_FAILURE.search(message))
    return code == "git_failed" and bool(REMOTE_GIT_FAILURE.search(message))


def is_model_availability_error(error):
    if not error:
        return False
    if _attr(error, "resource") == "model":
        return True
    # Planner/runtime wrappers use 5xx for both provider outages and ordinary
    # invalid output. Inspect the preserved cause before considering their own
    # status so a malformed response does not pause every queued project.
    cause = _attr(error, "cause")
    if cause is not None and cause is not error and is_model_availability_error(cause):
        return True
    name = _attr(error, "name")
    if name == "AgentError" or name == "AgentRuntimeError":
        return _attr(error, "code") in MODEL_ERROR_CODES
    status = status_of(error)
    if status and (status == 401 or status == 403 or status == 404 or status == 408 or status == 429 or status >= 500):
        return True
    if _attr(error, "code") in MODEL_ERROR_CODES:
        return True
    message = _error_message(error).lower()
    return bool(MODEL_MESSAGE.search(message))


def selected_model_exists(selected, available):
    wanted = str(selected or "").strip()
    if not wanted:
        return False

    def normalize(value):
        return re.sub(r":latest$", "", str(value or "").strip(), flags=re.IGNORECASE)

    return any(str(value or "").strip() == wanted or normalize(value) == normalize(wanted) for value in available)


# --------------------------------------------------------------------------- #
# probes
# --------------------------------------------------------------------------- #
def _g(obj, key):
    return obj.get(key) if isinstance(obj, dict) else None


async def probe_model_availability(llm, dependencies=None):
    dependencies = dependencies or {}
    fetch_impl = dependencies.get("fetch_impl") or _default_fetch
    discover_models_impl = dependencies.get("discover_models_impl") or discover_models
    timeout_ms = dependencies.get("timeout_ms") or PROBE_TIMEOUT_MS
    context = {"provider": _g(llm, "provider"), "model": _g(llm, "model")}
    if not llm or not _g(llm, "provider") or not _g(llm, "model"):
        raise AgentAvailabilityError("model", public_availability_message("model", context), 400, "model_not_configured")

    provider = llm.get("provider")
    try:
        if provider in ("ollama", "lmstudio", "omlx"):
            if not callable(fetch_impl) or not llm.get("host"):
                raise Exception("Local model host is not configured.")
            path = "/api/tags" if provider == "ollama" else "/v1/models"
            headers = {"Accept": "application/json"}
            if provider == "omlx" and llm.get("apiKey"):
                headers["Authorization"] = f"Bearer {llm['apiKey']}"
            host = _strip_trailing_slash(llm["host"])
            response = await fetch_impl(f"{host}{path}", {"headers": headers, "signal": None, "timeout_ms": timeout_ms})
            if not response.ok:
                err = Exception("Local model service rejected the readiness check.")
                err.status = response.status
                raise err
            body = await response.json()
            if provider == "ollama":
                raw = body.get("models") if isinstance(body.get("models"), list) else []
                models = [(_g(entry, "name") or _g(entry, "model")) for entry in raw]
            else:
                raw = body.get("data") if isinstance(body.get("data"), list) else []
                models = [_g(entry, "id") for entry in raw]
            if not selected_model_exists(llm["model"], models):
                raise AgentAvailabilityError("model", public_availability_message("model", context), 404, "model_not_found")
            return {"available": True, "provider": provider, "model": llm["model"]}

        if provider in ("codex", "claude"):
            credentials = (
                {"accessToken": llm.get("accessToken"), "accountId": llm.get("accountId")}
                if provider == "codex"
                else {"accessToken": llm.get("accessToken")}
            )
            discovered = await discover_models_impl(
                provider,
                {
                    "backend": llm.get("backend") or CONFIG.OAUTH.backend,
                    "credentials": credentials,
                    "refresh": True,
                    "strict": True,
                    "fetch_impl": fetch_impl,
                },
            )
            model = next((c for c in discovered["models"] if c["id"] == llm["model"]), None)
            if not model or (provider == "codex" and llm.get("backend") == "api" and model.get("source") != "live"):
                raise AgentAvailabilityError("model", public_availability_message("model", context), 404, "model_not_found")
            return {"available": True, "provider": provider, "model": llm["model"]}

        if provider == "huggingface":
            if not callable(fetch_impl) or not llm.get("baseUrl"):
                raise Exception("Hugging Face endpoint is not configured.")
            if not llm.get("apiKey"):
                raise AgentAvailabilityError("model", public_availability_message("model", context), 401, "model_not_configured")
            # Validate token + connectivity against the router. Its model listing
            # is large and may omit routable models, so we do NOT require the
            # configured model to appear — only that the authed call succeeds.
            base = _strip_trailing_slash(llm["baseUrl"])
            response = await fetch_impl(
                f"{base}/models",
                {
                    "headers": {"Accept": "application/json", "Authorization": f"Bearer {llm['apiKey']}"},
                    "signal": None,
                    "timeout_ms": timeout_ms,
                },
            )
            if not response.ok:
                err = Exception("Hugging Face rejected the readiness check.")
                err.status = response.status
                raise err
            return {"available": True, "provider": provider, "model": llm["model"]}

        raise AgentAvailabilityError("model", public_availability_message("model", context), 400, "model_provider_invalid")
    except AgentAvailabilityError:
        raise
    except Exception as error:
        raise AgentAvailabilityError("model", public_availability_message("model", context), status_of(error) or 503)


async def probe_repository_availability(selection, dependencies=None):
    dependencies = dependencies or {}
    fetch_impl = dependencies.get("fetch_impl") or _default_fetch
    timeout_ms = dependencies.get("timeout_ms") or PROBE_TIMEOUT_MS
    provider = "gitlab" if (selection and selection.get("provider") == "gitlab") else "github"
    context = {"provider": provider}
    parts = _repo_parts(selection.get("repoRef") if selection else None, provider)
    if not parts or not (selection and selection.get("token")) or not callable(fetch_impl):
        raise AgentAvailabilityError("git", public_availability_message("git", context), 400, "git_not_configured")

    github = provider == "github"
    if github:
        url = f"https://api.github.com/repos/{quote(parts['owner'], safe='')}/{quote(parts['name'], safe='')}"
    else:
        url = f"https://gitlab.com/api/v4/projects/{quote(parts['fullName'], safe='')}"
    if github:
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {selection['token']}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "tech-symphony-readiness",
        }
    else:
        headers = {"Accept": "application/json", "PRIVATE-TOKEN": selection["token"], "User-Agent": "tech-symphony-readiness"}
    try:
        response = await fetch_impl(url, {"headers": headers, "redirect": "error", "signal": None, "timeout_ms": timeout_ms})
        if not response.ok:
            raise AgentAvailabilityError("git", public_availability_message("git", context), response.status)
        body = await response.json()
        if github and body and body.get("permissions") and body["permissions"].get("push") is False:
            raise AgentAvailabilityError("git", public_availability_message("git", context), 403, "git_write_unavailable")
        if (not github) and body and body.get("permissions"):
            permissions = body["permissions"]
            project_level = _js_number((permissions.get("project_access") or {}).get("access_level")) or 0
            group_level = _js_number((permissions.get("group_access") or {}).get("access_level")) or 0
            if max(project_level, group_level) < 30:
                raise AgentAvailabilityError("git", public_availability_message("git", context), 403, "git_write_unavailable")
        return {"available": True, "provider": provider, "repository": parts["fullName"]}
    except AgentAvailabilityError:
        raise
    except Exception as error:
        raise AgentAvailabilityError("git", public_availability_message("git", context), status_of(error) or 503)
