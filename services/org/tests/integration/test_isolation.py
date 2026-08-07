"""Cross-organization isolation and the super-admin authorization boundary."""
from __future__ import annotations

import pytest

from tests.helpers import (
    auth,
    create_project,
    create_super_admin,
    login,
    register_org_admin,
)

pytestmark = pytest.mark.asyncio


async def test_cross_org_project_access_returns_404(client):
    admin_a = await register_org_admin(client, org_name="A", email="a@a.com")
    project_a = await create_project(client, admin_a, name="A-Project")

    admin_b = await register_org_admin(client, org_name="B", email="b@b.com")
    # B cannot see A's project even with a valid, known id -> 404.
    assert (await client.get(f"/api/v1/projects/{project_a}", headers=auth(admin_b))).status_code == 404
    # B cannot patch or delete it either.
    assert (
        await client.patch(
            f"/api/v1/projects/{project_a}", headers=auth(admin_b), json={"name": "x"}
        )
    ).status_code == 404


async def test_org_listings_are_scoped(client):
    admin_a = await register_org_admin(client, org_name="A", email="a@a.com")
    await create_project(client, admin_a, name="A1")
    admin_b = await register_org_admin(client, org_name="B", email="b@b.com")

    a_users = await client.get("/api/v1/users", headers=auth(admin_a))
    b_users = await client.get("/api/v1/users", headers=auth(admin_b))
    assert a_users.json()["meta"]["total"] == 1
    assert b_users.json()["meta"]["total"] == 1

    a_org = await client.get("/api/v1/organizations/current", headers=auth(admin_a))
    b_org = await client.get("/api/v1/organizations/current", headers=auth(admin_b))
    assert a_org.json()["name"] == "A"
    assert b_org.json()["name"] == "B"
    assert a_org.json()["id"] != b_org.json()["id"]


async def test_cross_org_tag_cannot_be_attached(client):
    admin_a = await register_org_admin(client, org_name="A", email="a@a.com")
    tag_a = (
        await client.post("/api/v1/tags", headers=auth(admin_a), json={"name": "shared"})
    ).json()["id"]

    admin_b = await register_org_admin(client, org_name="B", email="b@b.com")
    project_b = await create_project(client, admin_b, name="B-Project")

    # B tries to attach A's tag to B's project -> rejected (tag not in B's org).
    resp = await client.post(
        f"/api/v1/projects/{project_b}/tags",
        headers=auth(admin_b),
        json={"tag_id": tag_a},
    )
    assert resp.status_code == 422


async def test_super_admin_can_manage_orgs_but_org_admin_cannot(client):
    email = await create_super_admin("root@platform.com")
    root = await login(client, email)

    # Super-admin creates an org and its first admin.
    created = await client.post(
        "/api/v1/organizations",
        headers=auth(root),
        json={
            "name": "Provisioned",
            "admin_email": "owner@prov.com",
            "admin_password": "password123",
        },
    )
    assert created.status_code == 201
    org_id = created.json()["id"]

    # Super-admin can list and fetch any org.
    listing = await client.get("/api/v1/organizations", headers=auth(root))
    assert listing.status_code == 200
    assert listing.json()["meta"]["total"] >= 1
    assert (await client.get(f"/api/v1/organizations/{org_id}", headers=auth(root))).status_code == 200

    # The provisioned org-admin can log in.
    await login(client, "owner@prov.com")

    # A regular org admin is forbidden from all cross-org platform routes.
    org_admin = await register_org_admin(client, org_name="Regular", email="reg@reg.com")
    assert (
        await client.post("/api/v1/organizations", headers=auth(org_admin), json={"name": "Nope"})
    ).status_code == 403
    assert (await client.get("/api/v1/organizations", headers=auth(org_admin))).status_code == 403
    assert (
        await client.get(f"/api/v1/organizations/{org_id}", headers=auth(org_admin))
    ).status_code == 403
