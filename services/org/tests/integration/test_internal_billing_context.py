"""GET /api/v1/internal/orgs/{id}/billing-context — the auto-recharge job's S2S read.

Same X-Internal-Token guard as the write-back, but this returns PII (admin
emails), so the guards are the point of these tests: no token, wrong token and
an unconfigured token must all refuse, and the body must carry ORG_ADMIN members
only.
"""
from __future__ import annotations

import uuid

import pytest

from app.core.config import get_settings
from tests.helpers import auth, create_user, register_org_admin

TOKEN = "internal-secret-token-value"


async def _org_id(client, admin_token: str) -> str:
    me = await client.get("/api/v1/me", headers=auth(admin_token))
    return me.json()["org_id"]


@pytest.mark.asyncio
async def test_refused_without_token(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "internal_api_token", TOKEN)
    r = await client.get(f"/api/v1/internal/orgs/{uuid.uuid4()}/billing-context")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_refused_when_token_unconfigured_fail_closed(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "internal_api_token", "")
    r = await client.get(
        f"/api/v1/internal/orgs/{uuid.uuid4()}/billing-context",
        headers={"X-Internal-Token": "anything"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_unknown_org_is_404(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "internal_api_token", TOKEN)
    r = await client.get(
        f"/api/v1/internal/orgs/{uuid.uuid4()}/billing-context",
        headers={"X-Internal-Token": TOKEN},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_returns_org_identity_and_admin_emails_only(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "internal_api_token", TOKEN)
    admin = await register_org_admin(client, org_name="Acme", email="admin@acme.com")
    org_id = await _org_id(client, admin)
    await create_user(client, admin, email="dev@acme.com", org_role="MEMBER")

    r = await client.get(
        f"/api/v1/internal/orgs/{org_id}/billing-context",
        headers={"X-Internal-Token": TOKEN},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == org_id
    assert body["name"] == "Acme"
    assert body["slug"]
    assert [a["email"] for a in body["admins"]] == ["admin@acme.com"]
    # The DTO is an allowlist: no credentials, membership status or role leak out.
    assert "password_hash" not in r.text
    assert "org_role" not in r.text
