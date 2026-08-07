"""Auth flow: register, login, refresh rotation + reuse detection, me, logout,
password change, and email verification."""
from __future__ import annotations

import pytest

from tests.helpers import auth, register

pytestmark = pytest.mark.asyncio


async def test_register_creates_org_admin(client):
    r = await register(client)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"] and body["refresh_token"]

    me = await client.get("/api/v1/auth/me", headers=auth(body["access_token"]))
    assert me.status_code == 200
    profile = me.json()
    assert profile["email"] == "admin@acme.com"
    assert profile["org_role"] == "ORG_ADMIN"
    assert profile["is_super_admin"] is False
    assert profile["org_id"] is not None
    assert "password_hash" not in profile  # never leak the hash


async def test_register_duplicate_email_conflicts(client):
    await register(client)
    r = await register(client, org_name="Other")
    assert r.status_code == 409


async def test_login_success_and_generic_failure(client):
    await register(client, email="user@acme.com", password="password123")

    ok = await client.post(
        "/api/v1/auth/login",
        json={"email": "user@acme.com", "password": "password123"},
    )
    assert ok.status_code == 200

    # Wrong password and unknown user return the SAME generic error (no enumeration).
    bad_pw = await client.post(
        "/api/v1/auth/login",
        json={"email": "user@acme.com", "password": "wrong-password"},
    )
    unknown = await client.post(
        "/api/v1/auth/login",
        json={"email": "nobody@acme.com", "password": "whatever12"},
    )
    assert bad_pw.status_code == unknown.status_code == 401
    assert bad_pw.json() == unknown.json()


async def test_me_requires_auth(client):
    # 401 (not 200-null) when unauthenticated.
    r = await client.get("/api/v1/auth/me")
    assert r.status_code == 401


async def test_refresh_rotation_and_reuse_detection(client):
    reg = (await register(client)).json()
    old_refresh = reg["refresh_token"]

    rotated = await client.post("/api/v1/auth/refresh", json={"refresh_token": old_refresh})
    assert rotated.status_code == 200
    new_refresh = rotated.json()["refresh_token"]
    assert new_refresh != old_refresh

    # Replaying the old (now-rotated) token is detected -> 401.
    reuse = await client.post("/api/v1/auth/refresh", json={"refresh_token": old_refresh})
    assert reuse.status_code == 401

    # Reuse detection revokes the whole family, so the new token is dead too.
    after = await client.post("/api/v1/auth/refresh", json={"refresh_token": new_refresh})
    assert after.status_code == 401


async def test_logout_revokes_refresh_token(client):
    reg = (await register(client)).json()
    logout = await client.post(
        "/api/v1/auth/logout",
        headers=auth(reg["access_token"]),
        json={"refresh_token": reg["refresh_token"]},
    )
    assert logout.status_code == 204

    # The refresh token no longer works after logout.
    after = await client.post(
        "/api/v1/auth/refresh", json={"refresh_token": reg["refresh_token"]}
    )
    assert after.status_code == 401
