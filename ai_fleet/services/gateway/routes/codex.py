"""Codex (OpenAI) OAuth 2.0 Authorization Code + PKCE endpoints.

Port of services/gateway/src/routes/codex.js.

Security posture (oauth-oidc checklist):
  - provider URLs + client id are trusted server-side config (CONFIG.OAUTH),
    never read from the request;
  - PKCE S256 + a single-use, short-lived, server-issued ``state`` guard the
    callback against CSRF and code injection;
  - the authorization code is exchanged once, bound to the same redirect_uri
    and verifier; tokens are stored server-side only and masked in responses.
"""

from __future__ import annotations

import math
import re

import httpx
from fastapi import APIRouter
from fastapi.responses import HTMLResponse
from starlette.requests import Request

from ai_fleet import logger, store
from ai_fleet.agent import model_discovery, model_presets, oauth
from ai_fleet.config import CONFIG
from ai_fleet.services.common import json_body
from ai_fleet.util import AppError, mask_key

router = APIRouter()

_MODEL_RE = re.compile(r"[\w.:\-/]{1,100}")
_UNDEF = object()  # distinguishes an absent JSON key from an explicit null


# --------------------------- clamp helpers ------------------------------- #
def _to_number(value):
    """Mirror JS ``Number(value)``: returns a float or NaN."""
    if value is None:
        return float("nan")
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if value == "":
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def _clamp_int(value, min_v, max_v, fallback):
    n = _to_number(value)
    if math.isnan(n) or math.isinf(n):
        return fallback
    return min(max_v, max(min_v, math.floor(n + 0.5)))


def _clamp_number(value, min_v, max_v, fallback):
    if value is _UNDEF:  # JS Number(undefined) -> NaN -> fallback
        return fallback
    if value is None or value == "":  # JS null / '' -> null
        return None
    n = _to_number(value)
    if math.isnan(n) or math.isinf(n):
        return fallback
    return min(max_v, max(min_v, n))


# --------------------------- public views ------------------------------- #
def backend_defaults():
    """Effective base URL + default model for the configured Codex backend."""
    chatgpt = CONFIG.OAUTH.backend == "chatgpt"
    return {
        "backend": CONFIG.OAUTH.backend,
        "baseUrl": CONFIG.OAUTH.chatgptBaseUrl if chatgpt else CONFIG.OAUTH.baseUrl,
        "defaultModel": CONFIG.OAUTH.chatgptModel if chatgpt else CONFIG.OAUTH.defaultModel,
    }


def codex_public():
    """Public (masked) view of the Codex provider state."""
    s = store.get_settings()
    t = s.get("codexTokens")
    connected = bool(t and (t.get("accessToken") or t.get("refreshToken")))
    d = backend_defaults()
    return {
        "provider": s.get("llmProvider") or "ollama",
        "connected": connected,
        "backend": d["backend"],
        "model": s.get("codexModel") or d["defaultModel"],
        "configuredModel": s.get("codexModel") or "",
        "defaultModel": d["defaultModel"],
        "contextWindow": s.get("codexContextWindow") or 1000000,
        "maxTokens": s.get("codexMaxTokens") or 65536,
        "temperature": s.get("codexTemperature"),
        "reasoningEffort": s.get("codexReasoningEffort") or "none",
        "baseUrl": d["baseUrl"],
        "redirectUri": CONFIG.OAUTH.redirectUri,
        "maskedToken": mask_key(t.get("accessToken") or "") if connected else "",
        "expiresAt": (t.get("expiresAt") or None) if connected else None,
        "scope": (t.get("scope") or "") if connected else "",
    }


# --------------------------- routes ------------------------------------- #
# GET /api/settings/codex — masked status for the Settings page.
@router.get("")
@router.get("/")
async def get_codex():
    return codex_public()


# GET /api/settings/codex/models — live account catalog with static fallback.
@router.get("/models")
async def get_models(request: Request):
    refresh = request.query_params.get("refresh") == "1"
    return await model_discovery.discover_models("codex", {"refresh": refresh})


# GET /api/settings/codex/login — begin OAuth; returns the authorize URL.
@router.get("/login")
async def login():
    return {"authorizeUrl": oauth.create_login()["authorizeUrl"]}


# POST /api/settings/codex — save model + output-token budget (NOT provider URLs).
@router.post("")
@router.post("/")
async def save_codex(request: Request):
    b = await json_body(request)
    current = store.get_settings()
    has_model_override = "codexModel" in b
    model = str(b.get("codexModel") or "").strip() if has_model_override else current.get("codexModel")
    if has_model_override and model and (not _MODEL_RE.fullmatch(model) or "//" in model):
        raise AppError("Invalid model name.", 400)

    matched_preset = model_presets.preset_for_model("codex", model)
    model_changed = has_model_override and model != current.get("codexModel")
    current_preset = model_presets.preset_for_model("codex", current.get("codexModel"))
    if matched_preset:
        family = (not current_preset) or current_preset["id"] != matched_preset["id"]
    else:
        family = model_changed
    model_family_changed = has_model_override and family

    if matched_preset:
        reasoning_adapter = matched_preset["capabilities"]["reasoningAdapter"]
    elif model_changed:
        reasoning_adapter = "none"
    else:
        reasoning_adapter = current.get("codexReasoningAdapter") or "none"

    if matched_preset:
        reasoning_efforts = [
            e for e in matched_preset["capabilities"]["reasoningEfforts"]
            if CONFIG.OAUTH.backend == "chatgpt" or e != "ultra"
        ]
    elif reasoning_adapter == "openai":
        reasoning_efforts = (
            ["none", "low", "medium", "high", "xhigh", "max", "ultra"]
            if CONFIG.OAUTH.backend == "chatgpt"
            else ["none", "low", "medium", "high", "xhigh", "max"]
        )
    else:
        reasoning_efforts = ["none"]

    if not model_family_changed and current.get("codexReasoningEffort") in reasoning_efforts:
        default_effort = current.get("codexReasoningEffort")
    elif matched_preset:
        default_effort = matched_preset["parameters"]["reasoning"]["effort"]
    else:
        default_effort = "none"

    if matched_preset and model_family_changed:
        default_max_tokens = matched_preset["parameters"]["maxOutputTokens"]
    elif model_family_changed:
        default_max_tokens = 4096
    else:
        default_max_tokens = current.get("codexMaxTokens") or 65536

    effort = b.get("codexReasoningEffort")
    patch = {
        "codexMaxTokens": _clamp_int(b.get("codexMaxTokens"), 128, 128000, default_max_tokens),
        "codexTemperature": (
            _clamp_number(b.get("codexTemperature", _UNDEF), 0, 2, current.get("codexTemperature"))
            if reasoning_adapter == "none"
            else None
        ),
        "codexReasoningEffort": effort if effort in reasoning_efforts else default_effort,
        "codexReasoningAdapter": reasoning_adapter,
    }
    if model_family_changed:
        patch["codexContextWindow"] = matched_preset["parameters"]["contextWindow"] if matched_preset else 128000
    if current.get("llmProvider") == "codex":
        patch["hostedLlmPresetId"] = "custom"
    if has_model_override:
        patch["codexModel"] = model
    store.patch_settings(patch)
    return codex_public()


# DELETE /api/settings/codex — sign out: clear server-side tokens.
@router.delete("")
@router.delete("/")
async def delete_codex():
    store.clear_codex_tokens()
    return codex_public()


def _message_text(msg):
    """Flatten a chat message ``content`` (string or list of parts) to text."""
    content = getattr(msg, "content", None)
    if content is None and isinstance(msg, dict):
        content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            text = c.get("text") if isinstance(c, dict) else getattr(c, "text", None)
            parts.append(text or "")
        return "".join(parts)
    return ""


def _resolved_model(resolved):
    if isinstance(resolved, dict):
        return resolved.get("model")
    return getattr(resolved, "model", None)


# POST /api/settings/codex/test — verify the token works against the active backend.
@router.post("/test")
async def test_codex():
    # Import lazily: the heavy LLM module may be loading in parallel / on demand.
    from ai_fleet.agent import llm

    if CONFIG.OAUTH.backend == "chatgpt":
        # Exercise the real generation path so auth, model selection, and Responses
        # request compatibility are validated together.
        resolved = await llm.resolve_llm({**store.get_settings(), "llmProvider": "codex"})
        msg = await llm.create_chat_model(resolved).invoke("Reply with the single word: ok")
        if not _message_text(msg).strip():
            raise AppError("Provider returned an empty response.", 502)
        return {"ok": True, "model": _resolved_model(resolved)}

    # Metered API: a cheap authenticated GET against /models.
    tokens = await llm.ensure_fresh_codex_tokens()
    base = re.sub(r"/$", "", CONFIG.OAUTH.baseUrl)
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{base}/models",
            headers={"Authorization": f"Bearer {tokens['accessToken']}", "Accept": "application/json"},
        )
    if not resp.is_success:
        raise AppError(f"Provider rejected the token (HTTP {resp.status_code}).", 502)
    try:
        data = resp.json()
    except Exception:
        data = {}
    count = len(data["data"]) if isinstance(data.get("data"), list) else None
    return {"ok": True, "models": count}


# --------------------------- callback ----------------------------------- #
def escape_html(value):
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _page(status, title, message):
    back_link = '<p><a href="/#/settings">Return to AI Fleet settings</a></p>'
    html = (
        f'<!doctype html><html><head><meta charset="utf-8"><title>{escape_html(title)}</title>'
        "<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:64px auto;padding:0 20px;color:#111}"
        "h1{font-size:20px}a{color:#2563eb}</style></head><body>"
        f"<h1>{escape_html(title)}</h1><p>{escape_html(message)}</p>{back_link}</body></html>"
    )
    return HTMLResponse(content=html, status_code=status)


async def callback(request: Request):
    """OAuth redirect handler. Mounted at the server-registered redirect URI
    (``/auth/callback``). Validates state (single-use), then exchanges the code."""
    q = request.query_params
    code = q.get("code")
    state = q.get("state")
    error = q.get("error")
    error_description = q.get("error_description")

    if error:
        logger.warn(f"Codex OAuth error: {error}")
        return _page(400, "Sign-in failed", str(error_description or error))

    # Validate + consume the state BEFORE touching the code (CSRF / replay guard).
    login_entry = oauth.consume_login(state if isinstance(state, str) else "")
    if not login_entry:
        return _page(403, "Sign-in failed", "Invalid or expired sign-in request. Please start again.")
    if not code or not isinstance(code, str):
        return _page(400, "Sign-in failed", "Missing authorization code.")

    try:
        tokens = await oauth.exchange_code_for_tokens(
            code=code,
            code_verifier=login_entry["codeVerifier"],
            redirect_uri=login_entry["redirectUri"],  # exact redirect_uri reuse
        )
        store.set_codex_tokens(tokens)
        logger.info("Codex OAuth sign-in complete; tokens stored server-side.")
        return _page(200, "Signed in to Codex", "You can close this tab and return to AI Fleet.")
    except Exception as err:
        detail = getattr(err, "message", None) or str(err)
        logger.error(f"Codex token exchange failed: {detail}")
        return _page(502, "Sign-in failed", "Could not complete the token exchange. Please try again.")


# GET /api/settings/codex/_pending — pending-login count for diagnostics/tests (no secrets).
@router.get("/_pending")
async def pending():
    return {"pending": oauth.pending_count()}
