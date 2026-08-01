"""Whitelisted, validated settings patching (port of agent/settings-patch.js).

A single allow-list of NON-SECRET operational settings that may be changed
through the "settings as JSON" editor and the local-model settings tool.
Secrets (API keys, OAuth tokens, connector tokens) are deliberately excluded
here - they keep their dedicated, purpose-built endpoints so a JSON round-trip
(which only ever sees masked values) can never clobber or leak them.

Every accepted key is coerced/validated; unknown or derived fields (e.g.
``hasKey``, ``maskedKey``, ``*Configured``) are silently ignored so the masked
public settings document can be edited and saved back safely.

Note on dict keys: settings keys mirror the browser/store API contract and stay
camelCase (e.g. ``ollamaTemperature``). Only Python function names are snake_case.
"""

from __future__ import annotations

import math
import re
from urllib.parse import urlsplit

from .runtimes import normalize_agent_runtime, normalize_workflow_pattern

ALL_PROVIDERS = ("ollama", "lmstudio", "omlx", "codex", "claude", "huggingface")
LOCAL_PROVIDERS = ("ollama", "lmstudio", "omlx")
PLANNING_PROVIDERS = ("linear", "jira", "asana")
REPOSITORY_PROVIDERS = ("github", "gitlab")
RUNTIME_IDS = ("deepagent", "codex-sdk", "claude-agent-sdk")
WORKFLOW_PATTERN_IDS = ("sequential", "parallel", "evaluator", "supervisor")
CONTEXT_MODES = ("summarize", "trim", "none")
# Upper bound on the LLM stream retry count; matches the clamp in agent/llm.js.
MAX_LLM_STREAM_RETRIES = 5


# ------------------------------ JS coercion helpers --------------------------


def _js_str(value):
    """Mirror JS ``String(v ?? '')`` for the value types settings carry."""
    if value is None:
        return ""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _js_number(value):
    """Mirror JS ``Number(v)``: return a float, or ``None`` for NaN."""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if value is None:
        return 0.0
    text = str(value).strip()
    if text == "":
        return 0.0
    try:
        return float(text)
    except ValueError:
        try:
            if text.lower().startswith(("0x", "0o", "0b")):
                return float(int(text, 0))
        except ValueError:
            pass
        return None


# ------------------------------ coercers ------------------------------
# Each coercer returns {"ok": True, "value": ...} or {"ok": False, "reason": ...}.


def _str(max_=400):
    def coerce(v):
        s = _js_str(v).strip()
        if len(s) > max_:
            return {"ok": False, "reason": f"must be {max_} characters or fewer"}
        return {"ok": True, "value": s}

    return coerce


def _num(min_, max_):
    def coerce(v):
        if v is None or v == "":
            return {"ok": True, "value": None}
        n = _js_number(v)
        if n is None or not math.isfinite(n):
            return {"ok": False, "reason": "must be a number"}
        return {"ok": True, "value": min(max_, max(min_, n))}

    return coerce


def _bool():
    def coerce(v):
        return {"ok": True, "value": bool(v)}

    return coerce


def _int(min_, max_):
    def coerce(v):
        n = _js_number(v)
        if n is None or not math.isfinite(n):
            return {"ok": False, "reason": "must be an integer"}
        rounded = math.floor(n + 0.5)  # JS Math.round semantics (half toward +inf)
        return {"ok": True, "value": min(max_, max(min_, rounded))}

    return coerce


def _one_of(values):
    def coerce(v):
        s = _js_str(v).strip()
        if s not in values:
            return {"ok": False, "reason": f"must be one of: {', '.join(values)}"}
        return {"ok": True, "value": s}

    return coerce


def _http_url():
    def coerce(v):
        raw = _js_str(v).strip()
        if not raw:
            return {"ok": True, "value": ""}
        parsed = urlsplit(raw)
        if not parsed.scheme or not parsed.netloc:
            return {"ok": False, "reason": "must be a valid URL"}
        if parsed.scheme not in ("http", "https"):
            return {"ok": False, "reason": "must be an http(s) URL"}
        try:
            host = parsed.hostname or ""
            port = parsed.port
        except ValueError:
            return {"ok": False, "reason": "must be a valid URL"}
        default_ports = {"http": 80, "https": 443}
        netloc = host
        if port is not None and port != default_ports.get(parsed.scheme):
            netloc = f"{host}:{port}"
        origin = f"{parsed.scheme}://{netloc}"
        path = parsed.path
        tail = "" if path in ("", "/") else re.sub(r"/$", "", path)
        return {"ok": True, "value": origin + tail}

    return coerce


def _runtime_coerce(v):
    try:
        return {"ok": True, "value": normalize_agent_runtime(v, strict=True)}
    except Exception as error:  # AgentRuntimeError
        return {"ok": False, "reason": getattr(error, "message", str(error))}


def _pattern_coerce(v):
    try:
        return {"ok": True, "value": normalize_workflow_pattern(v, strict=True)}
    except Exception as error:
        return {"ok": False, "reason": getattr(error, "message", str(error))}


# ---------------------- per-provider param blocks --------------------- #


def _local_param_keys(p, context_mode=False):
    _map = {
        f"{p}Host": _http_url(),
        f"{p}Model": _str(200),
        f"{p}ContextWindow": _num(0, 100_000_000),
        f"{p}NumTokens": _num(0, 100_000_000),
        f"{p}Temperature": _num(0, 2),
        f"{p}TopP": _num(0, 1),
        f"{p}TopK": _num(0, 100_000),
        f"{p}RepeatPenalty": _num(0, 10),
        f"{p}ReasoningEffort": _str(40),
        f"{p}ReasoningAdapter": _str(40),
        f"{p}JsonMode": _str(40),
    }
    if context_mode:
        _map[f"{p}ContextMode"] = _str(40)
    return _map


def _hosted_param_keys(p, context_mode=False):
    _map = {
        f"{p}Model": _str(200),
        f"{p}ContextWindow": _num(0, 100_000_000),
        f"{p}MaxTokens": _num(0, 100_000_000),
        f"{p}Temperature": _num(0, 2),
        f"{p}ReasoningEffort": _str(40),
        f"{p}ReasoningAdapter": _str(40),
    }
    if context_mode:
        _map[f"{p}ContextMode"] = _one_of(CONTEXT_MODES)
    return _map


# --------------------------- the allow-list --------------------------- #

ALLOWED = {
    # Harness (agent runtime) + workflow pattern
    "agentRuntime": _runtime_coerce,
    "workflowPattern": _pattern_coerce,
    # Retry an LLM stream this many times on a transient/in-stream error. Applies
    # to every provider (0 disables). See CONFIG.LLM_STREAM_RETRIES.
    "llmStreamRetries": _int(0, MAX_LLM_STREAM_RETRIES),
    # Provider slots (legacy) + purpose roles (thinking/execution/testing)
    "llmProvider": _one_of(ALL_PROVIDERS),
    "localLlmProvider": _one_of(LOCAL_PROVIDERS),
    "thinkingLlmProvider": _one_of(ALL_PROVIDERS),
    "executionLlmProvider": _one_of(ALL_PROVIDERS),
    "testingLlmProvider": _one_of(ALL_PROVIDERS),
    "hostedLlmPresetId": _str(80),
    "localLlmPresetId": _str(80),
    "thinkingLlmPresetId": _str(80),
    "executionLlmPresetId": _str(80),
    "testingLlmPresetId": _str(80),
    # Per-provider model/host/parameter blocks
    **_local_param_keys("ollama"),
    **_local_param_keys("lmstudio", context_mode=True),
    **_local_param_keys("omlx", context_mode=True),
    **_hosted_param_keys("codex", context_mode=True),
    **_hosted_param_keys("claude"),
    **_hosted_param_keys("huggingface"),
    "huggingfaceHost": _http_url(),  # hosted, but the router base URL is operator-configurable
    # LangSmith (non-secret only; the API key keeps its dedicated endpoint)
    "langsmithProject": _str(200),
    "langsmithEndpoint": _http_url(),
    "langsmithTracing": _bool(),
    # Planning + repository (non-secret only; tokens keep dedicated endpoints)
    "planningProvider": _one_of(PLANNING_PROVIDERS),
    "repositoryProvider": _one_of(REPOSITORY_PROVIDERS),
    "repositoryUrl": _str(500),
    "jiraBaseUrl": _str(300),
    "jiraEmail": _str(200),
    "asanaWorkspaceId": _str(100),
}

EDITABLE_KEYS = tuple(ALLOWED.keys())


def sanitize_settings_patch(input_):
    """Validate an arbitrary object into a safe settings patch.

    Returns ``{"patch", "applied", "rejected", "ignored"}``.
    """
    source = input_ if isinstance(input_, dict) else {}
    patch = {}
    applied = []
    rejected = []
    ignored = []
    for key, raw in source.items():
        coerce = ALLOWED.get(key)
        if not coerce:
            ignored.append(key)
            continue
        result = coerce(raw)
        if not result["ok"]:
            rejected.append({"key": key, "reason": result["reason"]})
            continue
        patch[key] = result["value"]
        applied.append(key)
    return {"patch": patch, "applied": applied, "rejected": rejected, "ignored": ignored}


def apply_settings_patch(input_):
    """Sanitize then persist to the store. Nothing is written for an empty patch."""
    result = sanitize_settings_patch(input_)
    if result["applied"]:
        # Lazy import avoids a load-time cycle with the store.
        from ai_fleet.store import patch_settings

        patch_settings(result["patch"])
    return result


def snapshot_editable(settings):
    """Pick only the editable, non-secret keys from a full settings object."""
    source = settings if isinstance(settings, dict) else {}
    snapshot = {}
    for key in EDITABLE_KEYS:
        if key in source:
            snapshot[key] = source[key]
    return snapshot


def describe_editable_settings():
    """Compact, human/LLM-readable description of what may be changed."""
    return "\n".join(
        [
            "Editable settings keys (change only what must change):",
            ", ".join(EDITABLE_KEYS),
            "",
            "Enum values:",
            f"- agentRuntime (harness): {' | '.join(RUNTIME_IDS)} "
            "(deepagent=DeepAgent, codex-sdk=Codex, claude-agent-sdk=ClaudeCode)",
            f"- workflowPattern: {' | '.join(WORKFLOW_PATTERN_IDS)}",
            "- llmProvider / thinkingLlmProvider / executionLlmProvider / testingLlmProvider: "
            f"{' | '.join(ALL_PROVIDERS)}",
            f"- localLlmProvider: {' | '.join(LOCAL_PROVIDERS)}",
            f"- planningProvider: {' | '.join(PLANNING_PROVIDERS)}",
            f"- repositoryProvider: {' | '.join(REPOSITORY_PROVIDERS)}",
            f"- lmstudioContextMode / omlxContextMode / codexContextMode: {' | '.join(CONTEXT_MODES)}",
            "- langsmithTracing: true | false",
            "",
            "Numbers: temperature 0-2, topP 0-1; context windows and token limits are integers.",
            f"- llmStreamRetries (all providers): integer 0-{MAX_LLM_STREAM_RETRIES} "
            "(retries on a transient/in-stream LLM error).",
            "Never set secrets, API keys, or tokens here - those are not editable.",
        ]
    )
