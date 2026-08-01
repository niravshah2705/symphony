"""Settings routes (port of services/gateway/src/routes/settings.js).

Mounted by the gateway at /api/settings. Owns the server-side settings document:
Linear key validation, the LLM preset/role selection, per-provider tuning, the
integration connectors, runtime/workflow selection, LangSmith config, and the
JSON settings editor. Secrets are always masked in the public view and never
returned raw.
"""

from __future__ import annotations

import math
import re
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ai_fleet import linear, store, util
from ai_fleet.config import CONFIG
from ai_fleet.util import AppError
from ai_fleet.services.common import json_body
from ai_fleet.agent import model_presets, runtimes, settings_patch, workspace

router = APIRouter()

# Settings keys backing each LLM role. Deployment slots ('local'/'global') stay
# deployment-pinned; purpose roles (thinking/execution/testing) are provider-
# flexible and reuse whichever provider block they name.
ROLE_KEYS = {
    "global": {"provider": "llmProvider", "preset": "hostedLlmPresetId"},
    "local": {"provider": "localLlmProvider", "preset": "localLlmPresetId"},
    "thinking": {"provider": "thinkingLlmProvider", "preset": "thinkingLlmPresetId"},
    "execution": {"provider": "executionLlmProvider", "preset": "executionLlmPresetId"},
    "testing": {"provider": "testingLlmProvider", "preset": "testingLlmPresetId"},
}
LOCAL_PROVIDERS = ["ollama", "lmstudio", "omlx"]
HOSTED_PROVIDERS = ["codex", "claude", "huggingface"]

# Sentinel distinguishing an absent body key (JS ``undefined``) from an explicit
# JSON ``null`` (Python ``None``) — the two drive different clamp fallbacks.
_MISSING = object()


def parse_role(value):
    """Canonicalize a request's role, or None when unrecognized."""
    if value == "local":
        return "local"
    if value == "global" or value == "hosted":
        return "global"
    if model_presets.is_purpose_role(value):
        return value
    return None


def providers_for_role(role):
    """Providers a role may select — purpose roles accept both local and hosted."""
    if role == "local":
        return LOCAL_PROVIDERS
    if role == "global":
        return HOSTED_PROVIDERS
    return [*LOCAL_PROVIDERS, *HOSTED_PROVIDERS]


def _stream_retries(value):
    n = _to_number(value)
    if not math.isfinite(n):
        return CONFIG.LLM_STREAM_RETRIES
    return int(n) if n == int(n) else n


def public_settings():
    """Public settings view — secrets are masked, never returned raw."""
    s = store.get_settings()
    planning_provider = s.get("planningProvider") if s.get("planningProvider") in ("linear", "jira", "asana") else "linear"
    repository_provider = "gitlab" if s.get("repositoryProvider") == "gitlab" else "github"
    if planning_provider == "linear":
        planning_configured = bool(s.get("linearApiKey"))
    elif planning_provider == "jira":
        planning_configured = bool(s.get("jiraBaseUrl") and s.get("jiraEmail") and s.get("jiraApiToken"))
    else:
        planning_configured = bool(s.get("asanaWorkspaceId") and s.get("asanaAccessToken"))
    return {
        "hasKey": bool(s.get("linearApiKey")),
        "maskedKey": util.mask_key(s.get("linearApiKey")),
        "planningProvider": planning_provider,
        "planningConfigured": planning_configured,
        "jiraBaseUrl": s.get("jiraBaseUrl") or "",
        "jiraEmail": s.get("jiraEmail") or "",
        "hasJiraToken": bool(s.get("jiraApiToken")),
        "maskedJiraToken": util.mask_key(s.get("jiraApiToken")),
        "asanaWorkspaceId": s.get("asanaWorkspaceId") or "",
        "hasAsanaToken": bool(s.get("asanaAccessToken")),
        "maskedAsanaToken": util.mask_key(s.get("asanaAccessToken")),
        "repositoryProvider": repository_provider,
        "repositoryUrl": s.get("repositoryUrl") or "",
        "repositoryConfigured": bool(
            s.get("repositoryUrl") and (s.get("gitlabToken") if repository_provider == "gitlab" else s.get("githubToken"))
        ),
        # Deep-agent provider slots. `llmProvider` = GLOBAL (hosted) slot;
        # `localLlmProvider` = LOCAL slot.
        "llmProvider": s.get("llmProvider") or "ollama",
        "localLlmProvider": s.get("localLlmProvider") or "lmstudio",
        "hostedLlmPresetId": s.get("hostedLlmPresetId") or "custom",
        "localLlmPresetId": s.get("localLlmPresetId") or "custom",
        # Purpose-based model roles ("models as tasks").
        "thinkingLlmProvider": s.get("thinkingLlmProvider") or s.get("llmProvider") or "ollama",
        "thinkingLlmPresetId": s.get("thinkingLlmPresetId") or "custom",
        "executionLlmProvider": s.get("executionLlmProvider") or s.get("llmProvider") or "ollama",
        "executionLlmPresetId": s.get("executionLlmPresetId") or "custom",
        "testingLlmProvider": s.get("testingLlmProvider") or s.get("llmProvider") or "ollama",
        "testingLlmPresetId": s.get("testingLlmPresetId") or "custom",
        "ollamaHost": s.get("ollamaHost"),
        "ollamaModel": s.get("ollamaModel"),
        "ollamaContextWindow": s.get("ollamaContextWindow"),
        "ollamaNumTokens": s.get("ollamaNumTokens"),
        "ollamaTemperature": s.get("ollamaTemperature"),
        "ollamaTopP": s.get("ollamaTopP"),
        "ollamaTopK": s.get("ollamaTopK"),
        "ollamaRepeatPenalty": s.get("ollamaRepeatPenalty"),
        "ollamaReasoningEffort": s.get("ollamaReasoningEffort") or "none",
        "ollamaReasoningAdapter": s.get("ollamaReasoningAdapter") or "none",
        "ollamaJsonMode": s.get("ollamaJsonMode") or "json",
        # LM Studio (local, OpenAI-compatible).
        "lmstudioHost": s.get("lmstudioHost"),
        "lmstudioModel": s.get("lmstudioModel"),
        "lmstudioContextWindow": s.get("lmstudioContextWindow"),
        "lmstudioNumTokens": s.get("lmstudioNumTokens"),
        "lmstudioTemperature": s.get("lmstudioTemperature"),
        "lmstudioTopP": s.get("lmstudioTopP"),
        "lmstudioTopK": s.get("lmstudioTopK"),
        "lmstudioRepeatPenalty": s.get("lmstudioRepeatPenalty"),
        "lmstudioReasoningEffort": s.get("lmstudioReasoningEffort") or "none",
        "lmstudioReasoningAdapter": s.get("lmstudioReasoningAdapter") or "none",
        "lmstudioJsonMode": s.get("lmstudioJsonMode") or "text",
        "lmstudioContextMode": s.get("lmstudioContextMode") or "summarize",
        # oMLX (local, OpenAI-compatible). The optional API key is never returned.
        "omlxHost": s.get("omlxHost"),
        "omlxModel": s.get("omlxModel"),
        "omlxContextWindow": s.get("omlxContextWindow"),
        "omlxNumTokens": s.get("omlxNumTokens"),
        "omlxTemperature": s.get("omlxTemperature"),
        "omlxTopP": s.get("omlxTopP"),
        "omlxTopK": s.get("omlxTopK"),
        "omlxRepeatPenalty": s.get("omlxRepeatPenalty"),
        "omlxReasoningEffort": s.get("omlxReasoningEffort") or "none",
        "omlxReasoningAdapter": s.get("omlxReasoningAdapter") or "none",
        "omlxJsonMode": s.get("omlxJsonMode") or "text",
        "omlxContextMode": s.get("omlxContextMode") or "summarize",
        "hasOmlxApiKey": bool(s.get("omlxApiKey")),
        "maskedOmlxApiKey": util.mask_key(s.get("omlxApiKey")),
        # Hosted model values are not secrets; OAuth tokens remain masked elsewhere.
        "codexModel": s.get("codexModel"),
        "codexContextWindow": s.get("codexContextWindow"),
        "codexMaxTokens": s.get("codexMaxTokens"),
        "codexTemperature": s.get("codexTemperature"),
        "codexReasoningEffort": s.get("codexReasoningEffort") or "none",
        "codexReasoningAdapter": s.get("codexReasoningAdapter") or "none",
        "codexContextMode": s.get("codexContextMode") or "trim",
        "claudeModel": s.get("claudeModel"),
        "claudeContextWindow": s.get("claudeContextWindow"),
        "claudeMaxTokens": s.get("claudeMaxTokens"),
        "claudeTemperature": s.get("claudeTemperature"),
        "claudeReasoningEffort": s.get("claudeReasoningEffort") or "none",
        "claudeReasoningAdapter": s.get("claudeReasoningAdapter") or "none",
        # Hugging Face — host/model/params are not secrets; the token is masked.
        "huggingfaceHost": s.get("huggingfaceHost"),
        "huggingfaceModel": s.get("huggingfaceModel"),
        "huggingfaceContextWindow": s.get("huggingfaceContextWindow"),
        "huggingfaceMaxTokens": s.get("huggingfaceMaxTokens"),
        "huggingfaceTemperature": s.get("huggingfaceTemperature"),
        "huggingfaceReasoningEffort": s.get("huggingfaceReasoningEffort") or "none",
        "huggingfaceReasoningAdapter": s.get("huggingfaceReasoningAdapter") or "none",
        "hasHuggingfaceApiKey": bool(s.get("huggingfaceApiKey")),
        "maskedHuggingfaceApiKey": util.mask_key(s.get("huggingfaceApiKey")),
        "hasGithubToken": bool(s.get("githubToken")),
        "maskedGithubToken": util.mask_key(s.get("githubToken")),
        "hasGitlabToken": bool(s.get("gitlabToken")),
        "maskedGitlabToken": util.mask_key(s.get("gitlabToken")),
        "hasLangsmithKey": bool(s.get("langsmithApiKey")),
        "maskedLangsmithKey": util.mask_key(s.get("langsmithApiKey")),
        "langsmithProject": s.get("langsmithProject"),
        "langsmithEndpoint": s.get("langsmithEndpoint"),
        "langsmithTracing": bool(s.get("langsmithTracing")),
        "agentRuntime": runtimes.normalize_agent_runtime(s.get("agentRuntime")),
        "workflowPattern": runtimes.normalize_workflow_pattern(s.get("workflowPattern")),
        # Retry count applied to every provider's LLM stream on a transient error.
        "llmStreamRetries": _stream_retries(s.get("llmStreamRetries")),
    }


# --------------------------- normalizers / clamps ----------------------- #


def _to_number(value):
    """Mirror JS ``Number()``: null/''→0, undefined(sentinel)/non-numeric→NaN."""
    if value is _MISSING:
        return float("nan")
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return 0.0
        try:
            return float(text)
        except ValueError:
            return float("nan")
    return float("nan")


def _round_half_up(n):
    return math.floor(n + 0.5)


def _num_or(value, default):
    """JS ``Number(value) || default`` — NaN or 0 fall back to ``default``."""
    n = _to_number(value)
    return n if (math.isfinite(n) and n != 0) else default


def _origin_with_path(parsed):
    origin = f"{parsed.scheme}://{parsed.netloc}"
    pathname = parsed.path or "/"
    return origin if pathname == "/" else origin + re.sub(r"/$", "", pathname)


def _normalize_host(value, fallback):
    """Validate an operator-supplied local inference host (localhost is intended)."""
    raw = str(value or "").strip()
    if not raw:
        return fallback
    try:
        parsed = urlsplit(raw)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return fallback
        return _origin_with_path(parsed)
    except Exception:
        return fallback


def _normalize_omlx_host(value, fallback):
    """Accept either the oMLX server origin or its documented `/v1` client URL."""
    normalized = _normalize_host(value, fallback)
    return re.sub(r"/v1/?$", "", str(normalized or ""), flags=re.IGNORECASE)


def _normalize_optional_url(value, fallback=""):
    """Optional connector URL. Empty is meaningful (not configured)."""
    raw = str(value if value is not None else "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return fallback
        return _origin_with_path(parsed)
    except Exception:
        return fallback


_REPO_SLUG_RE = re.compile(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+(?:\.git)?$")
_REPO_HTTPS_RE = re.compile(r"^https://(?:github\.com|gitlab\.com)/[A-Za-z0-9_./-]+(?:\.git)?$")
_REPO_SSH_RE = re.compile(r"^git@(?:github\.com|gitlab\.com):[A-Za-z0-9_./-]+(?:\.git)?$")


def _sanitize_repository_url(value, fallback=""):
    """Tokenless repository reference: owner/name or a GitHub/GitLab HTTPS/SSH URL."""
    raw = str(value if value is not None else "").strip()
    if not raw:
        return ""
    if _REPO_SLUG_RE.match(raw) or _REPO_HTTPS_RE.match(raw) or _REPO_SSH_RE.match(raw):
        return raw
    return fallback


def _clamp_int(value, min_, max_, fallback):
    n = _to_number(value)
    if not math.isfinite(n):
        return fallback
    return min(max_, max(min_, _round_half_up(n)))


def _clamp_number(value, min_, max_, fallback):
    if value is None or value == "":
        return None
    n = _to_number(value)
    if not math.isfinite(n):
        return fallback
    return min(max_, max(min_, n))


def _one_of(value, allowed, fallback):
    """Keep ``value`` only if it is one of ``allowed``, else fall back."""
    return value if value in allowed else fallback


def _discovery_profile_from(result, model):
    if isinstance(result, list):
        models = result
    elif isinstance(result, dict) and isinstance(result.get("models"), list):
        models = result["models"]
    else:
        models = []
    return next((profile for profile in models if profile and profile.get("id") == model), None)


async def _selection_preset(provider, model):
    """Resolve only models that are either in the reviewed catalog or live discovery."""
    preset = model_presets.preset_for_model(provider, model)
    # Metered OpenAI has different context/default-effort metadata than the
    # default ChatGPT/Codex backend, so resolve even known models through its
    # backend-specific discovery fallback below.
    if preset and not (provider == "codex" and CONFIG.OAUTH.backend == "api"):
        return preset
    if provider in ("ollama", "lmstudio", "omlx"):
        return model_presets.neutral_local_preset(provider, model)

    # Lazy import keeps the static catalog usable if discovery is temporarily
    # unavailable during startup or an installation upgrade.
    try:
        from ai_fleet.agent import model_discovery as discovery
    except Exception:
        return None
    profile = discovery.get_cached_model(provider, model) if hasattr(discovery, "get_cached_model") else None
    if not profile and hasattr(discovery, "discover_models"):
        result = await discovery.discover_models(provider)
        profile = _discovery_profile_from(result, model)
        if not profile and hasattr(discovery, "get_cached_model"):
            profile = discovery.get_cached_model(provider, model)
    return model_presets.runtime_preset_for_profile(provider, profile) or preset


# ------------------------------- routes --------------------------------- #


# GET /api/settings
@router.get("")
@router.get("/")
async def get_settings():
    return public_settings()


# GET /api/settings/llm-presets — the single server-owned catalog used by the UI.
@router.get("/llm-presets")
async def get_llm_presets():
    return model_presets.public_catalog()


# PUT /api/settings/llm-preset — atomically select a role preset and optionally
# apply safe custom overrides.
@router.put("/llm-preset")
async def put_llm_preset(request: Request):
    b = await json_body(request)
    role = parse_role(b.get("role"))
    if not role:
        raise AppError("Unknown LLM role.", 400)
    keys = ROLE_KEYS[role]
    current = store.get_settings()
    current_provider = current.get(keys["provider"])
    requested_provider = str(b.get("provider") or current_provider or "").strip()
    is_custom = b.get("presetId") == "custom"
    preset = (
        model_presets.custom_preset_for_settings(requested_provider, current)
        if is_custom
        else model_presets.preset_for_role(b.get("presetId"), role)
    )
    # Deployment slots enforce the local/hosted split; purpose roles accept any
    # deployment. A migrated custom slot may keep its provider until a real preset.
    deployment_ok = (
        model_presets.is_purpose_role(role)
        or not preset
        or preset["deployment"] == ("local" if role == "local" else "hosted")
    )
    if (
        not preset
        or (not is_custom and not deployment_ok)
        or (is_custom and requested_provider != current_provider)
    ):
        raise AppError(f"Unknown or incompatible LLM preset for the {role} role.", 400)

    overrides = b.get("overrides") if isinstance(b.get("overrides"), dict) else {}
    if (not is_custom) and ("model" in overrides) and not model_presets.model_matches_preset(preset, overrides.get("model")):
        raise AppError(
            f"Model id is incompatible with the {preset['label']} preset. Select the matching model preset first.",
            400,
        )
    patch = model_presets.settings_patch_for_preset(preset, overrides)
    if preset["provider"] == "ollama" and "host" in overrides:
        patch["ollamaHost"] = _normalize_host(overrides.get("host"), current.get("ollamaHost"))
    if preset["provider"] == "lmstudio" and "host" in overrides:
        patch["lmstudioHost"] = _normalize_host(overrides.get("host"), current.get("lmstudioHost"))
    if preset["provider"] == "omlx":
        if "host" in overrides:
            patch["omlxHost"] = _normalize_omlx_host(overrides.get("host"), current.get("omlxHost") or CONFIG.OMLX.defaultHost)
        if overrides.get("clearApiKey") is True:
            patch["omlxApiKey"] = ""
        elif "apiKey" in overrides and str(overrides.get("apiKey")).strip():
            patch["omlxApiKey"] = str(overrides.get("apiKey")).strip()[:4096]
    if preset["provider"] == "huggingface":
        if "host" in overrides:
            patch["huggingfaceHost"] = _normalize_omlx_host(
                overrides.get("host"), current.get("huggingfaceHost") or CONFIG.HUGGINGFACE.defaultHost
            )
        if overrides.get("clearApiKey") is True:
            patch["huggingfaceApiKey"] = ""
        elif "apiKey" in overrides and str(overrides.get("apiKey")).strip():
            patch["huggingfaceApiKey"] = str(overrides.get("apiKey")).strip()[:4096]
    patch[keys["provider"]] = preset["provider"]
    patch[keys["preset"]] = preset["id"]
    store.patch_settings(patch)
    return public_settings()


# PUT /api/settings/llm-selection — model-driven settings for the LLM slots.
@router.put("/llm-selection")
async def put_llm_selection(request: Request):
    b = await json_body(request)
    role = parse_role(b.get("role"))
    if not role:
        raise AppError("Unknown LLM role.", 400)
    mode = b.get("mode") if b.get("mode") in ("model", "reasoning") else None
    if not mode:
        raise AppError('Mode must be "model" or "reasoning".', 400)

    provider = str(b.get("provider") or "").strip()
    allowed_providers = providers_for_role(role)
    if provider not in allowed_providers:
        raise AppError(f"Provider for the {role} role must be one of: {', '.join(allowed_providers)}.", 400)
    model = model_presets.sanitize_model_id(b.get("model"))
    if not model:
        raise AppError("A valid model id is required.", 400)

    try:
        preset = await _selection_preset(provider, model)
    except Exception:
        raise AppError(f"Could not refresh the {provider} model list. Try again.", 502)
    if not preset:
        raise AppError(
            f'Model "{model}" is not available for {provider}. Refresh the model list and try again.', 400
        )

    if mode == "model":
        patch = model_presets.settings_patch_for_preset(preset, {"model": model})
    else:
        reasoning_effort = str(b.get("reasoningEffort") or "").strip()
        patch = model_presets.settings_patch_for_reasoning(preset, reasoning_effort, model)
        if not patch:
            raise AppError(
                f"Reasoning must be one of: {', '.join(preset['capabilities']['reasoningEfforts'])}.", 400
            )

    preset_id = "custom" if preset["id"] == "custom" or preset["id"].startswith("dynamic-") else preset["id"]
    keys = ROLE_KEYS[role]
    patch[keys["provider"]] = provider
    if mode == "model":
        patch[keys["preset"]] = preset_id
    store.patch_settings(patch)
    return public_settings()


# PUT /api/settings — validate the Linear key against Linear, then persist.
@router.put("")
@router.put("/")
async def put_settings(request: Request):
    b = await json_body(request)
    linear_api_key = (str(b.get("linearApiKey")) if b.get("linearApiKey") else "").strip()
    if not linear_api_key:
        raise AppError("A Linear API key is required.", 400)
    result = await linear.get_viewer(linear_api_key)
    store.set_api_key(linear_api_key)
    return {**public_settings(), "viewer": result["viewer"], "organization": result["organization"]}


# PUT /api/settings/llm — save the local Ollama configuration for the deep agent.
@router.put("/llm")
async def put_llm(request: Request):
    b = await json_body(request)
    current = store.get_settings()
    has_model_override = "ollamaModel" in b
    model = str(b.get("ollamaModel")).strip() if has_model_override else current.get("ollamaModel")
    matched_preset = model_presets.preset_for_model("ollama", model)
    current_preset = model_presets.preset_for_model("ollama", current.get("ollamaModel"))
    model_family_changed = has_model_override and (
        (not current_preset or current_preset["id"] != matched_preset["id"])
        if matched_preset
        else model != current.get("ollamaModel")
    )
    preserved_adapter = (
        current.get("ollamaReasoningAdapter")
        if current.get("ollamaReasoningAdapter") in ("ollama-think-effort", "ollama-think-toggle")
        else "none"
    )
    if matched_preset:
        reasoning_adapter = matched_preset["capabilities"]["reasoningAdapter"]
    elif has_model_override and model != current.get("ollamaModel"):
        reasoning_adapter = "none"
    else:
        reasoning_adapter = preserved_adapter
    if matched_preset:
        reasoning_efforts = matched_preset["capabilities"]["reasoningEfforts"]
    elif reasoning_adapter == "ollama-think-effort":
        reasoning_efforts = ["low", "medium", "high"]
    elif reasoning_adapter == "ollama-think-toggle":
        reasoning_efforts = ["none", "medium"]
    else:
        reasoning_efforts = ["none"]
    if not model_family_changed and current.get("ollamaReasoningEffort") in reasoning_efforts:
        default_effort = current.get("ollamaReasoningEffort")
    elif matched_preset:
        default_effort = matched_preset["parameters"]["reasoning"]["effort"]
    else:
        default_effort = reasoning_efforts[0]
    sampling_defaults = matched_preset["parameters"] if (matched_preset and model_family_changed) else None
    context_window = _clamp_int(b.get("ollamaContextWindow", _MISSING), 512, 262144, current.get("ollamaContextWindow"))
    max_output_tokens = min(128000, context_window)
    patch = {
        "ollamaHost": _normalize_host(b.get("ollamaHost"), current.get("ollamaHost")),
        "ollamaContextWindow": context_window,
        "ollamaNumTokens": _clamp_int(
            b.get("ollamaNumTokens", _MISSING),
            128,
            max_output_tokens,
            min(_num_or(current.get("ollamaNumTokens"), 8192), max_output_tokens),
        ),
        "ollamaTemperature": _clamp_number(
            b.get("ollamaTemperature", _MISSING),
            0,
            2,
            sampling_defaults["temperature"] if sampling_defaults else (current.get("ollamaTemperature") if current.get("ollamaTemperature") is not None else 0),
        ),
        "ollamaTopP": _clamp_number(
            b.get("ollamaTopP", _MISSING),
            0,
            1,
            sampling_defaults["topP"] if sampling_defaults else current.get("ollamaTopP"),
        ),
        "ollamaTopK": None
        if b.get("ollamaTopK", _MISSING) is None
        else _clamp_int(
            b.get("ollamaTopK", _MISSING),
            1,
            1000,
            sampling_defaults["topK"] if sampling_defaults else current.get("ollamaTopK"),
        ),
        "ollamaRepeatPenalty": _clamp_number(
            b.get("ollamaRepeatPenalty", _MISSING),
            0,
            2,
            sampling_defaults["repeatPenalty"] if sampling_defaults else current.get("ollamaRepeatPenalty"),
        ),
        "ollamaReasoningEffort": _one_of(b.get("ollamaReasoningEffort", _MISSING), reasoning_efforts, default_effort),
        "ollamaReasoningAdapter": reasoning_adapter,
        "ollamaJsonMode": _one_of(b.get("ollamaJsonMode", _MISSING), CONFIG.OLLAMA_JSON_MODES, current.get("ollamaJsonMode") or "json"),
    }
    if has_model_override:
        patch["ollamaModel"] = model
    if current.get("localLlmProvider") == "ollama":
        patch["localLlmPresetId"] = "custom"
    if current.get("llmProvider") == "ollama":
        patch["hostedLlmPresetId"] = "custom"
    store.patch_settings(patch)
    return public_settings()


# PUT /api/settings/lmstudio — save the local LM Studio configuration.
@router.put("/lmstudio")
async def put_lmstudio(request: Request):
    b = await json_body(request)
    current = store.get_settings()
    has_model_override = "lmstudioModel" in b
    model = str(b.get("lmstudioModel")).strip() if has_model_override else current.get("lmstudioModel")
    matched_preset = model_presets.preset_for_model("lmstudio", model)
    current_preset = model_presets.preset_for_model("lmstudio", current.get("lmstudioModel"))
    model_family_changed = has_model_override and (
        (not current_preset or current_preset["id"] != matched_preset["id"])
        if matched_preset
        else model != current.get("lmstudioModel")
    )
    requested_adapter = _one_of(
        b.get("lmstudioReasoningAdapter", _MISSING),
        ["none", "openai-compatible"],
        current.get("lmstudioReasoningAdapter") or "none",
    )
    if matched_preset:
        reasoning_adapter = matched_preset["capabilities"]["reasoningAdapter"]
    elif has_model_override and model != current.get("lmstudioModel"):
        reasoning_adapter = "none"
    else:
        reasoning_adapter = requested_adapter
    if matched_preset:
        reasoning_efforts = matched_preset["capabilities"]["reasoningEfforts"]
    elif reasoning_adapter == "openai-compatible":
        reasoning_efforts = ["none", "low", "medium", "high"]
    else:
        reasoning_efforts = ["none"]
    if not model_family_changed and current.get("lmstudioReasoningEffort") in reasoning_efforts:
        default_effort = current.get("lmstudioReasoningEffort")
    elif matched_preset:
        default_effort = matched_preset["parameters"]["reasoning"]["effort"]
    else:
        default_effort = reasoning_efforts[0]
    sampling_defaults = matched_preset["parameters"] if (matched_preset and model_family_changed) else None
    context_window = _clamp_int(b.get("lmstudioContextWindow", _MISSING), 512, 262144, current.get("lmstudioContextWindow"))
    max_output_tokens = min(128000, max(256, math.floor(context_window / 2)))
    patch = {
        "lmstudioHost": _normalize_host(b.get("lmstudioHost"), current.get("lmstudioHost")),
        "lmstudioContextWindow": context_window,
        "lmstudioNumTokens": _clamp_int(
            b.get("lmstudioNumTokens", _MISSING),
            256,
            max_output_tokens,
            min(_num_or(current.get("lmstudioNumTokens"), 4096), max_output_tokens),
        ),
        "lmstudioTemperature": _clamp_number(
            b.get("lmstudioTemperature", _MISSING),
            0,
            2,
            sampling_defaults["temperature"] if sampling_defaults else (current.get("lmstudioTemperature") if current.get("lmstudioTemperature") is not None else 0),
        ),
        "lmstudioTopP": _clamp_number(
            b.get("lmstudioTopP", _MISSING),
            0,
            1,
            sampling_defaults["topP"] if sampling_defaults else current.get("lmstudioTopP"),
        ),
        "lmstudioTopK": None
        if b.get("lmstudioTopK", _MISSING) is None
        else _clamp_int(
            b.get("lmstudioTopK", _MISSING),
            1,
            1000,
            sampling_defaults["topK"] if sampling_defaults else current.get("lmstudioTopK"),
        ),
        "lmstudioRepeatPenalty": _clamp_number(
            b.get("lmstudioRepeatPenalty", _MISSING),
            0,
            2,
            sampling_defaults["repeatPenalty"] if sampling_defaults else current.get("lmstudioRepeatPenalty"),
        ),
        "lmstudioReasoningEffort": _one_of(b.get("lmstudioReasoningEffort", _MISSING), reasoning_efforts, default_effort),
        "lmstudioReasoningAdapter": reasoning_adapter,
        "lmstudioJsonMode": _one_of(b.get("lmstudioJsonMode", _MISSING), CONFIG.LMSTUDIO_JSON_MODES, current.get("lmstudioJsonMode") or "text"),
        "lmstudioContextMode": _one_of(b.get("lmstudioContextMode", _MISSING), CONFIG.LMSTUDIO_CONTEXT_MODES, current.get("lmstudioContextMode") or "summarize"),
    }
    if has_model_override:
        patch["lmstudioModel"] = model
    if current.get("localLlmProvider") == "lmstudio":
        patch["localLlmPresetId"] = "custom"
    if current.get("llmProvider") == "lmstudio":
        patch["hostedLlmPresetId"] = "custom"
    store.patch_settings(patch)
    return public_settings()


# PUT /api/settings/provider — choose a deep-agent LLM provider for a role.
@router.put("/provider")
async def put_provider(request: Request):
    b = await json_body(request)
    role = parse_role(b.get("role")) or "global"
    requested = str(b.get("llmProvider") or b.get("provider") or "").strip()
    allowed = providers_for_role(role)
    if requested not in allowed:
        raise AppError(f"Provider for the {role} role must be one of: {', '.join(allowed)}.", 400)
    keys = ROLE_KEYS[role]
    store.patch_settings({keys["provider"]: requested, keys["preset"]: "custom"})
    return public_settings()


# PUT /api/settings/github — save the GitHub token for the code-writer's git ops.
@router.put("/github")
async def put_github(request: Request):
    b = await json_body(request)
    if "githubToken" in b:
        store.patch_settings({"githubToken": str(b.get("githubToken")).strip()})
    return public_settings()


# PUT /api/settings/integrations — configure work-management + repository connectors.
@router.put("/integrations")
async def put_integrations(request: Request):
    b = await json_body(request)
    current = store.get_settings()
    patch = {}

    if "planningProvider" in b:
        planning_provider = str(b.get("planningProvider")).lower()
        if planning_provider not in ("linear", "jira", "asana"):
            raise AppError("Planning provider must be Linear, Jira, or Asana.", 400)
        patch["planningProvider"] = planning_provider
    if "repositoryProvider" in b:
        repository_provider = str(b.get("repositoryProvider")).lower()
        if repository_provider not in ("github", "gitlab"):
            raise AppError("Repository provider must be GitHub or GitLab.", 400)
        patch["repositoryProvider"] = repository_provider
    if "repositoryUrl" in b:
        repository_url = _sanitize_repository_url(b.get("repositoryUrl"), "")
        if str(b.get("repositoryUrl") or "").strip() and not repository_url:
            raise AppError("Repository must be owner/name or a github.com/gitlab.com Git URL.", 400)
        patch["repositoryUrl"] = repository_url

    # Validate the effective pair, including provider-only API updates.
    effective_repository_provider = patch.get("repositoryProvider") or current.get("repositoryProvider") or "github"
    effective_repository_url = patch["repositoryUrl"] if "repositoryUrl" in patch else current.get("repositoryUrl")
    if effective_repository_url and not workspace.repo_parts(effective_repository_url, effective_repository_provider):
        label = "GitLab" if effective_repository_provider == "gitlab" else "GitHub"
        raise AppError(f"Repository URL must match the selected {label} host.", 400)

    if "jiraBaseUrl" in b:
        jira_base_url = _normalize_optional_url(b.get("jiraBaseUrl"), "")
        if str(b.get("jiraBaseUrl") or "").strip() and not jira_base_url:
            raise AppError("Jira site must be a valid http(s) URL.", 400)
        patch["jiraBaseUrl"] = jira_base_url
    if "jiraEmail" in b:
        patch["jiraEmail"] = str(b.get("jiraEmail") or "").strip()[:320]
    if "asanaWorkspaceId" in b:
        patch["asanaWorkspaceId"] = str(b.get("asanaWorkspaceId") or "").strip()[:160]

    for body_key, setting_key, clear_key in (
        ("githubToken", "githubToken", "clearGithubToken"),
        ("gitlabToken", "gitlabToken", "clearGitlabToken"),
        ("jiraApiToken", "jiraApiToken", "clearJiraToken"),
        ("asanaAccessToken", "asanaAccessToken", "clearAsanaToken"),
    ):
        if b.get(clear_key) is True:
            patch[setting_key] = ""
        elif body_key in b and str(b.get(body_key)).strip():
            patch[setting_key] = str(b.get(body_key)).strip()

    store.patch_settings(patch)
    return public_settings()


# PUT /api/settings/runtime — select the SDK runtime + bounded workflow pattern.
@router.put("/runtime")
async def put_runtime(request: Request):
    b = await json_body(request)
    patch = {}
    if "agentRuntime" in b:
        patch["agentRuntime"] = runtimes.normalize_agent_runtime(b.get("agentRuntime"), strict=True)
    if "workflowPattern" in b:
        patch["workflowPattern"] = runtimes.normalize_workflow_pattern(b.get("workflowPattern"), strict=True)
    if not patch:
        raise AppError("agentRuntime or workflowPattern is required.", 400)
    store.patch_settings(patch)
    return public_settings()


# PUT /api/settings/langsmith — save LangSmith tracing configuration.
@router.put("/langsmith")
async def put_langsmith(request: Request):
    b = await json_body(request)
    patch = {}
    if "langsmithApiKey" in b:
        patch["langsmithApiKey"] = str(b.get("langsmithApiKey")).strip()
    if "langsmithProject" in b and str(b.get("langsmithProject")).strip():
        patch["langsmithProject"] = str(b.get("langsmithProject")).strip()
    if "langsmithEndpoint" in b and str(b.get("langsmithEndpoint")).strip():
        patch["langsmithEndpoint"] = str(b.get("langsmithEndpoint")).strip()
    if "langsmithTracing" in b:
        patch["langsmithTracing"] = bool(b.get("langsmithTracing"))
    store.patch_settings(patch)
    return public_settings()


# GET /api/settings/json — editable, non-secret settings as a JSON document.
@router.get("/json")
async def get_settings_json():
    return {"settings": settings_patch.snapshot_editable(store.get_settings()), "schema": settings_patch.describe_editable_settings()}


# PUT /api/settings/json — apply a JSON settings document (non-secret keys only).
@router.put("/json")
async def put_settings_json(request: Request):
    body = await json_body(request)
    input_ = body["settings"] if isinstance(body.get("settings"), dict) and body.get("settings") else body
    result = settings_patch.sanitize_settings_patch(input_)
    if not result["applied"]:
        detail = (
            " " + "; ".join(f"{r['key']}: {r['reason']}" for r in result["rejected"])
            if result["rejected"]
            else ""
        )
        return JSONResponse(
            status_code=400,
            content={"error": f"No valid settings to apply.{detail}", "rejected": result["rejected"], "ignored": result["ignored"]},
        )
    store.patch_settings(result["patch"])
    return {"settings": public_settings(), "applied": result["applied"], "rejected": result["rejected"], "ignored": result["ignored"]}


# GET /api/settings/validate — test the currently stored Linear key.
@router.get("/validate")
async def get_validate():
    key = store.get_api_key()
    if not key:
        raise AppError("No API key configured.", 400)
    result = await linear.get_viewer(key)
    return {"ok": True, "viewer": result["viewer"], "organization": result["organization"]}


# DELETE /api/settings — clear the Linear key.
@router.delete("")
@router.delete("/")
async def delete_settings():
    store.set_api_key("")
    return public_settings()
