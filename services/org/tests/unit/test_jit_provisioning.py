"""JIT provisioning of external (Firebase) identities as org-less users.

Exercises AuthContextMiddleware._provision_external_user directly (no JWKS/IdP
needed): a verified identity becomes an org-less user; unverified or
email-less identities are refused; repeats are idempotent.
"""
from __future__ import annotations

import pytest

from app.core.database import new_uow
from app.middleware.auth import AuthContextMiddleware
from app.models.enums import AuthProvider
from app.repositories.user_repo import UserRepository


def _mw() -> AuthContextMiddleware:
    return AuthContextMiddleware(app=lambda *a, **k: None)  # app is unused here


@pytest.mark.asyncio
async def test_provisions_orgless_verified_user(db_session):
    claims = {"sub": "google|123", "email": "New.User@Gmail.com", "email_verified": True, "name": "New User"}
    user = await _mw()._provision_external_user(UserRepository(new_uow()), claims, "google|123")

    assert user is not None
    assert user.org_id is None  # org-less → no tenant reach
    assert user.is_super_admin is False
    assert user.auth_provider == AuthProvider.EXTERNAL
    assert user.external_subject == "google|123"
    assert user.email == "new.user@gmail.com"  # normalized
    assert user.email_verified is True


@pytest.mark.asyncio
async def test_rejects_unverified_email(db_session):
    user = await _mw()._provision_external_user(
        UserRepository(new_uow()), {"email": "x@y.com", "email_verified": False}, "sub-1"
    )
    assert user is None
    assert await UserRepository(new_uow()).get_by_external_subject("sub-1") is None


@pytest.mark.asyncio
async def test_rejects_missing_email(db_session):
    user = await _mw()._provision_external_user(
        UserRepository(new_uow()), {"email_verified": True}, "sub-2"
    )
    assert user is None


@pytest.mark.asyncio
async def test_idempotent_under_repeat(db_session):
    claims = {"email": "dup@corp.com", "email_verified": True, "name": "Dup"}
    first = await _mw()._provision_external_user(UserRepository(new_uow()), claims, "sub-dup")
    second = await _mw()._provision_external_user(UserRepository(new_uow()), claims, "sub-dup")

    assert first is not None and second is not None
    assert first.id == second.id  # the race loser resolves to the winner
    resolved = await UserRepository(new_uow()).get_by_external_subject("sub-dup")
    assert resolved is not None and resolved.id == first.id
