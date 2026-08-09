"""GET /api/v1/me/deployment — the server-authoritative deployment resolver.

Verifies it derives the org from the token (no client org id), returns only the
browser-facing gateway URL, and maps the org's deployment status
(shared/provisioning/provisioned) correctly.
"""
from __future__ import annotations

import pytest

from app.core.database import new_uow
from app.repositories.base import ORGS
from tests.helpers import auth, register_org_admin


async def _org_id(client, token: str) -> str:
    me = await client.get("/api/v1/me", headers=auth(token))
    assert me.status_code == 200, me.text
    return me.json()["org_id"]


async def _set_deployments(org_id: str, deployments: dict) -> None:
    uow = new_uow()
    doc = await uow.db.get(ORGS, org_id)
    await uow.db.set(ORGS, org_id, {**doc, "deployments": deployments})


@pytest.mark.asyncio
async def test_requires_authentication(client):
    resp = await client.get("/api/v1/me/deployment")
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_org_member_defaults_to_shared(client):
    token = await register_org_admin(client, org_name="Acme", email="admin@acme.com")
    resp = await client.get("/api/v1/me/deployment", headers=auth(token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "shared"
    assert body["gateway_url"] == ""  # SHARED_GATEWAY_URL unset in tests → same-origin
    assert body["org_name"] == "Acme"
    # Never leaks internal service URLs to the browser.
    assert set(body.keys()) <= {"status", "gateway_url", "org_id", "org_name"}


@pytest.mark.asyncio
async def test_provisioned_org_returns_tenant_gateway(client):
    token = await register_org_admin(client, org_name="Acme", email="admin@acme.com")
    org_id = await _org_id(client, token)
    await _set_deployments(
        org_id,
        {"status": "provisioned", "gateway": {"name": "gw-tabc", "url": "https://gw-tabc.run.app", "status": "provisioned"}},
    )

    resp = await client.get("/api/v1/me/deployment", headers=auth(token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "provisioned"
    assert body["gateway_url"] == "https://gw-tabc.run.app"


@pytest.mark.asyncio
async def test_provisioning_org_stays_on_shared(client):
    token = await register_org_admin(client, org_name="Acme", email="admin@acme.com")
    org_id = await _org_id(client, token)
    await _set_deployments(org_id, {"status": "provisioning", "gateway": {"name": "gw-tabc"}})

    resp = await client.get("/api/v1/me/deployment", headers=auth(token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "provisioning"
    # SPA keeps using / polling the shared gateway while the stack comes up.
    assert body["gateway_url"] == ""
