"""Claude (Anthropic) OAuth 2.0 Authorization Code + PKCE (S256) helper.

Port of ``packages/shared/src/agent/claude-oauth.js`` — "Sign in with Claude"
via the public Claude Code client.

oauth-oidc checklist:
  - PKCE S256 only (no ``plain``).
  - ``state`` is cryptographically random, server-generated, single-use, short
    lived; the pending-login map is the server-side binding (an attacker cannot
    forge a state we never issued).
  - redirect_uri is trusted server-side config, reused exact-match in exchange.
  - authorization codes are single-use (provider-enforced; we also delete the
    pending login on first exchange).
  - refresh tokens rotate: a new refresh_token in the response replaces the old.

Provider endpoint URLs + client id come from ``CONFIG.CLAUDE``, never user input.
The Claude token endpoint is JSON-bodied. There is no id_token.

Flow shape: the redirect target is Anthropic's hosted "copy this code" page,
which returns the value as ``code#state``. The operator pastes that back; we
split it, validate the state, and exchange.
"""

from __future__ import annotations

import json
import re
import time
from urllib.parse import parse_qs, urlsplit

import httpx

from ai_fleet import util
from ai_fleet.config import CONFIG
from ai_fleet.agent import pkce

CLAUDE = CONFIG.CLAUDE

_TOKEN_TIMEOUT_S = 15.0
_DEFAULT_EXPIRES_MS = 3600 * 1000

_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def _now_ms() -> int:
    return int(time.time() * 1000)


# --------------------- pending login (state) registry ------------------- #
# state -> { "codeVerifier", "expiresAt" }. Single-use, short-lived.
pending_logins: dict = {}


def prune_pending(now: int | None = None) -> None:
    if now is None:
        now = _now_ms()
    expired = [state for state, entry in pending_logins.items() if entry["expiresAt"] <= now]
    for state in expired:
        pending_logins.pop(state, None)


def build_authorize_url(*, state: str, code_challenge: str) -> str:
    """Build the provider authorization URL (S256 PKCE + state)."""
    from urllib.parse import parse_qsl, urlencode, urlunsplit

    params = {
        "response_type": "code",
        "client_id": CLAUDE.clientId,
        "redirect_uri": CLAUDE.redirectUri,
        "scope": CLAUDE.scope,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    parts = urlsplit(CLAUDE.authorizeUrl)
    merged = dict(parse_qsl(parts.query))
    merged.update(params)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(merged), parts.fragment))


def create_login() -> dict:
    """Begin a login: generate state + PKCE, register them, return authorize URL."""
    prune_pending()
    state = pkce.generate_state()
    code_verifier = pkce.generate_verifier()
    code_challenge = pkce.challenge_from_verifier(code_verifier)
    pending_logins[state] = {
        "codeVerifier": code_verifier,
        "expiresAt": _now_ms() + CLAUDE.loginTtlMs,
    }
    return {
        "state": state,
        "authorizeUrl": build_authorize_url(state=state, code_challenge=code_challenge),
    }


def consume_login(state):
    """Validate and consume a state (single-use). Returns the login entry or None."""
    prune_pending()
    if not state or not isinstance(state, str):
        return None
    entry = pending_logins.get(state)
    if not entry:
        return None
    del pending_logins[state]  # single-use
    if entry["expiresAt"] <= _now_ms():
        return None
    return entry


def pending_count() -> int:
    """Test seam: current number of pending logins."""
    prune_pending()
    return len(pending_logins)


def parse_code_input(raw) -> dict:
    """Parse the operator-pasted value.

    Anthropic's callback returns ``code#state``; we also tolerate a bare code or
    a full callback URL with query params.
    """
    text = str(raw or "").strip()
    if not text:
        return {"code": "", "state": ""}
    # Full URL pasted: pull code/state from the query string.
    if _URL_RE.match(text):
        try:
            qs = parse_qs(urlsplit(text).query)
            return {
                "code": (qs.get("code") or [""])[0],
                "state": (qs.get("state") or [""])[0],
            }
        except Exception:
            pass  # fall through to hash parsing
    segments = text.split("#")
    code = segments[0]
    state = segments[1] if len(segments) > 1 else ""
    return {"code": code.strip(), "state": state.strip()}


def _coerce_number(value):
    """Mirror JS ``Number(x)`` + ``Number.isFinite``: returns a finite float or None."""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num != num or num in (float("inf"), float("-inf")):
        return None
    return num


def normalize_token_response(json_body: dict, previous: dict | None = None) -> dict:
    """Normalize a raw token endpoint response into our stored shape."""
    expires_in = _coerce_number(json_body.get("expires_in"))
    now = _now_ms()
    prev_refresh = previous.get("refreshToken") if previous else None
    prev_scope = previous.get("scope") if previous else None
    return {
        "accessToken": json_body.get("access_token") or "",
        # Rotation: keep the old refresh token only if the provider didn't issue one.
        "refreshToken": json_body.get("refresh_token") or prev_refresh or "",
        "tokenType": json_body.get("token_type") or "Bearer",
        "scope": json_body.get("scope") or prev_scope or CLAUDE.scope,
        "expiresAt": now + int(expires_in * 1000) if expires_in is not None else now + _DEFAULT_EXPIRES_MS,
        "obtainedAt": now,
    }


async def post_token(payload: dict, client: httpx.AsyncClient | None = None) -> dict:
    """POST to the JSON-bodied token endpoint. ``client`` is an injectable seam."""
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if client is None:
        async with httpx.AsyncClient(timeout=_TOKEN_TIMEOUT_S) as owned:
            resp = await owned.post(CLAUDE.tokenUrl, headers=headers, json=payload)
    else:
        resp = await client.post(CLAUDE.tokenUrl, headers=headers, json=payload)

    text = resp.text
    try:
        body = json.loads(text)
    except Exception:
        body = {}
    if not (200 <= resp.status_code < 300):
        detail = (
            body.get("error_description")
            or body.get("error")
            or text[:200]
            or f"HTTP {resp.status_code}"
        )
        raise util.AppError(f"Token endpoint error: {detail}", status=502)
    return body


async def exchange_code_for_tokens(
    *, code: str, state: str, code_verifier: str, client: httpx.AsyncClient | None = None
) -> dict:
    """Exchange an authorization code (bound to the issued verifier + state)."""
    body = await post_token(
        {
            "grant_type": "authorization_code",
            "code": code,
            "state": state,
            "client_id": CLAUDE.clientId,
            "redirect_uri": CLAUDE.redirectUri,
            "code_verifier": code_verifier,
        },
        client=client,
    )
    return normalize_token_response(body)


async def refresh_tokens(previous: dict | None, client: httpx.AsyncClient | None = None) -> dict:
    """Refresh an access token; rotates the refresh token when a new one is issued."""
    if not previous or not previous.get("refreshToken"):
        raise util.AppError("No refresh token available; sign in again.", status=401)
    body = await post_token(
        {
            "grant_type": "refresh_token",
            "refresh_token": previous["refreshToken"],
            "client_id": CLAUDE.clientId,
        },
        client=client,
    )
    return normalize_token_response(body, previous)


def is_expired(tokens: dict | None, now: int | None = None) -> bool:
    """True when a token set is missing or within the refresh-skew of expiry."""
    if now is None:
        now = _now_ms()
    if not tokens or not tokens.get("accessToken"):
        return True
    return tokens["expiresAt"] - CLAUDE.refreshSkewMs <= now
