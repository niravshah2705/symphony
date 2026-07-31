"""Preset catalog + settings materializer (port of agent/model-presets.js).

Loads and strictly validates the JSON LLM preset catalog, then materializes
presets into the flat per-provider settings schema. No network/crypto. Central
to model/param normalization. Preset objects and settings dicts keep camelCase
keys (external contract); functions are snake_case.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

catalog = json.loads((Path(__file__).parent / "llm-presets.json").read_text(encoding="utf-8"))

PROVIDER_DEPLOYMENT = {
    "ollama": "local",
    "lmstudio": "local",
    "omlx": "local",
    "codex": "hosted",
    "claude": "hosted",
    "huggingface": "hosted",
}
ROLE_DEPLOYMENT = {"local": "local", "global": "hosted"}

# Purpose-based model roles ("models as tasks").
MODEL_ROLES = ["thinking", "execution", "testing"]
MODEL_ROLE_META = {
    "thinking": {"label": "Thinking", "description": "Task planning models (used by the planner)."},
    "execution": {"label": "Execution", "description": "Coder models (used by the code-writer)."},
    "testing": {"label": "Testing", "description": "Tool-calling models (reserved; not used yet)."},
}


def is_purpose_role(role) -> bool:
    return role in MODEL_ROLES


REASONING_ADAPTERS = {
    "none",
    "ollama-think-toggle",
    "ollama-think-effort",
    "openai-compatible",
    "omlx-template-effort",
    "openai",
    "anthropic-adaptive",
    "anthropic-effort",
}
REASONING_EFFORTS = {"none", "low", "medium", "high", "xhigh", "max", "ultra"}
JSON_MODES = {
    "ollama": {"json", "text"},
    "lmstudio": {"text", "json_object", "json_schema"},
    "omlx": {"text", "json_object", "json_schema"},
}
CONTEXT_MODES = {"summarize", "trim", "none"}

_UNDEF = object()  # distinguishes JS `undefined` (absent) from `null` (None)


def _assert(condition, message):
    if not condition:
        raise ValueError(f"Invalid LLM preset catalog: {message}")


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_finite_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _to_number(value) -> float:
    """Replicate JS Number(): undefined→NaN, null/''→0/0, bool→1/0."""
    if value is _UNDEF:
        return float("nan")
    if value is None:
        return 0.0
    if value is True:
        return 1.0
    if value is False:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if s == "":
        return 0.0
    try:
        return float(s)
    except ValueError:
        return float("nan")


def _round_half_up(n: float) -> int:
    return math.floor(n + 0.5)


def _nn(value, default):
    """JS nullish coalescing ``value ?? default`` (undefined/null → default)."""
    return default if value is None or value is _UNDEF else value


def validate_catalog(value):
    _assert(value and _is_int(value.get("version")) and value["version"] > 0, "version must be a positive integer")
    _assert(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value.get("updatedAt") or ""), "updatedAt must be YYYY-MM-DD")
    _assert(value.get("defaults") and isinstance(value["defaults"], dict), "defaults are required")
    _assert(value.get("reasoningEfforts") and isinstance(value["reasoningEfforts"], dict), "reasoning effort definitions are required")
    for effort in REASONING_EFFORTS:
        definition = value["reasoningEfforts"].get(effort)
        _assert(definition and isinstance(definition.get("label"), str) and definition["label"].strip(), f"{effort}: reasoning label is required")
        _assert(isinstance(definition.get("description"), str) and definition["description"].strip(), f"{effort}: reasoning description is required")
    _assert(isinstance(value.get("presets"), list) and len(value["presets"]) > 0, "presets must be a non-empty array")

    ids = set()
    for preset in value["presets"]:
        _assert(preset and isinstance(preset, dict), "each preset must be an object")
        _assert(re.fullmatch(r"[a-z0-9][a-z0-9-]{2,80}", preset.get("id") or ""), f"invalid id \"{preset.get('id') or ''}\"")
        _assert(preset["id"] not in ids, f"duplicate id \"{preset['id']}\"")
        ids.add(preset["id"])
        _assert(isinstance(preset.get("label"), str) and preset["label"].strip(), f"{preset['id']}: label is required")
        _assert(PROVIDER_DEPLOYMENT.get(preset.get("provider")), f"{preset['id']}: unsupported provider")
        _assert(preset.get("deployment") == PROVIDER_DEPLOYMENT[preset["provider"]], f"{preset['id']}: provider/deployment mismatch")
        _assert(isinstance(preset.get("model"), str) and preset["model"].strip(), f"{preset['id']}: model is required")
        _assert(re.match(r"https://", preset.get("sourceUrl") or ""), f"{preset['id']}: sourceUrl must be HTTPS")
        _assert(isinstance(preset.get("modelPatterns"), list), f"{preset['id']}: modelPatterns must be an array")
        _assert(all(isinstance(p, str) and p.strip() for p in preset["modelPatterns"]), f"{preset['id']}: invalid model pattern")
        _assert(isinstance(preset.get("recommended"), bool), f"{preset['id']}: recommended must be boolean")
        _assert(isinstance(preset.get("description"), str) and preset["description"].strip(), f"{preset['id']}: description is required")
        _assert(isinstance(preset.get("requirements"), str) and preset["requirements"].strip(), f"{preset['id']}: requirements are required")

        limits = preset.get("limits") or {}
        request_limits = preset.get("requestLimits") or {}
        params = preset.get("parameters") or {}
        caps = preset.get("capabilities") or {}
        _assert(_is_int(limits.get("contextWindow")) and limits["contextWindow"] >= 512, f"{preset['id']}: invalid context limit")
        _assert(_is_int(limits.get("maxOutputTokens")) and limits["maxOutputTokens"] >= 128, f"{preset['id']}: invalid output limit")
        _assert(limits["maxOutputTokens"] <= limits["contextWindow"], f"{preset['id']}: output limit exceeds context limit")
        output_fraction = request_limits.get("maxOutputContextFraction")
        _assert(output_fraction is None or (_is_finite_number(output_fraction) and 0 < output_fraction <= 1), f"{preset['id']}: invalid output/context fraction")
        _assert((output_fraction is not None) if preset["deployment"] == "local" else (output_fraction is None), f"{preset['id']}: output/context fraction must match deployment")
        _assert(_is_int(params.get("contextWindow")) and params["contextWindow"] >= 512, f"{preset['id']}: invalid context default")
        _assert(params["contextWindow"] <= limits["contextWindow"], f"{preset['id']}: context default exceeds limit")
        _assert(_is_int(params.get("maxOutputTokens")) and params["maxOutputTokens"] >= 128, f"{preset['id']}: invalid output default")
        _assert(params["maxOutputTokens"] <= limits["maxOutputTokens"], f"{preset['id']}: output default exceeds limit")
        _assert(params["maxOutputTokens"] <= params["contextWindow"], f"{preset['id']}: output default exceeds context default")
        if _is_finite_number(output_fraction):
            _assert(params["maxOutputTokens"] <= math.floor(params["contextWindow"] * output_fraction), f"{preset['id']}: output default exceeds effective context rule")
        _assert(params.get("temperature") is None or (_is_finite_number(params["temperature"]) and 0 <= params["temperature"] <= 2), f"{preset['id']}: invalid temperature")
        _assert(params.get("topP") is None or (_is_finite_number(params["topP"]) and 0 <= params["topP"] <= 1), f"{preset['id']}: invalid topP")
        _assert(params.get("topK") is None or (_is_int(params["topK"]) and 1 <= params["topK"] <= 1000), f"{preset['id']}: invalid topK")
        _assert(params.get("repeatPenalty") is None or (_is_finite_number(params["repeatPenalty"]) and 0 <= params["repeatPenalty"] <= 2), f"{preset['id']}: invalid repeatPenalty")
        _assert(caps.get("temperature") or params.get("temperature") is None, f"{preset['id']}: unsupported temperature must be null")
        for capability in ("toolCalling", "structuredOutput", "temperature", "contextWindowConfigurable"):
            _assert(isinstance(caps.get(capability), bool), f"{preset['id']}: {capability} must be boolean")
        _assert(caps.get("reasoningAdapter") in REASONING_ADAPTERS, f"{preset['id']}: invalid reasoning adapter")
        _assert(isinstance(caps.get("reasoningEfforts"), list) and len(caps["reasoningEfforts"]) > 0, f"{preset['id']}: reasoning efforts required")
        for effort in caps["reasoningEfforts"]:
            _assert(effort in REASONING_EFFORTS, f"{preset['id']}: invalid reasoning effort")
        effort = (params.get("reasoning") or {}).get("effort")
        _assert(effort in caps["reasoningEfforts"], f"{preset['id']}: default reasoning effort is unsupported")
        if caps["reasoningAdapter"] == "none":
            _assert(len(caps["reasoningEfforts"]) == 1 and effort == "none", f"{preset['id']}: no-adapter reasoning must be disabled")
            _assert(params["reasoning"].get("parameter") is None, f"{preset['id']}: no-adapter reasoning parameter must be null")
        else:
            _assert(isinstance(params["reasoning"].get("parameter"), str) and params["reasoning"]["parameter"], f"{preset['id']}: reasoning parameter is required")
        if preset["deployment"] == "local":
            _assert(params.get("jsonMode") in JSON_MODES[preset["provider"]], f"{preset['id']}: invalid JSON mode")
        else:
            _assert(params.get("jsonMode") is None, f"{preset['id']}: hosted JSON mode must be null")
        if preset["provider"] in ("lmstudio", "omlx"):
            _assert(params.get("contextMode") in CONTEXT_MODES, f"{preset['id']}: invalid context mode")
        else:
            _assert(params.get("contextMode") is None, f"{preset['id']}: context mode only applies to OpenAI-compatible local providers")

    for deployment in ("local", "hosted"):
        preset = next((item for item in value["presets"] if item["id"] == value["defaults"].get(deployment)), None)
        _assert(preset and preset["deployment"] == deployment, f"default {deployment} preset is missing or mismatched")
    for provider in PROVIDER_DEPLOYMENT:
        provider_presets = [p for p in value["presets"] if p["provider"] == provider]
        _assert(len(provider_presets) > 0, f"provider {provider} has no presets")
        _assert(len([p for p in provider_presets if p["recommended"]]) == 1, f"provider {provider} needs one recommended preset")
    return value


validate_catalog(catalog)

_by_id = {preset["id"]: preset for preset in catalog["presets"]}


def get_preset(id):
    return _by_id.get(str(id or "")) or None


def presets_for_role(role):
    if is_purpose_role(role):
        return catalog["presets"]
    deployment = ROLE_DEPLOYMENT.get(role)
    return [p for p in catalog["presets"] if p["deployment"] == deployment] if deployment else []


def preset_for_role(id, role):
    preset = get_preset(id)
    if not preset:
        return None
    if is_purpose_role(role):
        return preset
    return preset if preset["deployment"] == ROLE_DEPLOYMENT.get(role) else None


def preset_for_model(provider, model):
    return next((p for p in catalog["presets"] if p["provider"] == provider and model_matches_preset(p, model)), None)


def _clamp_int(value, min_, max_, fallback):
    n = _to_number(value)
    if not math.isfinite(n):
        return fallback
    return min(max_, max(min_, _round_half_up(n)))


def _clamp_number(value, min_, max_, fallback):
    n = _to_number(value)
    if not math.isfinite(n):
        return fallback
    return min(max_, max(min_, n))


def _clamp_temperature(value, fallback):
    if value is None or value == "":
        return None
    n = _to_number(value)
    if not math.isfinite(n):
        return fallback
    return min(2, max(0, n))


_CLEAN_MODEL_RE = re.compile(r"^[A-Za-z0-9_.:\-/]{1,200}$")


def _clean_model(value, fallback):
    if value is _UNDEF:
        return fallback
    model = str(value or "").strip()
    if not _CLEAN_MODEL_RE.fullmatch(model) or "//" in model:
        return fallback
    return model


def _normalized_model(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def model_matches_preset(preset, value):
    model = _clean_model(value, "")
    if not model:
        return False
    if preset["id"] == "custom":
        return True
    actual = _normalized_model(model)
    patterns = [p for p in (_normalized_model(x) for x in [preset["model"], *(preset.get("modelPatterns") or [])]) if p]
    if preset["deployment"] == "hosted":
        return actual in patterns
    return any(pattern in actual for pattern in patterns)


def normalize_parameters(preset, overrides=None):
    if overrides is None:
        overrides = {}
    defaults = preset["parameters"]
    caps = preset["capabilities"]
    limits = preset["limits"]

    def ov(key):
        return overrides.get(key, _UNDEF)

    effort = ov("reasoningEffort") if ov("reasoningEffort") in caps["reasoningEfforts"] else defaults["reasoning"]["effort"]
    temperature = _clamp_temperature(ov("temperature"), defaults["temperature"]) if caps["temperature"] else None
    context_window = (
        _clamp_int(ov("contextWindow"), 512, limits["contextWindow"], defaults["contextWindow"])
        if caps["contextWindowConfigurable"]
        else defaults["contextWindow"]
    )
    output_minimum = 256 if preset["provider"] in ("lmstudio", "omlx") else 128
    output_limit = limits["maxOutputTokens"]
    output_fraction = (preset.get("requestLimits") or {}).get("maxOutputContextFraction")
    if _is_finite_number(output_fraction):
        output_limit = min(output_limit, max(output_minimum, math.floor(context_window * output_fraction)))
    max_output_tokens = _clamp_int(
        ov("maxOutputTokens"), output_minimum, output_limit, min(defaults["maxOutputTokens"], output_limit)
    )
    top_p = None if defaults["topP"] is None else _clamp_number(ov("topP"), 0, 1, defaults["topP"])
    top_k = None if defaults["topK"] is None else _clamp_int(ov("topK"), 1, 1000, defaults["topK"])
    repeat_penalty = None if defaults["repeatPenalty"] is None else _clamp_number(ov("repeatPenalty"), 0, 2, defaults["repeatPenalty"])
    allowed_json = JSON_MODES.get(preset["provider"])
    json_mode = ov("jsonMode") if allowed_json and ov("jsonMode") in allowed_json else defaults["jsonMode"]
    context_mode = (
        ov("contextMode")
        if preset["provider"] in ("lmstudio", "omlx") and ov("contextMode") in CONTEXT_MODES
        else defaults["contextMode"]
    )
    streaming = overrides["streaming"] if isinstance(overrides.get("streaming"), bool) else (defaults.get("streaming") is not False)

    requested = _clean_model(ov("model"), preset["model"])
    model = requested if preset["id"] == "custom" or model_matches_preset(preset, requested) else preset["model"]

    return {
        "model": model,
        "contextWindow": context_window,
        "maxOutputTokens": max_output_tokens,
        "temperature": temperature,
        "topP": top_p,
        "topK": top_k,
        "repeatPenalty": repeat_penalty,
        "reasoningEffort": effort,
        "reasoningAdapter": caps["reasoningAdapter"],
        "jsonMode": json_mode,
        "contextMode": context_mode,
        "streaming": streaming,
    }


def settings_patch_for_preset(preset, overrides=None):
    params = normalize_parameters(preset, overrides or {})
    provider = preset["provider"]
    if provider == "ollama":
        return {
            "ollamaModel": params["model"],
            "ollamaContextWindow": params["contextWindow"],
            "ollamaNumTokens": params["maxOutputTokens"],
            "ollamaTemperature": params["temperature"],
            "ollamaTopP": params["topP"],
            "ollamaTopK": params["topK"],
            "ollamaRepeatPenalty": params["repeatPenalty"],
            "ollamaReasoningEffort": params["reasoningEffort"],
            "ollamaReasoningAdapter": params["reasoningAdapter"],
            "ollamaJsonMode": params["jsonMode"],
        }
    if provider == "lmstudio":
        return {
            "lmstudioModel": params["model"],
            "lmstudioContextWindow": params["contextWindow"],
            "lmstudioNumTokens": params["maxOutputTokens"],
            "lmstudioTemperature": params["temperature"],
            "lmstudioTopP": params["topP"],
            "lmstudioTopK": params["topK"],
            "lmstudioRepeatPenalty": params["repeatPenalty"],
            "lmstudioReasoningEffort": params["reasoningEffort"],
            "lmstudioReasoningAdapter": params["reasoningAdapter"],
            "lmstudioJsonMode": params["jsonMode"],
            "lmstudioContextMode": params["contextMode"],
        }
    if provider == "omlx":
        return {
            "omlxModel": params["model"],
            "omlxContextWindow": params["contextWindow"],
            "omlxNumTokens": params["maxOutputTokens"],
            "omlxTemperature": params["temperature"],
            "omlxTopP": params["topP"],
            "omlxTopK": params["topK"],
            "omlxRepeatPenalty": params["repeatPenalty"],
            "omlxReasoningEffort": params["reasoningEffort"],
            "omlxReasoningAdapter": params["reasoningAdapter"],
            "omlxJsonMode": params["jsonMode"],
            "omlxContextMode": params["contextMode"],
        }
    if provider == "codex":
        return {
            "codexModel": params["model"],
            "codexContextWindow": params["contextWindow"],
            "codexMaxTokens": params["maxOutputTokens"],
            "codexTemperature": params["temperature"],
            "codexReasoningEffort": params["reasoningEffort"],
            "codexReasoningAdapter": params["reasoningAdapter"],
        }
    if provider == "huggingface":
        return {
            "huggingfaceModel": params["model"],
            "huggingfaceContextWindow": params["contextWindow"],
            "huggingfaceMaxTokens": params["maxOutputTokens"],
            "huggingfaceTemperature": params["temperature"],
            "huggingfaceReasoningEffort": params["reasoningEffort"],
            "huggingfaceReasoningAdapter": params["reasoningAdapter"],
        }
    return {
        "claudeModel": params["model"],
        "claudeContextWindow": params["contextWindow"],
        "claudeMaxTokens": params["maxOutputTokens"],
        "claudeTemperature": params["temperature"],
        "claudeReasoningEffort": params["reasoningEffort"],
        "claudeReasoningAdapter": params["reasoningAdapter"],
        "claudeStreaming": params["streaming"],
    }


def sanitize_model_id(value):
    return _clean_model(value, "")


def _effort_values_from_profile(profile):
    if not profile or not isinstance(profile.get("reasoningEfforts"), list):
        return []
    values = []
    for entry in profile["reasoningEfforts"]:
        value = entry if isinstance(entry, str) else (entry.get("value") if isinstance(entry, dict) else None)
        if value in REASONING_EFFORTS:
            values.append(value)
    return list(dict.fromkeys(values))


def runtime_preset_for_profile(provider, profile):
    if provider not in ("codex", "claude") or not profile or not isinstance(profile, dict):
        return None
    model = sanitize_model_id(profile.get("id"))
    if not model:
        return None

    allowed_adapters = ["openai"] if provider == "codex" else ["anthropic-adaptive", "anthropic-effort"]
    adapter = profile.get("reasoningAdapter") if profile.get("reasoningAdapter") in allowed_adapters else "none"
    efforts = _effort_values_from_profile(profile)
    if provider == "claude":
        efforts = [e for e in efforts if e != "ultra"]
    if adapter == "none" or not any(e != "none" for e in efforts):
        adapter = "none"
        efforts = ["none"]
    preferred_effort = str(profile.get("defaultReasoningEffort") or "")
    default_effort = preferred_effort if preferred_effort in efforts else ("high" if "high" in efforts else efforts[0])
    context_window = _clamp_int(profile.get("contextWindow", _UNDEF), 512, 4000000, 272000 if provider == "codex" else 200000)
    max_output_limit = min(context_window, 1000000)
    max_output_tokens = _clamp_int(profile.get("maxOutputTokens", _UNDEF), 128, max_output_limit, min(65536, max_output_limit))
    suffix = _normalized_model(model)[:54] or "model"

    if adapter == "openai":
        parameter = "reasoning.effort"
    elif adapter == "anthropic-adaptive":
        parameter = "thinking.type=adaptive + output_config.effort"
    elif adapter == "anthropic-effort":
        parameter = "output_config.effort"
    else:
        parameter = None

    return {
        "id": f"dynamic-{provider}-{suffix}"[:80],
        "label": (str(profile.get("label") or model).strip()[:120]) or model,
        "deployment": "hosted",
        "provider": provider,
        "model": model,
        "sourceUrl": "https://developers.openai.com/api/docs/models"
        if provider == "codex"
        else "https://platform.claude.com/docs/en/about-claude/models/overview",
        "modelPatterns": [model],
        "recommended": False,
        "description": str(profile.get("description") or f"Discovered {provider} model.").strip()[:500],
        "requirements": f"Sign in with {'ChatGPT' if provider == 'codex' else 'Claude'}.",
        "limits": {"contextWindow": context_window, "maxOutputTokens": max_output_tokens},
        "requestLimits": {"maxOutputContextFraction": None},
        "capabilities": {
            "toolCalling": True,
            "structuredOutput": provider == "codex",
            "temperature": False,
            "contextWindowConfigurable": False,
            "reasoningAdapter": adapter,
            "reasoningEfforts": efforts,
        },
        "parameters": {
            "contextWindow": context_window,
            "maxOutputTokens": min(65536, max_output_tokens),
            "temperature": None,
            "topP": None,
            "topK": None,
            "repeatPenalty": None,
            "reasoning": {"effort": default_effort, "parameter": parameter},
            "jsonMode": None,
            "contextMode": None,
        },
    }


def neutral_local_preset(provider, value):
    if provider not in ("ollama", "lmstudio", "omlx"):
        return None
    model = sanitize_model_id(value)
    if not model:
        return None
    open_ai_compatible = provider in ("lmstudio", "omlx")
    return {
        "id": "custom",
        "label": model,
        "deployment": "local",
        "provider": provider,
        "model": model,
        "limits": {"contextWindow": 262144, "maxOutputTokens": 128000},
        "requestLimits": {"maxOutputContextFraction": 0.5 if open_ai_compatible else 1},
        "capabilities": {
            "toolCalling": True,
            "structuredOutput": True,
            "temperature": True,
            "contextWindowConfigurable": True,
            "reasoningAdapter": "none",
            "reasoningEfforts": ["none"],
        },
        "parameters": {
            "contextWindow": 8192,
            "maxOutputTokens": 4096,
            "temperature": 0,
            "topP": None,
            "topK": None,
            "repeatPenalty": None,
            "reasoning": {"effort": "none", "parameter": None},
            "jsonMode": "text" if open_ai_compatible else "json",
            "contextMode": "summarize" if open_ai_compatible else None,
        },
    }


def settings_patch_for_reasoning(preset, reasoning_effort, model=_UNDEF):
    if not preset or reasoning_effort not in preset["capabilities"]["reasoningEfforts"]:
        return None
    if model is _UNDEF:
        model = preset["model"]
    params = normalize_parameters(preset, {"model": model, "reasoningEffort": reasoning_effort})
    provider = preset["provider"]
    prefix = "ollama" if provider == "ollama" else ("lmstudio" if provider == "lmstudio" else provider)
    return {
        f"{prefix}Model": params["model"],
        f"{prefix}ReasoningEffort": params["reasoningEffort"],
        f"{prefix}ReasoningAdapter": params["reasoningAdapter"],
    }


def custom_preset_for_settings(provider, settings):
    if not PROVIDER_DEPLOYMENT.get(provider):
        return None
    s = settings
    if provider == "ollama":
        adapter = s.get("ollamaReasoningAdapter") if s.get("ollamaReasoningAdapter") in ("ollama-think-effort", "ollama-think-toggle") else "none"
        efforts = (
            ["low", "medium", "high"]
            if adapter == "ollama-think-effort"
            else ["none", "medium"] if adapter == "ollama-think-toggle" else ["none"]
        )
        return {
            "id": "custom", "provider": provider, "deployment": "local", "model": s.get("ollamaModel") or "custom-model",
            "limits": {"contextWindow": 262144, "maxOutputTokens": 128000},
            "requestLimits": {"maxOutputContextFraction": 1},
            "capabilities": {"temperature": True, "contextWindowConfigurable": True, "reasoningAdapter": adapter, "reasoningEfforts": efforts},
            "parameters": {
                "contextWindow": s.get("ollamaContextWindow") or 8192,
                "maxOutputTokens": s.get("ollamaNumTokens") or 8192,
                "temperature": _nn(s.get("ollamaTemperature"), 0),
                "topP": _nn(s.get("ollamaTopP"), None),
                "topK": _nn(s.get("ollamaTopK"), None),
                "repeatPenalty": _nn(s.get("ollamaRepeatPenalty"), None),
                "reasoning": {"effort": s.get("ollamaReasoningEffort") if s.get("ollamaReasoningEffort") in efforts else efforts[0], "parameter": None if adapter == "none" else "think"},
                "jsonMode": s.get("ollamaJsonMode") or "json", "contextMode": None,
            },
        }
    if provider == "lmstudio":
        adapter = "openai-compatible" if s.get("lmstudioReasoningAdapter") == "openai-compatible" else "none"
        return {
            "id": "custom", "provider": provider, "deployment": "local", "model": s.get("lmstudioModel") or "custom-model",
            "limits": {"contextWindow": 262144, "maxOutputTokens": 128000},
            "requestLimits": {"maxOutputContextFraction": 0.5},
            "capabilities": {"temperature": True, "contextWindowConfigurable": True, "reasoningAdapter": adapter, "reasoningEfforts": ["none", "low", "medium", "high"] if adapter == "openai-compatible" else ["none"]},
            "parameters": {
                "contextWindow": s.get("lmstudioContextWindow") or 8192,
                "maxOutputTokens": s.get("lmstudioNumTokens") or 16000,
                "temperature": _nn(s.get("lmstudioTemperature"), 0),
                "topP": _nn(s.get("lmstudioTopP"), None),
                "topK": _nn(s.get("lmstudioTopK"), None),
                "repeatPenalty": _nn(s.get("lmstudioRepeatPenalty"), None),
                "reasoning": {"effort": s.get("lmstudioReasoningEffort") or "none", "parameter": "reasoning_effort" if adapter == "openai-compatible" else None},
                "jsonMode": s.get("lmstudioJsonMode") or "text", "contextMode": s.get("lmstudioContextMode") or "summarize",
            },
        }
    if provider == "omlx":
        adapter = "omlx-template-effort" if s.get("omlxReasoningAdapter") == "omlx-template-effort" else "none"
        efforts = ["low", "medium", "high"] if adapter == "omlx-template-effort" else ["none"]
        default_effort = s.get("omlxReasoningEffort") if s.get("omlxReasoningEffort") in efforts else efforts[0]
        return {
            "id": "custom", "provider": provider, "deployment": "local", "model": s.get("omlxModel") or "custom-model",
            "limits": {"contextWindow": 262144, "maxOutputTokens": 128000},
            "requestLimits": {"maxOutputContextFraction": 0.5},
            "capabilities": {"temperature": True, "contextWindowConfigurable": True, "reasoningAdapter": adapter, "reasoningEfforts": efforts},
            "parameters": {
                "contextWindow": s.get("omlxContextWindow") or 8192,
                "maxOutputTokens": s.get("omlxNumTokens") or 4096,
                "temperature": _nn(s.get("omlxTemperature"), 0),
                "topP": _nn(s.get("omlxTopP"), None),
                "topK": _nn(s.get("omlxTopK"), None),
                "repeatPenalty": _nn(s.get("omlxRepeatPenalty"), None),
                "reasoning": {"effort": default_effort, "parameter": "chat_template_kwargs.reasoning_effort" if adapter == "omlx-template-effort" else None},
                "jsonMode": s.get("omlxJsonMode") or "text", "contextMode": s.get("omlxContextMode") or "summarize",
            },
        }
    if provider == "codex":
        adapter = "openai" if s.get("codexReasoningAdapter") == "openai" else "none"
        known_preset = preset_for_model("codex", s.get("codexModel"))
        efforts = (
            (known_preset["capabilities"]["reasoningEfforts"] if known_preset else ["none", "low", "medium", "high", "xhigh", "max", "ultra"])
            if adapter == "openai"
            else ["none"]
        )
        default_effort = s.get("codexReasoningEffort") if s.get("codexReasoningEffort") in efforts else (known_preset["parameters"]["reasoning"]["effort"] if known_preset else efforts[0])
        return {
            "id": "custom", "provider": provider, "deployment": "hosted", "model": s.get("codexModel") or "gpt-5.6-sol",
            "limits": {"contextWindow": 1050000, "maxOutputTokens": 128000},
            "requestLimits": {"maxOutputContextFraction": None},
            "capabilities": {"temperature": adapter == "none", "contextWindowConfigurable": False, "reasoningAdapter": adapter, "reasoningEfforts": efforts},
            "parameters": {
                "contextWindow": s.get("codexContextWindow") or 1000000,
                "maxOutputTokens": s.get("codexMaxTokens") or 4096,
                "temperature": (_nn(s.get("codexTemperature"), 0)) if adapter == "none" else None,
                "topP": None, "topK": None, "repeatPenalty": None,
                "reasoning": {"effort": default_effort, "parameter": "reasoning.effort" if adapter == "openai" else None},
                "jsonMode": None, "contextMode": None,
            },
        }
    if provider == "huggingface":
        adapter = "openai" if s.get("huggingfaceReasoningAdapter") == "openai" else "none"
        efforts = ["none", "low", "medium", "high"] if adapter == "openai" else ["none"]
        default_effort = s.get("huggingfaceReasoningEffort") if s.get("huggingfaceReasoningEffort") in efforts else efforts[0]
        return {
            "id": "custom", "provider": provider, "deployment": "hosted", "model": s.get("huggingfaceModel") or "meta-llama/Llama-3.3-70B-Instruct",
            "limits": {"contextWindow": 262144, "maxOutputTokens": 128000},
            "requestLimits": {"maxOutputContextFraction": None},
            "capabilities": {"temperature": adapter == "none", "contextWindowConfigurable": False, "reasoningAdapter": adapter, "reasoningEfforts": efforts},
            "parameters": {
                "contextWindow": s.get("huggingfaceContextWindow") or 32768,
                "maxOutputTokens": s.get("huggingfaceMaxTokens") or 4096,
                "temperature": (_nn(s.get("huggingfaceTemperature"), 0.7)) if adapter == "none" else None,
                "topP": None, "topK": None, "repeatPenalty": None,
                "reasoning": {"effort": default_effort, "parameter": "reasoning.effort" if adapter == "openai" else None},
                "jsonMode": None, "contextMode": None,
            },
        }
    # claude
    adapter = s.get("claudeReasoningAdapter") if s.get("claudeReasoningAdapter") in ("anthropic-adaptive", "anthropic-effort") else "none"
    known_preset = preset_for_model("claude", s.get("claudeModel"))
    efforts = (
        (known_preset["capabilities"]["reasoningEfforts"] if known_preset else ["none", "low", "medium", "high", "xhigh", "max"])
        if adapter in ("anthropic-adaptive", "anthropic-effort")
        else ["none"]
    )
    default_effort = s.get("claudeReasoningEffort") if s.get("claudeReasoningEffort") in efforts else (known_preset["parameters"]["reasoning"]["effort"] if known_preset else efforts[0])
    return {
        "id": "custom", "provider": provider, "deployment": "hosted", "model": s.get("claudeModel") or "claude-opus-4-8",
        "limits": {"contextWindow": 1000000, "maxOutputTokens": 128000},
        "requestLimits": {"maxOutputContextFraction": None},
        "capabilities": {"temperature": False, "contextWindowConfigurable": False, "reasoningAdapter": adapter, "reasoningEfforts": efforts, "streamingConfigurable": True},
        "parameters": {
            "contextWindow": s.get("claudeContextWindow") or 1000000,
            "maxOutputTokens": s.get("claudeMaxTokens") or 16000,
            "streaming": s.get("claudeStreaming") is not False,
            "temperature": None, "topP": None, "topK": None, "repeatPenalty": None,
            "reasoning": {
                "effort": default_effort,
                "parameter": "thinking.type=adaptive + output_config.effort"
                if adapter == "anthropic-adaptive"
                else "output_config.effort" if adapter == "anthropic-effort" else None,
            },
            "jsonMode": None, "contextMode": None,
        },
    }


def public_catalog():
    return catalog
