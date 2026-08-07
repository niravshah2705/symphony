"""End-to-end lifecycle across the whole API surface.

register -> tags -> org tags -> project -> members -> tasks (+tags) ->
updates/deletes -> email verification -> super-admin org lifecycle.
"""
from __future__ import annotations

import pytest

from tests.helpers import (
    add_member,
    auth,
    create_super_admin,
    create_user_and_login,
    login,
    register_org_admin,
)

pytestmark = pytest.mark.asyncio


async def test_full_lifecycle(client):
    admin = await register_org_admin(client, org_name="Acme", email="admin@acme.com")

    # --- Tag vocabulary + org-applied tags ---
    tag_ids = {}
    for name in ("backend", "frontend", "ci-cd"):
        r = await client.post("/api/v1/tags", headers=auth(admin), json={"name": name})
        assert r.status_code == 201
        tag_ids[name] = r.json()["id"]

    put = await client.put(
        "/api/v1/organizations/current/tags",
        headers=auth(admin),
        json=[tag_ids["backend"], tag_ids["frontend"]],
    )
    assert put.status_code == 200 and len(put.json()) == 2
    detach = await client.delete(
        f"/api/v1/organizations/current/tags/{tag_ids['frontend']}", headers=auth(admin)
    )
    assert detach.status_code == 204
    org_tags = await client.get("/api/v1/organizations/current/tags", headers=auth(admin))
    assert [t["name"] for t in org_tags.json()] == ["backend"]

    # --- Project + members ---
    project = (
        await client.post("/api/v1/projects", headers=auth(admin), json={"name": "Platform"})
    ).json()["id"]

    dev_id, dev = await create_user_and_login(client, admin, email="dev@acme.com")
    lead_id, lead = await create_user_and_login(client, admin, email="lead@acme.com")
    assert (await add_member(client, admin, project, dev_id, "DEVELOPER")).status_code == 201
    assert (await add_member(client, admin, project, lead_id, "TEAM_LEAD")).status_code == 201

    members = await client.get(f"/api/v1/projects/{project}/members", headers=auth(lead))
    assert {m["role"] for m in members.json()} == {"DEVELOPER", "TEAM_LEAD"}

    # Promote the lead to PROJECT_ADMIN, then remove them.
    assert (
        await client.patch(
            f"/api/v1/projects/{project}/members/{lead_id}",
            headers=auth(admin),
            json={"role": "PROJECT_ADMIN"},
        )
    ).status_code == 200
    assert (
        await client.delete(
            f"/api/v1/projects/{project}/members/{lead_id}", headers=auth(admin)
        )
    ).status_code == 204

    # --- Project tags ---
    assert (
        await client.post(
            f"/api/v1/projects/{project}/tags",
            headers=auth(admin),
            json={"tag_id": tag_ids["backend"]},
        )
    ).status_code == 200

    # --- Tasks by the developer ---
    task = (
        await client.post(
            f"/api/v1/projects/{project}/tasks",
            headers=auth(dev),
            json={
                "title": "Implement auth",
                "assignee_id": dev_id,
                "tag_ids": [tag_ids["backend"]],
            },
        )
    ).json()
    task_id = task["id"]

    assert (
        await client.patch(
            f"/api/v1/projects/{project}/tasks/{task_id}",
            headers=auth(dev),
            json={"status": "IN_REVIEW"},
        )
    ).json()["status"] == "IN_REVIEW"

    # Replace then detach task tags.
    set_tags = await client.put(
        f"/api/v1/projects/{project}/tasks/{task_id}/tags",
        headers=auth(dev),
        json={"tag_ids": [tag_ids["backend"], tag_ids["ci-cd"]]},
    )
    assert {t["name"] for t in set_tags.json()["tags"]} == {"backend", "ci-cd"}
    assert (
        await client.delete(
            f"/api/v1/projects/{project}/tasks/{task_id}/tags/{tag_ids['ci-cd']}",
            headers=auth(dev),
        )
    ).status_code == 204

    # The assignee may delete their own task.
    assert (
        await client.delete(
            f"/api/v1/projects/{project}/tasks/{task_id}", headers=auth(dev)
        )
    ).status_code == 204

    # --- Org update, then deactivate the developer ---
    updated = await client.patch(
        "/api/v1/organizations/current",
        headers=auth(admin),
        json={"description": "Acme Inc."},
    )
    assert updated.json()["description"] == "Acme Inc."

    assert (await client.delete(f"/api/v1/users/{dev_id}", headers=auth(admin))).status_code == 204
    assert (await client.get("/api/v1/auth/me", headers=auth(dev))).status_code == 401

    # --- Delete the project ---
    assert (await client.delete(f"/api/v1/projects/{project}", headers=auth(admin))).status_code == 204
    assert (await client.get(f"/api/v1/projects/{project}", headers=auth(admin))).status_code == 404


async def test_super_admin_org_lifecycle(client):
    root = await login(client, await create_super_admin("root@platform.com"))

    created = await client.post(
        "/api/v1/organizations",
        headers=auth(root),
        json={"name": "Tenant One"},
    )
    org_id = created.json()["id"]

    assert (
        await client.patch(
            f"/api/v1/organizations/{org_id}", headers=auth(root), json={"name": "Tenant 1"}
        )
    ).json()["name"] == "Tenant 1"
    assert (await client.delete(f"/api/v1/organizations/{org_id}", headers=auth(root))).status_code == 204
    assert (await client.get(f"/api/v1/organizations/{org_id}", headers=auth(root))).status_code == 404


async def test_email_verification_flow(client):
    """Verify-email consumes a single-use token (generated server-side)."""
    from app.core.database import get_sessionmaker
    from app.models.user import User
    from app.services import auth_service
    from sqlalchemy import select

    await register_org_admin(client, email="verify@acme.com")

    async with get_sessionmaker()() as session:
        user = await session.scalar(select(User).where(User.email == "verify@acme.com"))
        raw = await auth_service.issue_email_verification(session, user)
        await session.commit()

    ok = await client.get(f"/api/v1/auth/verify-email?token={raw}")
    assert ok.status_code == 200 and ok.json()["status"] == "verified"

    # Token is single-use: a replay fails.
    replay = await client.get(f"/api/v1/auth/verify-email?token={raw}")
    assert replay.status_code == 401
