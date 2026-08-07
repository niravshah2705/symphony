"""External IdP validator selection and fail-closed behavior."""
from __future__ import annotations

import jwt
import pytest

from app.auth import idp
from app.core.config import get_settings


def test_is_idp_issuer_false_when_disabled():
    assert idp.is_idp_issuer("https://issuer.example.com") is False
    assert idp.is_idp_issuer(None) is False


def test_decode_idp_token_raises_when_disabled():
    with pytest.raises(jwt.InvalidTokenError):
        idp.decode_idp_token("any.token.value")


def test_is_idp_issuer_exact_match(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "idp_enabled", True)
    monkeypatch.setattr(settings, "idp_issuer", "https://issuer.example.com")

    assert idp.is_idp_issuer("https://issuer.example.com") is True
    # No prefix / substring matching — lookalikes are rejected.
    assert idp.is_idp_issuer("https://issuer.example.com.evil.com") is False
    assert idp.is_idp_issuer("https://issuer.example") is False
