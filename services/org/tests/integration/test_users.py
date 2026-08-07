"""User management + authorization: admin-only creation/listing, self-service
field enforcement, and password-change session invalidation."""
from __future__ import annotations

import pytest

from tests.helpers import auth, create_user_and_login, login, register_org_admin

pytestmark = pytest.mark.asyncio


async def test_org_admin_can_create_and_list_users(client):
    admin = await register_org_admin(client)
    r = await client.post(
        "/api/v1/users",
        headers=auth(admin),
        json={"email": "dev@acme.com", "password": "password123", "org_role": "MEMBER"},
    )
    assert r.status_code == 201
    assert "password_hash" not in r.json()

    listing = await client.get("/api/v1/users", headers=auth(admin))
    assert listing.status_code == 200
    assert listing.json()["meta"]["total"] == 2  # admin + new user


async def test_member_cannot_create_or_list_users(client):
    admin = await register_org_admin(client)
    _, member = await create_user_and_login(client, admin, email="m@acme.com")

    assert (await client.get("/api/v1/users", headers=auth(member))).status_code == 403
    created = await client.post(
        "/api/v1/users",
        headers=auth(member),
        json={"email": "x@acme.com", "password": "password123"},
    )
    assert created.status_code == 403


async def test_member_cannot_self_promote(client):
    admin = await register_org_admin(client)
    uid, member = await create_user_and_login(client, admin, email="m@acme.com")

    # Attempting to elevate own role or reactivate is forbidden for non-admins.
    resp = await client.patch(
        f"/api/v1/users/{uid}",
        headers=auth(member),
        json={"org_role": "ORG_ADMIN"},
    )
    assert resp.status_code == 403

    # But updating own profile field is allowed.
    ok = await client.patch(
        f"/api/v1/users/{uid}", headers=auth(member), json={"full_name": "New Name"}
    )
    assert ok.status_code == 200
    assert ok.json()["full_name"] == "New Name"


async def test_change_password_invalidates_tokens(client):
    admin = await register_org_admin(client)
    uid, member = await create_user_and_login(client, admin, email="pw@acme.com")

    # Wrong current password is rejected.
    bad = await client.post(
        f"/api/v1/users/{uid}/change-password",
        headers=auth(member),
        json={"current_password": "wrong", "new_password": "newpassword123"},
    )
    assert bad.status_code == 422

    ok = await client.post(
        f"/api/v1/users/{uid}/change-password",
        headers=auth(member),
        json={"current_password": "password123", "new_password": "newpassword123"},
    )
    assert ok.status_code == 204

    # Old access token issued before the change is now rejected.
    me = await client.get("/api/v1/auth/me", headers=auth(member))
    assert me.status_code == 401
    # New credentials work.
    await login(client, "pw@acme.com", "newpassword123")


async def test_cannot_change_another_users_password(client):
    admin = await register_org_admin(client)
    other_uid, _ = await create_user_and_login(client, admin, email="other@acme.com")
    _, member = await create_user_and_login(client, admin, email="me@acme.com")

    resp = await client.post(
        f"/api/v1/users/{other_uid}/change-password",
        headers=auth(member),
        json={"current_password": "password123", "new_password": "newpassword123"},
    )
    assert resp.status_code == 403


async def test_deactivated_user_loses_access(client):
    admin = await register_org_admin(client)
    uid, member = await create_user_and_login(client, admin, email="gone@acme.com")

    # Deactivate via admin DELETE.
    assert (await client.delete(f"/api/v1/users/{uid}", headers=auth(admin))).status_code == 204
    # The user's existing token no longer authenticates.
    assert (await client.get("/api/v1/auth/me", headers=auth(member))).status_code == 401
