from __future__ import annotations

import pytest

from tests.helpers import auth, create_project, register_org_admin

pytestmark = pytest.mark.asyncio

ORG_HEADER = "X-AI-Fleet-Organization-Id"
PROJECT_HEADER = "X-AI-Fleet-Project-Id"


async def test_context_discovers_multiple_orgs_and_accessible_native_projects(client):
    token = await register_org_admin(client, org_name="Primary", email="multi@example.com")
    first = (await client.get("/api/v1/me/context", headers=auth(token))).json()
    first_id = first["organizations"][0]["id"]

    created = await client.post(
        "/api/v1/me/organizations",
        headers=auth(token),
        json={"name": "Secondary"},
    )
    assert created.status_code == 201, created.text
    second_id = created.json()["id"]

    selected_headers = {**auth(token), ORG_HEADER: second_id}
    project = await client.post(
        "/api/v1/projects", headers=selected_headers, json={"name": "Native"}
    )
    assert project.status_code == 201, project.text
    project_id = project.json()["id"]

    context = await client.get("/api/v1/me/context", headers=selected_headers)
    assert context.status_code == 200
    body = context.json()
    assert body["selected"] == {"organization_id": second_id, "project_id": None}
    assert {org["name"] for org in body["organizations"]} == {"Primary", "Secondary"}
    secondary = next(org for org in body["organizations"] if org["id"] == second_id)
    assert secondary["role"] == "ORG_ADMIN"
    assert secondary["status"] == "ACTIVE"
    assert secondary["projects"] == [
        {"id": project_id, "name": "Native", "role": "PROJECT_ADMIN", "status": "ACTIVE"}
    ]

    # Organization and project headers are validated together. A known project
    # cannot be reached through another accessible organization.
    wrong = await client.get(
        f"/api/v1/projects/{project_id}",
        headers={**auth(token), ORG_HEADER: first_id},
    )
    assert wrong.status_code == 404
    narrowed = await client.get(
        f"/api/v1/projects/{project_id}",
        headers={**selected_headers, PROJECT_HEADER: project_id},
    )
    assert narrowed.status_code == 200


async def test_invalid_selected_context_is_not_an_existence_oracle(client):
    token = await register_org_admin(client)
    assert (
        await client.get(
            "/api/v1/me/context",
            headers={**auth(token), ORG_HEADER: "00000000-0000-0000-0000-000000000001"},
        )
    ).status_code == 404
    assert (
        await client.get(
            "/api/v1/me/context",
            headers={**auth(token), PROJECT_HEADER: "not-a-uuid"},
        )
    ).status_code == 404
