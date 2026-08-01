"""Hosted model discovery (port of packages/shared/src/agent/model-discovery.js).

Lists selectable hosted models for Codex (OpenAI) and Claude (Anthropic). Live
results are cached briefly (5-minute in-memory TTL). Discovery is deliberately
fail-open to a static catalog (CODEX_CHATGPT_PROFILES / CLAUDE_PROFILES) so the
Settings page always stays usable — unless the caller passes ``strict`` (used as
an agent-dispatch readiness preflight), in which case provider failures surface.

Model dicts and the discovery ``result`` envelope keep camelCase keys (browser/UI
contract). Public functions are snake_case. The ``options`` seam keeps the
injectable ``fetch_impl`` / ``create_anthropic_client`` fakes so tests never hit
the network or require the (optional) ``anthropic`` SDK.

Port notes vs. the JS source:
* ``options`` keys were snake_cased: ``fetch_impl`` (was ``fetchImpl``),
  ``create_anthropic_client`` (was ``createAnthropicClient``), ``client_version``
  (was ``clientVersion``). ``now``/``refresh``/``strict``/``backend``/
  ``credentials`` are unchanged.
* The default ``create_anthropic_client`` builds an ``anthropic.AsyncAnthropic``
  with snake_case kwargs (``api_key``/``auth_token``/``base_url``/``timeout``/
  ``max_retries``/``default_headers``) so ``anthropic`` can be imported lazily and
  the client works out of the box. ``anthropic`` is imported inside the function.
* ``oauth`` / ``claude_oauth`` are imported lazily inside the credential helpers
  (they are ported in parallel and may be momentarily absent); any import error
  there is caught by ``discover_models`` and folds into the fallback catalog.
"""

from __future__ import annotations

import math
import re
import time
from datetime import datetime, timezone

from ai_fleet.config import CONFIG
from ai_fleet import store

CACHE_TTL_MS = 5 * 60 * 1000
DISCOVERY_TIMEOUT_MS = 5000

EFFORT_LABELS = {
    "none": "Off",
    "minimal": "Minimal",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra high",
    "max": "Max",
    "ultra": "Ultra",
}

EFFORT_DESCRIPTIONS = {
    "none": "Disable additional reasoning.",
    "minimal": "Use the smallest available reasoning budget.",
    "low": "Fast responses with lighter reasoning.",
    "medium": "Balance speed and reasoning depth for everyday tasks.",
    "high": "Use greater reasoning depth for complex problems.",
    "xhigh": "Use extra reasoning for difficult, long-running work.",
    "max": "Use maximum reasoning depth for the hardest problems.",
    "ultra": "Use maximum reasoning with automatic task delegation.",
}

CODEX_CHATGPT_PROFILES = [
    {
        "id": "gpt-5.6-sol",
        "label": "GPT-5.6 Sol",
        "description": "Latest frontier agentic coding model for complex professional work.",
        "contextWindow": 372000,
        "apiContextWindow": 1050000,
        "maxOutputTokens": 128000,
        "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "apiEfforts": ["none", "low", "medium", "high", "xhigh", "max"],
        "defaultReasoningEffort": "xhigh",
        "apiDefaultReasoningEffort": "medium",
    },
    {
        "id": "gpt-5.6-terra",
        "label": "GPT-5.6 Terra",
        "description": "GPT-5.6 model balancing intelligence, latency, and cost.",
        "contextWindow": 372000,
        "apiContextWindow": 1050000,
        "maxOutputTokens": 128000,
        "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "apiEfforts": ["none", "low", "medium", "high", "xhigh", "max"],
        "defaultReasoningEffort": "xhigh",
        "apiDefaultReasoningEffort": "medium",
    },
    {
        "id": "gpt-5.6-luna",
        "label": "GPT-5.6 Luna",
        "description": "GPT-5.6 model optimized for cost-sensitive, high-volume workloads.",
        "contextWindow": 372000,
        "apiContextWindow": 1050000,
        "maxOutputTokens": 128000,
        "efforts": ["low", "medium", "high", "xhigh", "max"],
        "apiEfforts": ["none", "low", "medium", "high", "xhigh", "max"],
        "defaultReasoningEffort": "xhigh",
        "apiDefaultReasoningEffort": "medium",
    },
    {
        "id": "gpt-5.5",
        "label": "GPT-5.5",
        "description": "Frontier model for complex coding, research, and real-world work.",
        "contextWindow": 272000,
        "apiContextWindow": 1050000,
        "maxOutputTokens": 128000,
        "efforts": ["low", "medium", "high", "xhigh"],
        "apiEfforts": ["none", "low", "medium", "high", "xhigh"],
        "defaultReasoningEffort": "xhigh",
        "apiDefaultReasoningEffort": "medium",
    },
    {
        "id": "gpt-5.4",
        "label": "GPT-5.4",
        "description": "Strong general-purpose model for coding and professional work.",
        "contextWindow": 272000,
        "apiContextWindow": 1050000,
        "maxOutputTokens": 128000,
        "efforts": ["low", "medium", "high", "xhigh"],
        "apiEfforts": ["none", "low", "medium", "high", "xhigh"],
        "defaultReasoningEffort": "medium",
        "apiDefaultReasoningEffort": "medium",
    },
    {
        "id": "gpt-5.4-mini",
        "label": "GPT-5.4 Mini",
        "description": "Smaller frontier model for fast coding and subagent workloads.",
        "contextWindow": 272000,
        "apiContextWindow": 400000,
        "maxOutputTokens": 128000,
        "efforts": ["low", "medium", "high", "xhigh"],
        "apiEfforts": ["none", "low", "medium", "high", "xhigh"],
        "defaultReasoningEffort": "medium",
        "apiDefaultReasoningEffort": "medium",
    },
]

CLAUDE_PROFILES = [
    {
        "id": "claude-fable-5",
        "label": "Claude Fable 5",
        "description": "Next-generation intelligence for long-running agents.",
        "contextWindow": 1000000,
        "maxOutputTokens": 128000,
        "reasoningAdapter": "anthropic-adaptive",
        "efforts": ["low", "medium", "high", "xhigh", "max"],
        "defaultReasoningEffort": "high",
    },
    {
        "id": "claude-opus-4-8",
        "label": "Claude Opus 4.8",
        "description": "Complex agentic coding and high-autonomy enterprise work.",
        "contextWindow": 1000000,
        "maxOutputTokens": 128000,
        "reasoningAdapter": "anthropic-adaptive",
        "efforts": ["low", "medium", "high", "xhigh", "max"],
        "defaultReasoningEffort": "high",
    },
    {
        "id": "claude-sonnet-5",
        "label": "Claude Sonnet 5",
        "description": "Fast frontier model balancing intelligence and throughput.",
        "contextWindow": 1000000,
        "maxOutputTokens": 128000,
        "reasoningAdapter": "anthropic-adaptive",
        "efforts": ["low", "medium", "high", "xhigh", "max"],
        "defaultReasoningEffort": "high",
    },
    {
        "id": "claude-haiku-4-5-20251001",
        "label": "Claude Haiku 4.5",
        "description": "Fast, economical model for high-volume and subagent workloads.",
        "contextWindow": 200000,
        "maxOutputTokens": 64000,
        "reasoningAdapter": "none",
        "efforts": ["none"],
        "defaultReasoningEffort": "none",
    },
]

cache: dict = {}


# --------------------------------------------------------------------------- #
# small JS-idiom helpers
# --------------------------------------------------------------------------- #
def _js_number(value) -> float:
    """Replicate JS ``Number()``: undefined/NaN → NaN, None → 0, bool → 1/0."""
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


def _round_half_up(n: float) -> int:
    return math.floor(n + 0.5)


def _attr(obj, key, default=None):
    """Property access that works for dicts (tests) and objects (real SDK)."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _strip_trailing_slash(value) -> str:
    return re.sub(r"/$", "", str(value))


def _iso_from_ms(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


async def _default_fetch(url, options=None):
    """Real httpx-backed fetch shaped like the JS ``fetch`` response contract."""
    import httpx

    options = options or {}
    headers = options.get("headers") or {}
    method = options.get("method") or "GET"
    timeout = (options.get("timeout_ms") or DISCOVERY_TIMEOUT_MS) / 1000
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.request(method, url, headers=headers)
    return _FetchResponse(resp)


class _FetchResponse:
    def __init__(self, resp):
        self._resp = resp
        self.status = resp.status_code
        self.ok = 200 <= resp.status_code < 300

    async def json(self):
        return self._resp.json()


# --------------------------------------------------------------------------- #
# catalog helpers
# --------------------------------------------------------------------------- #
def safe_positive_int(value, fallback):
    n = _js_number(value)
    return _round_half_up(n) if math.isfinite(n) and n > 0 else fallback


def title_from_id(id):
    parts = [p for p in str(id or "").split("-") if p]
    out = []
    for part in parts:
        if re.match(r"^\d", part):
            out.append(part)
        else:
            out.append(part[0].upper() + part[1:])
    return " ".join(out)


def effort_options(values, descriptions=None):
    seen = set()
    result_list = []
    items = values if isinstance(values, list) else []
    for entry in items:
        if isinstance(entry, str):
            value = entry
        elif entry and isinstance(entry, dict):
            value = entry.get("effort") or entry.get("value")
        else:
            value = None
        if not value or value in seen or value not in EFFORT_LABELS:
            continue
        seen.add(value)
        supplied = entry.get("description") if isinstance(entry, dict) and entry else None
        description = (
            supplied
            or (descriptions.get(value) if descriptions else None)
            or EFFORT_DESCRIPTIONS[value]
        )
        result_list.append({"value": value, "label": EFFORT_LABELS[value], "description": description})
    return result_list


def clone_model(model):
    cloned = dict(model)
    cloned["reasoningEfforts"] = [dict(effort) for effort in model["reasoningEfforts"]]
    return cloned


def clone_models(models):
    return [clone_model(model) for model in models]


def codex_fallback_models(backend=None):
    if backend is None:
        backend = CONFIG.OAUTH.backend
    api = backend == "api"
    return [
        {
            "id": profile["id"],
            "label": profile["label"],
            "description": profile["description"],
            "contextWindow": profile["apiContextWindow"] if api else profile["contextWindow"],
            "maxOutputTokens": profile["maxOutputTokens"],
            "reasoningAdapter": "openai",
            "reasoningEfforts": effort_options(profile["apiEfforts"] if api else profile["efforts"]),
            "defaultReasoningEffort": profile["apiDefaultReasoningEffort"] if api else profile["defaultReasoningEffort"],
            "source": "fallback",
        }
        for profile in CODEX_CHATGPT_PROFILES
    ]


def claude_fallback_models():
    return [
        {
            "id": profile["id"],
            "label": profile["label"],
            "description": profile["description"],
            "contextWindow": profile["contextWindow"],
            "maxOutputTokens": profile["maxOutputTokens"],
            "reasoningAdapter": profile["reasoningAdapter"],
            "reasoningEfforts": effort_options(profile["efforts"]),
            "defaultReasoningEffort": profile["defaultReasoningEffort"],
            "source": "fallback",
        }
        for profile in CLAUDE_PROFILES
    ]


def seed_cache():
    cache["codex:chatgpt"] = {
        "models": codex_fallback_models("chatgpt"), "source": "fallback", "refreshedAt": None, "expiresAt": 0,
    }
    cache["codex:api"] = {
        "models": codex_fallback_models("api"), "source": "fallback", "refreshedAt": None, "expiresAt": 0,
    }
    cache["claude"] = {
        "models": claude_fallback_models(), "source": "fallback", "refreshedAt": None, "expiresAt": 0,
    }


seed_cache()


def cache_key(provider, backend=None):
    if backend is None:
        backend = CONFIG.OAUTH.backend
    if provider == "codex":
        return f"codex:{'api' if backend == 'api' else 'chatgpt'}"
    return "claude"


def fallback_models(provider, backend=None):
    if backend is None:
        backend = CONFIG.OAUTH.backend
    return codex_fallback_models(backend) if provider == "codex" else claude_fallback_models()


def result(provider, models, source, connected, refreshed_at):
    return {
        "provider": provider,
        "models": clone_models(models),
        "source": source,
        "connected": connected,
        "refreshedAt": refreshed_at,
    }


def fallback_result(provider, backend, connected):
    return result(provider, fallback_models(provider, backend), "fallback", connected, None)


def find_codex_profile(id):
    normalized = str(id or "").lower()
    if normalized == "gpt-5.6":
        return CODEX_CHATGPT_PROFILES[0]
    return next((p for p in CODEX_CHATGPT_PROFILES if p["id"] == normalized), None)


def find_claude_profile(id):
    normalized = str(id or "").lower()
    if normalized == "claude-haiku-4-5":
        return CLAUDE_PROFILES[3]
    return next((p for p in CLAUDE_PROFILES if p["id"] == normalized), None)


def map_codex_chatgpt_model(raw):
    id = str(raw.get("slug") or raw.get("id") or "").strip()
    if not id:
        return None
    fallback = find_codex_profile(id)
    efforts = effort_options(raw.get("supported_reasoning_levels"))
    usable_efforts = (
        efforts
        if efforts
        else effort_options(fallback["efforts"] if fallback else ["low", "medium", "high", "xhigh"])
    )
    default_level = raw.get("default_reasoning_level")
    if any(entry["value"] == default_level for entry in usable_efforts):
        default_effort = default_level
    elif fallback and any(entry["value"] == fallback["defaultReasoningEffort"] for entry in usable_efforts):
        default_effort = fallback["defaultReasoningEffort"]
    else:
        default_effort = usable_efforts[0]["value"]
    return {
        "id": id,
        "label": raw.get("display_name") or (fallback["label"] if fallback else None) or title_from_id(id),
        "description": raw.get("description") or (fallback["description"] if fallback else None) or "Available through Codex.",
        "contextWindow": safe_positive_int(raw.get("context_window"), fallback["contextWindow"] if fallback else 128000),
        "maxOutputTokens": safe_positive_int(raw.get("max_output_tokens"), fallback["maxOutputTokens"] if fallback else 128000),
        "reasoningAdapter": "openai",
        "reasoningEfforts": usable_efforts,
        "defaultReasoningEffort": default_effort,
        "source": "live",
    }


def is_selectable_openai_model(id):
    value = str(id or "").lower()
    if not re.match(r"^(gpt-|o\d|chatgpt-)", value):
        return False
    return not re.search(r"(audio|realtime|transcrib|tts|image|search|embedding|moderation)", value)


def generic_openai_api_model(id):
    return {
        "id": id,
        "label": title_from_id(id),
        "description": "Available to the connected OpenAI API account; reasoning capabilities are provider-managed until catalog metadata is known.",
        "contextWindow": 128000,
        "maxOutputTokens": 128000,
        "reasoningAdapter": "none",
        "reasoningEfforts": effort_options(["none"]),
        "defaultReasoningEffort": "none",
        "source": "live",
    }


def merge_metered_codex_models(raw_models):
    fallbacks = codex_fallback_models("api")
    available = {}
    for raw in (raw_models if isinstance(raw_models, list) else []):
        # Faithful to JS `String(raw && (raw.id || raw.slug) || '')`.
        id = str((raw.get("id") or raw.get("slug")) or "").strip() if raw else ""
        if id and is_selectable_openai_model(id):
            available[id] = raw
    merged = [{**model, "source": "live" if model["id"] in available else "fallback"} for model in fallbacks]
    known = {model["id"] for model in merged}
    for id in available:
        if id not in known:
            merged.append(generic_openai_api_model(id))
    # `ultra` is a Codex product mode, not a public Responses API effort.
    return [
        {**model, "reasoningEfforts": [e for e in model["reasoningEfforts"] if e["value"] != "ultra"]}
        for model in merged
    ]


def capability_supported(value):
    return bool(value and _attr(value, "supported"))


def map_claude_model(raw):
    raw_id = _attr(raw, "id")
    id = str(raw_id or "").strip()
    if not id:
        return None
    fallback = find_claude_profile(id)
    capabilities = _attr(raw, "capabilities") or {}
    effort = _attr(capabilities, "effort") or None
    effort_values = []
    if effort and _attr(effort, "supported"):
        for value in ["low", "medium", "high", "xhigh", "max"]:
            if capability_supported(_attr(effort, value)):
                effort_values.append(value)
    if not effort_values and fallback and fallback["reasoningAdapter"] != "none":
        effort_values.extend(fallback["efforts"])
    thinking = _attr(capabilities, "thinking")
    types = _attr(thinking, "types")
    adaptive_capability = _attr(types, "adaptive")
    adaptive_supported = capability_supported(adaptive_capability)
    fallback_adaptive = (
        not adaptive_capability and fallback is not None and fallback["reasoningAdapter"] == "anthropic-adaptive"
    )
    if effort_values:
        reasoning_adapter = "anthropic-adaptive" if (adaptive_supported or fallback_adaptive) else "anthropic-effort"
    else:
        reasoning_adapter = "none"
    efforts = effort_options(effort_values if effort_values else ["none"])
    fallback_default = fallback["defaultReasoningEffort"] if fallback else None
    if any(entry["value"] == fallback_default for entry in efforts):
        default_reasoning_effort = fallback_default
    elif any(entry["value"] == "high" for entry in efforts):
        default_reasoning_effort = "high"
    else:
        default_reasoning_effort = efforts[0]["value"]
    return {
        "id": id,
        "label": _attr(raw, "display_name") or (fallback["label"] if fallback else None) or title_from_id(id),
        "description": (fallback["description"] if fallback else None) or "Available to the connected Claude account.",
        "contextWindow": safe_positive_int(_attr(raw, "max_input_tokens"), fallback["contextWindow"] if fallback else 200000),
        "maxOutputTokens": safe_positive_int(_attr(raw, "max_tokens"), fallback["maxOutputTokens"] if fallback else 64000),
        "reasoningAdapter": reasoning_adapter,
        "reasoningEfforts": efforts,
        "defaultReasoningEffort": default_reasoning_effort,
        "source": "live",
    }


# --------------------------------------------------------------------------- #
# credentials
# --------------------------------------------------------------------------- #
def has_credentials(tokens):
    return bool(tokens and (_attr(tokens, "accessToken") or _attr(tokens, "refreshToken")))


async def stored_codex_credentials():
    # Imported lazily; ported in parallel and may be momentarily absent.
    from ai_fleet.agent import oauth as codex_oauth

    tokens = store.get_codex_tokens()
    if not has_credentials(tokens):
        return None
    if codex_oauth.is_expired(tokens):
        tokens = await codex_oauth.refresh_tokens(tokens)
        store.set_codex_tokens(tokens)
    return {
        "accessToken": tokens.get("accessToken"),
        "accountId": codex_oauth.account_id_from_id_token(tokens.get("idToken")),
    }


async def stored_claude_credentials():
    from ai_fleet.agent import claude_oauth

    tokens = store.get_claude_tokens()
    if not has_credentials(tokens):
        return None
    if claude_oauth.is_expired(tokens):
        tokens = await claude_oauth.refresh_tokens(tokens)
        store.set_claude_tokens(tokens)
    return {"accessToken": tokens.get("accessToken")}


def configured_connected(provider):
    if provider == "codex":
        return has_credentials(store.get_codex_tokens())
    return has_credentials(store.get_claude_tokens())


async def credentials_for(provider, options):
    if "credentials" in options:
        return options["credentials"]
    return await (stored_codex_credentials() if provider == "codex" else stored_claude_credentials())


# --------------------------------------------------------------------------- #
# provider fetchers
# --------------------------------------------------------------------------- #
async def fetch_codex_models(credentials, backend, options):
    fetch_impl = options.get("fetch_impl") or _default_fetch
    base_url = _strip_trailing_slash(CONFIG.OAUTH.baseUrl if backend == "api" else CONFIG.OAUTH.chatgptBaseUrl)
    if backend == "api":
        response = await fetch_impl(
            f"{base_url}/models",
            {
                "headers": {"Authorization": f"Bearer {credentials.get('accessToken')}", "Accept": "application/json"},
                "signal": None,
                "timeout_ms": DISCOVERY_TIMEOUT_MS,
            },
        )
        if not response.ok:
            raise Exception(f"OpenAI models request failed (HTTP {response.status}).")
        body = await response.json()
        return merge_metered_codex_models(body.get("data"))

    if not credentials.get("accountId"):
        raise Exception("Codex model discovery requires a ChatGPT account id.")
    client_version = options.get("client_version") or CONFIG.OAUTH.clientVersion
    from urllib.parse import urlencode

    url = f"{base_url}/models?" + urlencode({"client_version": client_version})
    response = await fetch_impl(
        url,
        {
            "headers": {
                "Authorization": f"Bearer {credentials.get('accessToken')}",
                "chatgpt-account-id": credentials.get("accountId"),
                "Accept": "application/json",
                "originator": "codex_cli_rs",
            },
            "signal": None,
            "timeout_ms": DISCOVERY_TIMEOUT_MS,
        },
    )
    if not response.ok:
        raise Exception(f"Codex models request failed (HTTP {response.status}).")
    body = await response.json()
    raw_models = body.get("models") if isinstance(body.get("models"), list) else []
    selectable = [m for m in raw_models if m and m.get("visibility") == "list" and m.get("supported_in_api") is True]

    def _priority(m):
        n = _js_number(m.get("priority"))
        return n if (math.isfinite(n) and n) else 9999

    selectable = sorted(selectable, key=_priority)
    models = [m for m in (map_codex_chatgpt_model(x) for x in selectable) if m]
    if not models:
        raise Exception("Codex returned no selectable models.")
    return models


async def fetch_claude_models(credentials, options):
    create_client = options.get("create_anthropic_client")
    if create_client is None:
        def create_client(client_options):
            from anthropic import AsyncAnthropic

            return AsyncAnthropic(**client_options)

    client = create_client(
        {
            "api_key": None,
            "auth_token": credentials.get("accessToken"),
            "base_url": _strip_trailing_slash(CONFIG.CLAUDE.baseUrl),
            "timeout": DISCOVERY_TIMEOUT_MS / 1000,
            "max_retries": 0,
            "default_headers": {"anthropic-beta": CONFIG.CLAUDE.betaHeader},
        }
    )
    page = await client.models.list(limit=100)
    data = _attr(page, "data")
    models = [m for m in (map_claude_model(x) for x in (data if isinstance(data, list) else [])) if m]
    if not models:
        raise Exception("Claude returned no selectable models.")
    return models


# --------------------------------------------------------------------------- #
# public API
# --------------------------------------------------------------------------- #
async def discover_models(provider, options=None):
    """Discover selectable hosted models. Live results are cached briefly; pass
    ``{"refresh": True}`` to bypass the cache. Discovery is fail-open to the
    static catalog unless ``strict`` is set (agent-dispatch readiness preflight).
    """
    options = options or {}
    if provider != "codex" and provider != "claude":
        raise TypeError(f"Unsupported model discovery provider: {provider}")
    backend = "api" if (provider == "codex" and (options.get("backend") or CONFIG.OAUTH.backend) == "api") else "chatgpt"
    key = cache_key(provider, backend)
    raw_now = options.get("now")
    now = (
        raw_now
        if isinstance(raw_now, (int, float)) and not isinstance(raw_now, bool) and math.isfinite(raw_now)
        else int(time.time() * 1000)
    )
    connected = has_credentials(options["credentials"]) if "credentials" in options else configured_connected(provider)
    if not connected:
        return fallback_result(provider, backend, False)

    cached = cache.get(key)
    if not options.get("refresh") and cached and cached["source"] == "live" and cached["expiresAt"] > now:
        return result(provider, cached["models"], cached["source"], True, cached["refreshedAt"])

    try:
        credentials = await credentials_for(provider, options)
        if not credentials or not credentials.get("accessToken"):
            return fallback_result(provider, backend, False)
        models = (
            await fetch_codex_models(credentials, backend, options)
            if provider == "codex"
            else await fetch_claude_models(credentials, options)
        )
        refreshed_at = _iso_from_ms(now)
        cache[key] = {"models": clone_models(models), "source": "live", "refreshedAt": refreshed_at, "expiresAt": now + CACHE_TTL_MS}
        return result(provider, models, "live", True, refreshed_at)
    except Exception:
        # Strict discovery is a readiness preflight for agent dispatch: falling
        # back to a static catalog there would claim an inaccessible model is
        # usable and start a job certain to fail. Settings keeps the fail-open
        # behavior by omitting `strict`.
        if options.get("strict"):
            raise
        cache[key] = {"models": fallback_models(provider, backend), "source": "fallback", "refreshedAt": None, "expiresAt": 0}
        return fallback_result(provider, backend, True)


def get_cached_model(provider, id):
    """Return a discovered model synchronously, falling back to the seeded catalog."""
    if provider != "codex" and provider != "claude":
        return None
    model_id = str(id or "").strip()
    if not model_id:
        return None
    preferred_key = cache_key(provider, CONFIG.OAUTH.backend)
    if provider == "codex":
        other = "codex:chatgpt" if preferred_key == "codex:api" else "codex:api"
        keys = [preferred_key, other]
    else:
        keys = ["claude"]
    for key in keys:
        entry = cache.get(key)
        if entry:
            model = next((candidate for candidate in entry["models"] if candidate["id"] == model_id), None)
            if model:
                return clone_model(model)
    fallback = next((c for c in fallback_models(provider, CONFIG.OAUTH.backend) if c["id"] == model_id), None)
    return clone_model(fallback) if fallback else None


def reset_cache_for_tests():
    cache.clear()
    seed_cache()
