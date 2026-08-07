"""External OIDC/OAuth2 bearer-token verification (JWKS).

Security notes (oauth-oidc.md):
- Signature verified with the IdP's public key fetched via JWKS (cached).
- Algorithm restricted to RS* — using only the JWKS public key makes RS->HS
  algorithm-confusion impossible.
- `iss` and `aud` validated by exact match against configured values.
- The `iss` from the token is never trusted for anything except selecting this
  validator upstream; here it must equal the configured issuer exactly.
"""
from __future__ import annotations

import jwt
from jwt import PyJWKClient

from app.core.config import get_settings

_ALLOWED_ALGS = ["RS256", "RS384", "RS512"]

_jwks_client: PyJWKClient | None = None


def _client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        settings = get_settings()
        _jwks_client = PyJWKClient(settings.idp_jwks_url, cache_keys=True)
    return _jwks_client


def reset_client() -> None:
    """Reset the cached JWKS client (used by tests / config reloads)."""
    global _jwks_client
    _jwks_client = None


def is_idp_issuer(issuer: str | None) -> bool:
    settings = get_settings()
    return bool(settings.idp_enabled and issuer and issuer == settings.idp_issuer)


def decode_idp_token(token: str) -> dict:
    """Verify and decode an external IdP token. Raises jwt.PyJWTError on failure."""
    settings = get_settings()
    if not settings.idp_enabled:
        raise jwt.InvalidTokenError("external IdP not enabled")
    signing_key = _client().get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=_ALLOWED_ALGS,
        audience=settings.idp_audience,
        issuer=settings.idp_issuer,
        options={"require": ["exp", "iss", "aud", "sub"]},
    )
