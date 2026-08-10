"""PATCH /api/v1/internal/orgs/{id}/deployments — the provisioner's S2S write-back.

Guarded by a shared X-Internal-Token (fail closed when unset). It is reachable
without a user principal (the internal prefix bypasses user authn), so the token
IS the authorization.
"""
from __future__ import annotations

import uuid

import pytest

from app.core.config import get_settings
from tests.helpers import auth, register_org_admin

TOKEN = "internal-secret-token-value"


async def _org_id(client, admin_token: str) -> str:
    me = await client.get("/api/v1/me", headers=auth(admin_token))
    return me.json()["org_id"]


@pytest.mark.asyncio
async def test_refused_without_token_even_when_configured(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "internal_api_token", TOKEN)
    r = await client.patch(
        f"/api/v1/internal/orgs/{uuid.uuid4()}/deployments",
        json={"deployments": {"status": "provisioned"}},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_refused_when_token_unconfigured_fail_closed(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "internal_api_token", "")
    r = await client.patch(
        f"/api/v1/internal/orgs/{uuid.uuid4()}/deployments",
        json={"deployments": {"status": "provisioned"}},
        headers={"X-Internal-Token": "anything"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_writes_deployments_and_resolver_reflects_it(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "internal_api_token", TOKEN)
    admin = await register_org_admin(client, org_name="Acme", email="admin@acme.com")
    org_id = await _org_id(client, admin)

    r = await client.patch(
        f"/api/v1/internal/orgs/{org_id}/deployments",
        json={"deployments": {"status": "provisioned", "gateway": {"url": "https://gw-tabc.run.app", "status": "provisioned"}}},
        headers={"X-Internal-Token": TOKEN},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ok"

    # The deployment resolver now reports the per-tenant gateway.
    d = await client.get("/api/v1/me/deployment", headers=auth(admin))
    assert d.json()["status"] == "provisioned"
    assert d.json()["gateway_url"] == "https://gw-tabc.run.app"


@pytest.mark.asyncio
async def test_unknown_org_is_404(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "internal_api_token", TOKEN)
    r = await client.patch(
        f"/api/v1/internal/orgs/{uuid.uuid4()}/deployments",
        json={"deployments": {"status": "provisioned"}},
        headers={"X-Internal-Token": TOKEN},
    )
    assert r.status_code == 404
