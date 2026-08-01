"""Gateway authentication (port of services/gateway/src/auth.js).

Two modes. `disabled` (local dev) passes through with an unauthenticated marker.
`istio` fails closed: it reads a base64 header that Envoy populates with a
verified Auth0 payload, and validates the copied claims again. The gateway never
accepts or verifies bearer credentials itself — the trust boundary is Envoy.
"""

from __future__ import annotations

import base64
import json
import re
import time

from starlette.requests import Request
from starlette.responses import JSONResponse

from ai_fleet.config import CONFIG

MAX_PAYLOAD_BYTES = 16 * 1024
CLOCK_SKEW_SECONDS = 60

_BASE64_RE = re.compile(r"^[A-Za-z0-9_+/=-]+$")
_BAD_CHARS_RE = re.compile(r"[\r\n\0]")


class _AuthError(Exception):
    def __init__(self, message, status=401, code="authentication_required"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def _auth_error(message):
    return _AuthError(message, 401, "authentication_required")


def _authorization_error(message):
    return _AuthError(message, 403, "access_denied")


def decode_verified_payload(value):
    encoded = str(value or "").strip()
    if not encoded or len(encoded) > MAX_PAYLOAD_BYTES * 2 or not _BASE64_RE.match(encoded):
        raise _auth_error("Authentication payload is missing or malformed")
    try:
        # tolerate urlsafe/base64 (JS Buffer.from(x,'base64') accepts both -/+ etc.)
        padded = encoded + "=" * (-len(encoded) % 4)
        decoded = base64.b64decode(padded.replace("-", "+").replace("_", "/")).decode("utf-8")
    except Exception:
        raise _auth_error("Authentication payload is malformed")
    if not decoded or len(decoded.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise _auth_error("Authentication payload is malformed")
    try:
        claims = json.loads(decoded)
    except Exception:
        raise _auth_error("Authentication payload is malformed")
    if not claims or not isinstance(claims, dict):
        raise _auth_error("Authentication payload is malformed")
    return claims


def _bounded_claim(value, max_length=320):
    if not isinstance(value, str):
        return ""
    normalized = value.strip()
    if not normalized or len(normalized) > max_length or _BAD_CHARS_RE.search(normalized):
        return ""
    return normalized


def _claim_audience_includes(claim, expected):
    if isinstance(claim, str):
        return claim == expected
    return isinstance(claim, list) and any(v == expected for v in claim)


def _is_finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def identity_from_claims(claims, config=None, now_ms=None):
    config = config or CONFIG.AUTH
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    if not config or getattr(config, "mode", None) != "istio":
        raise _auth_error("Authentication is not configured")
    if claims.get("iss") != config.issuer:
        raise _auth_error("Authentication issuer does not match")
    if not _claim_audience_includes(claims.get("aud"), config.audience):
        raise _auth_error("Authentication audience does not match")
    if config.organization and claims.get("org_id") != config.organization:
        raise _auth_error("Authentication organization does not match")

    now_seconds = now_ms // 1000
    exp = claims.get("exp")
    if not _is_finite(exp) or exp <= now_seconds - CLOCK_SKEW_SECONDS:
        raise _auth_error("Authentication has expired")
    nbf = claims.get("nbf")
    if _is_finite(nbf) and nbf > now_seconds + CLOCK_SKEW_SECONDS:
        raise _auth_error("Authentication is not active yet")

    sub = _bounded_claim(claims.get("sub"), 512)
    if not sub:
        raise _auth_error("Authentication subject is missing")

    permissions = []
    if isinstance(claims.get("permissions"), list):
        permissions = [v for v in (_bounded_claim(x, 160) for x in claims["permissions"]) if v][:100]
    scopes = []
    if isinstance(claims.get("scope"), str):
        scopes = [v for v in (_bounded_claim(x, 160) for x in re.split(r"\s+", claims["scope"])) if v][:100]
    if config.requiredPermission and config.requiredPermission not in permissions:
        raise _authorization_error(f"Required permission is missing: {config.requiredPermission}")

    return {
        "sub": sub,
        "name": _bounded_claim(claims.get("name") or claims.get("nickname"), 320),
        "email": _bounded_claim(claims.get("email"), 320),
        "organizationId": _bounded_claim(claims.get("org_id"), 320),
        "permissions": list(dict.fromkeys(permissions)),
        "scopes": list(dict.fromkeys(scopes)),
    }


def _deny_access(error):
    status = 403 if getattr(error, "status", None) == 403 else 401
    headers = {"Cache-Control": "no-store"}
    if status == 401:
        headers["WWW-Authenticate"] = 'Bearer realm="AI Fleet"'
    return JSONResponse(
        status_code=status,
        headers=headers,
        content={
            "error": getattr(error, "message", None) or ("Access denied" if status == 403 else "Authentication required"),
            "code": getattr(error, "code", None) or ("access_denied" if status == 403 else "authentication_required"),
        },
    )


# Public paths that must be reachable before authentication (mounted ahead of the
# boundary in the JS gateway).
_PUBLIC_PATHS = {"/healthz", "/api/auth/config"}


def _is_public(path: str) -> bool:
    return path in _PUBLIC_PATHS or path.startswith("/vendor/") or not path.startswith("/api")


def create_authentication_middleware(config=None):
    config = config or CONFIG.AUTH

    async def middleware(request: Request, call_next):
        path = request.url.path
        if not config.enabled or getattr(config, "mode", None) == "disabled":
            request.state.auth = {"mode": "disabled", "authenticated": False, "user": None}
            return await call_next(request)
        if _is_public(path):
            request.state.auth = {"mode": config.mode, "authenticated": False, "user": None}
            return await call_next(request)
        if request.method == "OPTIONS":
            request.state.auth = {"mode": config.mode, "authenticated": False, "user": None}
            return await call_next(request)
        try:
            claims = decode_verified_payload(request.headers.get(config.payloadHeader))
            user = identity_from_claims(claims, config)
            request.state.auth = {"mode": config.mode, "authenticated": True, "user": user}
        except _AuthError as error:
            return _deny_access(error)
        return await call_next(request)

    return middleware


def public_auth_config(config=None):
    config = config or CONFIG.AUTH
    if not config.enabled:
        return {"mode": "disabled", "enabled": False}
    auth0 = {
        "domain": config.domain,
        "clientId": config.clientId,
        "audience": config.audience,
        "redirectUri": config.redirectUri,
        "logoutReturnTo": config.logoutReturnTo,
        "scope": config.scope,
    }
    if config.organization:
        auth0["organization"] = config.organization
    return {"mode": config.mode, "enabled": True, "provider": config.provider, "auth0": auth0}
