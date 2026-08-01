"""Claude (Anthropic) OAuth 2.0 Authorization Code + PKCE endpoints.

Port of services/gateway/src/routes/claude.js.

Security posture (oauth-oidc checklist):
  - provider URLs + client id are trusted server-side config (CONFIG.CLAUDE),
    never read from the request;
  - PKCE S256 + a single-use, short-lived, server-issued ``state`` guard the
    exchange against CSRF and code injection — the state is echoed back inside
    the pasted ``code#state`` and matched against a login we issued;
  - tokens are stored server-side only and masked in responses.

Flow: /login returns an authorize URL. The operator approves in the browser,
copies the ``code#state`` value Anthropic's callback page shows, and POSTs it to
/exchange. There is no local redirect callback (no loopback port to register).
"""

from __future__ import annotations

import math
import re

from fastapi import APIRouter
from starlette.requests import Request

from ai_fleet import logger, store
from ai_fleet.agent import claude_oauth, model_discovery, model_presets
from ai_fleet.config import CONFIG
from ai_fleet.services.common import json_body
from ai_fleet.util import AppError, mask_key

router = APIRouter()

_MODEL_RE = re.compile(r"[\w.:\-/]{1,100}")


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


def claude_public():
    """Public (masked) view of the Claude provider state."""
    s = store.get_settings()
    t = s.get("claudeTokens")
    connected = bool(t and (t.get("accessToken") or t.get("refreshToken")))
    return {
        "provider": s.get("llmProvider") or "ollama",
        "connected": connected,
        "model": s.get("claudeModel") or CONFIG.CLAUDE.defaultModel,
        "configuredModel": s.get("claudeModel") or "",
        "defaultModel": CONFIG.CLAUDE.defaultModel,
        "contextWindow": s.get("claudeContextWindow") or 1000000,
        "maxTokens": s.get("claudeMaxTokens") or 65536,
        "temperature": s.get("claudeTemperature"),
        "reasoningEffort": s.get("claudeReasoningEffort") or "none",
        "baseUrl": CONFIG.CLAUDE.baseUrl,
        "maskedToken": mask_key(t.get("accessToken") or "") if connected else "",
        "expiresAt": (t.get("expiresAt") or None) if connected else None,
        "scope": (t.get("scope") or "") if connected else "",
    }


# GET /api/settings/claude — masked status for the Settings page.
@router.get("")
@router.get("/")
async def get_claude():
    return claude_public()


# GET /api/settings/claude/models — live account catalog with static fallback.
@router.get("/models")
async def get_models(request: Request):
    refresh = request.query_params.get("refresh") == "1"
    return await model_discovery.discover_models("claude", {"refresh": refresh})


# GET /api/settings/claude/login — begin OAuth; returns the authorize URL to open.
@router.get("/login")
async def login():
    return {"authorizeUrl": claude_oauth.create_login()["authorizeUrl"]}


# POST /api/settings/claude — save model + output-token budget (NOT provider URLs).
@router.post("")
@router.post("/")
async def save_claude(request: Request):
    b = await json_body(request)
    current = store.get_settings()
    has_model_override = "claudeModel" in b
    model = str(b.get("claudeModel") or "").strip() if has_model_override else current.get("claudeModel")
    if has_model_override and model and (not _MODEL_RE.fullmatch(model) or "//" in model):
        raise AppError("Invalid model name.", 400)

    matched_preset = model_presets.preset_for_model("claude", model)
    model_changed = has_model_override and model != current.get("claudeModel")
    current_preset = model_presets.preset_for_model("claude", current.get("claudeModel"))
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
        reasoning_adapter = current.get("claudeReasoningAdapter") or "none"

    if matched_preset:
        reasoning_efforts = matched_preset["capabilities"]["reasoningEfforts"]
    elif reasoning_adapter in ("anthropic-adaptive", "anthropic-effort"):
        reasoning_efforts = ["none", "low", "medium", "high", "xhigh", "max"]
    else:
        reasoning_efforts = ["none"]

    if not model_family_changed and current.get("claudeReasoningEffort") in reasoning_efforts:
        default_effort = current.get("claudeReasoningEffort")
    elif matched_preset:
        default_effort = matched_preset["parameters"]["reasoning"]["effort"]
    else:
        default_effort = "none"

    if matched_preset and model_family_changed:
        default_max_tokens = matched_preset["parameters"]["maxOutputTokens"]
    elif model_family_changed:
        default_max_tokens = 4096
    else:
        default_max_tokens = current.get("claudeMaxTokens") or 65536

    effort = b.get("claudeReasoningEffort")
    patch = {
        "claudeMaxTokens": _clamp_int(b.get("claudeMaxTokens"), 128, 128000, default_max_tokens),
        # Opus 4.8 rejects non-default sampling parameters; keep this explicit so a
        # generic UI never accidentally starts sending temperature.
        "claudeTemperature": None,
        "claudeReasoningEffort": effort if effort in reasoning_efforts else default_effort,
        "claudeReasoningAdapter": reasoning_adapter,
    }
    if model_family_changed:
        patch["claudeContextWindow"] = matched_preset["parameters"]["contextWindow"] if matched_preset else 200000
    if current.get("llmProvider") == "claude":
        patch["hostedLlmPresetId"] = "custom"
    if has_model_override:
        patch["claudeModel"] = model
    store.patch_settings(patch)
    return claude_public()


# DELETE /api/settings/claude — sign out: clear server-side tokens.
@router.delete("")
@router.delete("/")
async def delete_claude():
    store.clear_claude_tokens()
    return claude_public()


# POST /api/settings/claude/exchange — finish OAuth with the pasted `code#state`.
@router.post("/exchange")
async def exchange(request: Request):
    b = await json_body(request)
    parsed = claude_oauth.parse_code_input(b.get("code"))
    code = parsed["code"]
    state = parsed["state"]
    # Validate + consume the state BEFORE touching the code (CSRF / replay guard).
    login_entry = claude_oauth.consume_login(state)
    if not login_entry:
        raise AppError("Invalid or expired sign-in request. Start the sign-in again.", 403)
    if not code:
        raise AppError("Missing authorization code. Paste the full value from the Anthropic page.", 400)
    try:
        tokens = await claude_oauth.exchange_code_for_tokens(
            code=code, state=state, code_verifier=login_entry["codeVerifier"]
        )
        store.set_claude_tokens(tokens)
        logger.info("Claude OAuth sign-in complete; tokens stored server-side.")
        return claude_public()
    except Exception as err:
        detail = getattr(err, "message", None) or str(err)
        logger.error(f"Claude token exchange failed: {detail}")
        raise AppError("Could not complete the token exchange. Please start the sign-in again.", 502)


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


# POST /api/settings/claude/test — verify the token works with a tiny real call.
@router.post("/test")
async def test_claude():
    # Import lazily: the heavy LLM module may be loading in parallel / on demand.
    from ai_fleet.agent import llm

    # Refresh if needed, then exercise the real path so auth + beta header + model
    # are all validated end-to-end.
    await llm.ensure_fresh_claude_tokens()
    resolved = await llm.resolve_llm({**store.get_settings(), "llmProvider": "claude"})
    msg = await llm.create_chat_model(resolved).invoke("Reply with the single word: ok")
    if not _message_text(msg).strip():
        raise AppError("Provider returned an empty response.", 502)
    return {"ok": True, "model": _resolved_model(resolved)}


# GET /api/settings/claude/_pending — pending-login count for diagnostics/tests (no secrets).
@router.get("/_pending")
async def pending():
    return {"pending": claude_oauth.pending_count()}
