"""Shared OAuth 2.0 PKCE (S256) primitives (port of agent/pkce.js).

Provider-agnostic and pure so both OAuth flows (Codex, Claude) follow the same
checklist: PKCE S256 only, cryptographically random state.
"""

from __future__ import annotations

import base64
import hashlib
import secrets


def base64url(buf: bytes) -> str:
    """base64url with no padding (RFC 7636 §A)."""
    return base64.urlsafe_b64encode(buf).decode("ascii").rstrip("=")


def generate_verifier() -> str:
    """PKCE code verifier: 43 chars of base64url (32 random bytes)."""
    return base64url(secrets.token_bytes(32))


def challenge_from_verifier(verifier: str) -> str:
    """PKCE S256 challenge for a verifier."""
    return base64url(hashlib.sha256(verifier.encode("ascii")).digest())


def generate_state() -> str:
    """Cryptographically random, unguessable CSRF state."""
    return base64url(secrets.token_bytes(32))
