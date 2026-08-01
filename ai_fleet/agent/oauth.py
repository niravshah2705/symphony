"""OAuth 2.0 Authorization Code + PKCE (S256) for the Codex (OpenAI) provider.

Port of ``packages/shared/src/agent/oauth.js``. Follows the oauth-oidc checklist:
  - PKCE with S256 only (no ``plain``).
  - ``state`` is cryptographically random, server-generated, single-use, and
    short-lived (the pending-login map is the server-side binding for this
    single-user local tool — an attacker cannot forge a state we never issued).
  - redirect_uri is server-derived (never from the request) and reused
    exact-match in the code exchange.
  - authorization codes are single-use (the provider enforces this; we also
    delete the pending login on first callback).
  - refresh tokens are rotated: a new refresh_token in the response replaces
    the old one.

Provider endpoint URLs and client id come from trusted server-side config
(``CONFIG.OAUTH``), never from user input. The Codex token endpoint is
FORM-encoded (``application/x-www-form-urlencoded``).
"""

from __future__ import annotations

import base64
import json
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from ai_fleet import util
from ai_fleet.config import CONFIG

# PKCE primitives are shared across providers (see ./pkce). Re-exported below so
# callers/tests can use ``oauth.generate_verifier`` etc. like the JS module did.
from ai_fleet.agent.pkce import (  # noqa: F401  (re-exported)
    base64url,
    challenge_from_verifier,
    generate_state,
    generate_verifier,
)

OAUTH = CONFIG.OAUTH

_TOKEN_TIMEOUT_S = 15.0
_DEFAULT_EXPIRES_MS = 3600 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


# --------------------- pending login (state) registry ------------------- #
# state -> { "codeVerifier", "redirectUri", "expiresAt" }. Single-use, short-lived.
pending_logins: dict = {}


def prune_pending(now: int | None = None) -> None:
    if now is None:
        now = _now_ms()
    expired = [state for state, entry in pending_logins.items() if entry["expiresAt"] <= now]
    for state in expired:
        pending_logins.pop(state, None)


def create_login() -> dict:
    """Begin a login: generate state + PKCE, register them, return authorize URL."""
    prune_pending()
    state = generate_state()
    code_verifier = generate_verifier()
    code_challenge = challenge_from_verifier(code_verifier)
    redirect_uri = OAUTH.redirectUri
    pending_logins[state] = {
        "codeVerifier": code_verifier,
        "redirectUri": redirect_uri,
        "expiresAt": _now_ms() + OAUTH.loginTtlMs,
    }
    return {
        "state": state,
        "authorizeUrl": build_authorize_url(
            state=state, code_challenge=code_challenge, redirect_uri=redirect_uri
        ),
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


def build_authorize_url(*, state: str, code_challenge: str, redirect_uri: str) -> str:
    """Build the provider authorization URL (S256 PKCE + state)."""
    params = {
        "response_type": "code",
        "client_id": OAUTH.clientId,
        "redirect_uri": redirect_uri,
        "scope": OAUTH.scope,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    parts = urlsplit(OAUTH.authorizeUrl)
    merged = dict(parse_qsl(parts.query))
    merged.update(params)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(merged), parts.fragment))


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
    prev_id = previous.get("idToken") if previous else None
    prev_scope = previous.get("scope") if previous else None
    return {
        "accessToken": json_body.get("access_token") or "",
        # Rotation: keep the old refresh token only if the provider didn't issue one.
        "refreshToken": json_body.get("refresh_token") or prev_refresh or "",
        "idToken": json_body.get("id_token") or prev_id or "",
        "tokenType": json_body.get("token_type") or "Bearer",
        "scope": json_body.get("scope") or prev_scope or OAUTH.scope,
        "expiresAt": now + int(expires_in * 1000) if expires_in is not None else now + _DEFAULT_EXPIRES_MS,
        "obtainedAt": now,
    }


async def post_token(params: dict, client: httpx.AsyncClient | None = None) -> dict:
    """POST to the FORM-encoded token endpoint. ``client`` is an injectable seam."""
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
    }
    if client is None:
        async with httpx.AsyncClient(timeout=_TOKEN_TIMEOUT_S) as owned:
            resp = await owned.post(OAUTH.tokenUrl, headers=headers, data=params)
    else:
        resp = await client.post(OAUTH.tokenUrl, headers=headers, data=params)

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
    *, code: str, code_verifier: str, redirect_uri: str, client: httpx.AsyncClient | None = None
) -> dict:
    """Exchange an authorization code (bound to the same redirect_uri + verifier)."""
    body = await post_token(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": OAUTH.clientId,
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
            "client_id": OAUTH.clientId,
            "scope": OAUTH.scope,
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
    return tokens["expiresAt"] - OAUTH.refreshSkewMs <= now


def _b64url_decode(data: str) -> bytes:
    """Decode base64url (JS ``Buffer.from(x, 'base64url')``) with padding fixup."""
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def account_id_from_id_token(id_token) -> str:
    """Extract the ChatGPT account id from the OIDC id_token.

    The ChatGPT-plan Codex backend requires this as a ``chatgpt-account-id``
    header. The claim lives under the ``https://api.openai.com/auth`` namespaced
    claim. Returns '' when absent or the token is not a decodable JWT — never
    throws (the caller decides).
    """
    parts = str(id_token or "").split(".")
    if len(parts) != 3:
        return ""
    try:
        payload = json.loads(_b64url_decode(parts[1]).decode("utf-8"))
        auth = payload.get("https://api.openai.com/auth") or {}
        return auth.get("chatgpt_account_id") or ""
    except Exception:
        return ""
