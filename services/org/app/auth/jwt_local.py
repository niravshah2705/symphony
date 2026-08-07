"""Self-issued (local) JWT access tokens.

Security notes (authentication-failures.md / oauth-oidc.md):
- Signing algorithm is pinned on decode (no `alg: none`, no RS/HS confusion).
- `exp`, `iat`, `iss`, `aud` are all required and validated.
- `token_type` must be "access"; refresh tokens are opaque (not JWTs).
- The secret comes from configuration/env, never hardcoded.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import jwt

from app.core.config import get_settings

TOKEN_TYPE_ACCESS = "access"


def create_access_token(
    *,
    user_id: uuid.UUID,
    org_id: uuid.UUID | None,
    org_role: str,
    is_super_admin: bool,
    email: str,
) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "org_id": str(org_id) if org_id else None,
        "org_role": org_role,
        "is_super_admin": is_super_admin,
        "email": email,
        "token_type": TOKEN_TYPE_ACCESS,
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_ttl_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    """Verify and decode a local access token. Raises jwt.PyJWTError on failure."""
    settings = get_settings()
    claims = jwt.decode(
        token,
        settings.jwt_secret,
        algorithms=[settings.jwt_algorithm],
        audience=settings.jwt_audience,
        issuer=settings.jwt_issuer,
        options={"require": ["exp", "iat", "iss", "aud", "sub"]},
    )
    if claims.get("token_type") != TOKEN_TYPE_ACCESS:
        raise jwt.InvalidTokenError("not an access token")
    return claims


def get_unverified_issuer(token: str) -> str | None:
    """Read `iss` WITHOUT verifying the signature.

    Used ONLY to choose which validator to run — never trusted for
    authorization decisions.
    """
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
        return claims.get("iss")
    except jwt.PyJWTError:
        return None
