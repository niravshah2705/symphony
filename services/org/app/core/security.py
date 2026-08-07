"""Password hashing and opaque-token helpers.

Passwords use Argon2 (passlib). Refresh tokens are random opaque strings; only
their SHA-256 hash is persisted (cryptography-secrets.md — never store raw
secrets). Org slugs are CSPRNG-derived so they cannot be guessed from a name.
"""
from __future__ import annotations

import hashlib
import secrets

from passlib.context import CryptContext

_pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")


def hash_password(password: str) -> str:
    return _pwd_context.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    """Verify a password against a stored hash. Returns False on any error
    (e.g. user has no local password) rather than raising."""
    if not password_hash:
        return False
    try:
        return _pwd_context.verify(password, password_hash)
    except Exception:
        return False


def generate_opaque_token(nbytes: int = 48) -> str:
    """Generate a URL-safe random token (used as a refresh token)."""
    return secrets.token_urlsafe(nbytes)


def hash_token(raw: str) -> str:
    """Deterministic hash for looking up an opaque token without storing it."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def generate_org_slug() -> str:
    """Opaque, unguessable organization slug (not derived from the org name)."""
    return secrets.token_urlsafe(12)


def generate_verification_token() -> str:
    """Single-use email verification token."""
    return secrets.token_urlsafe(32)
