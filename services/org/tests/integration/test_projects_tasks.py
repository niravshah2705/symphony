"""Project/member/task/tag CRUD and the project-role authorization matrix."""
from __future__ import annotations

import pytest

from tests.helpers import (
    add_member,
    auth,
    create_project,
    create_user_and_login,
    register_org_admin,
)

pytestmark = pytest.mark.asyncio


async def _make_tag(client, admin, name):
    r = await client.post("/api/v1/tags", headers=auth(admin), json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_only_org_admin_creates_projects(client):
    admin = await register_org_admin(client)
    _, member = await create_user_and_login(client, admin, email="m@acme.com")

    assert (await client.post("/api/v1/projects", headers=auth(member), json={"name": "P"})).status_code == 403
    ok = await client.post("/api/v1/projects", headers=auth(admin), json={"name": "P"})
    assert ok.status_code == 201


async def test_non_member_gets_404_on_project(client):
    admin = await register_org_admin(client)
    project = await create_project(client, admin)
    _, outsider = await create_user_and_login(client, admin, email="out@acme.com")

    # Member of the org but not the project -> 404 (no existence oracle).
    assert (await client.get(f"/api/v1/projects/{project}", headers=auth(outsider))).status_code == 404


async def test_developer_writes_tasks_team_lead_is_read_only(client):
    admin = await register_org_admin(client)
    project = await create_project(client, admin)
    dev_id, dev = await create_user_and_login(client, admin, email="dev@acme.com")
    lead_id, lead = await create_user_and_login(client, admin, email="lead@acme.com")
    await add_member(client, admin, project, dev_id, "DEVELOPER")
    await add_member(client, admin, project, lead_id, "TEAM_LEAD")

    # Developer creates a task.
    created = await client.post(
        f"/api/v1/projects/{project}/tasks",
        headers=auth(dev),
        json={"title": "Build login"},
    )
    assert created.status_code == 201
    task_id = created.json()["id"]

    # Team lead can read (review) but not write.
    assert (await client.get(f"/api/v1/projects/{project}/tasks", headers=auth(lead))).status_code == 200
    blocked = await client.post(
        f"/api/v1/projects/{project}/tasks",
        headers=auth(lead),
        json={"title": "Nope"},
    )
    assert blocked.status_code == 403
    blocked_update = await client.patch(
        f"/api/v1/projects/{project}/tasks/{task_id}",
        headers=auth(lead),
        json={"status": "DONE"},
    )
    assert blocked_update.status_code == 403


async def test_project_admin_manages_access_developer_cannot(client):
    admin = await register_org_admin(client)
    project = await create_project(client, admin)
    padmin_id, padmin = await create_user_and_login(client, admin, email="padmin@acme.com")
    dev_id, dev = await create_user_and_login(client, admin, email="dev2@acme.com")
    await add_member(client, admin, project, padmin_id, "PROJECT_ADMIN")
    await add_member(client, admin, project, dev_id, "DEVELOPER")

    newbie_id, _ = await create_user_and_login(client, admin, email="new@acme.com")

    # Project admin can add members; developer cannot.
    ok = await add_member(client, padmin, project, newbie_id, "DEVELOPER")
    assert ok.status_code == 201
    denied = await client.patch(
        f"/api/v1/projects/{project}",
        headers=auth(dev),
        json={"name": "Renamed"},
    )
    assert denied.status_code == 403

    # Project admin can update the project.
    assert (
        await client.patch(
            f"/api/v1/projects/{project}", headers=auth(padmin), json={"name": "Renamed"}
        )
    ).status_code == 200


async def test_duplicate_member_is_conflict(client):
    admin = await register_org_admin(client)
    project = await create_project(client, admin)
    uid, _ = await create_user_and_login(client, admin, email="dup@acme.com")
    assert (await add_member(client, admin, project, uid, "DEVELOPER")).status_code == 201
    # Re-adding is a conflict (additive semantics — no silent role replace).
    assert (await add_member(client, admin, project, uid, "TEAM_LEAD")).status_code == 409


async def test_task_tags_and_assignee_validation(client):
    admin = await register_org_admin(client)
    project = await create_project(client, admin)
    dev_id, dev = await create_user_and_login(client, admin, email="dev3@acme.com")
    await add_member(client, admin, project, dev_id, "DEVELOPER")
    tag_be = await _make_tag(client, admin, "backend")
    tag_auth = await _make_tag(client, admin, "auth")

    # Create a task with tags, assigned to the developer (a project member).
    created = await client.post(
        f"/api/v1/projects/{project}/tasks",
        headers=auth(dev),
        json={"title": "Auth service", "assignee_id": dev_id, "tag_ids": [tag_be, tag_auth]},
    )
    assert created.status_code == 201, created.text
    task = created.json()
    assert {t["name"] for t in task["tags"]} == {"backend", "auth"}

    # Filtering by tag works.
    filtered = await client.get(
        f"/api/v1/projects/{project}/tasks?tag_id={tag_auth}", headers=auth(dev)
    )
    assert filtered.json()["meta"]["total"] == 1

    # Assigning to a non-member is rejected.
    outsider_id, _ = await create_user_and_login(client, admin, email="outsider@acme.com")
    bad = await client.post(
        f"/api/v1/projects/{project}/tasks",
        headers=auth(dev),
        json={"title": "X", "assignee_id": outsider_id},
    )
    assert bad.status_code == 422


async def test_tag_crud_authz(client):
    admin = await register_org_admin(client)
    _, member = await create_user_and_login(client, admin, email="viewer@acme.com")

    tag_id = await _make_tag(client, admin, "infrastructure")
    # Member can read the vocabulary...
    assert (await client.get("/api/v1/tags", headers=auth(member))).status_code == 200
    # ...but cannot create/delete tags.
    assert (
        await client.post("/api/v1/tags", headers=auth(member), json={"name": "ci-cd"})
    ).status_code == 403
    assert (
        await client.delete(f"/api/v1/tags/{tag_id}", headers=auth(member))
    ).status_code == 403
