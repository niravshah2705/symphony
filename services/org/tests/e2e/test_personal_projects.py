"""Personal projects + self-service organization creation.

Personal projects are owner-scoped and reachable by any authenticated user; a
different user can never see another's personal project (404, no existence
oracle). Self-service create-org turns an org-less user into an ORG_ADMIN.
"""
from __future__ import annotations

import pytest

from tests.helpers import auth, register_org_admin


async def _me(client, token) -> dict:
    r = await client.get("/api/v1/me", headers=auth(token))
    assert r.status_code == 200, r.text
    return r.json()


async def _seed_orgless_user(email: str = "solo@personal.com", password: str = "password123") -> str:
    """Insert an org-less, non-super-admin LOCAL user (the shape a fresh
    Firebase user gets after JIT provisioning). Returns the email."""
    from app.core.database import new_uow
    from app.core.security import hash_password
    from app.models.enums import AuthProvider, OrgRole
    from app.models.user import User
    from app.repositories.user_repo import UserRepository

    uow = new_uow()
    await UserRepository(uow).add(
        User(
            email=email,
            password_hash=hash_password(password),
            auth_provider=AuthProvider.LOCAL,
            org_id=None,
            org_role=OrgRole.MEMBER,
            is_super_admin=False,
            is_active=True,
            email_verified=True,
        )
    )
    await uow.commit()
    return email


@pytest.mark.asyncio
async def test_personal_project_crud(client):
    token = await register_org_admin(client, org_name="Acme", email="admin@acme.com")
    me = await _me(client, token)

    created = await client.post("/api/v1/me/projects", headers=auth(token), json={"name": "My idea"})
    assert created.status_code == 201, created.text
    project = created.json()
    assert project["name"] == "My idea"
    assert project["owner_id"] == me["user_id"]

    listed = await client.get("/api/v1/me/projects", headers=auth(token))
    assert listed.status_code == 200
    assert [p["id"] for p in listed.json()["data"]] == [project["id"]]

    patched = await client.patch(
        f"/api/v1/me/projects/{project['id']}", headers=auth(token), json={"name": "Renamed"}
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == "Renamed"

    deleted = await client.delete(f"/api/v1/me/projects/{project['id']}", headers=auth(token))
    assert deleted.status_code == 204
    gone = await client.get(f"/api/v1/me/projects/{project['id']}", headers=auth(token))
    assert gone.status_code == 404


@pytest.mark.asyncio
async def test_personal_projects_are_isolated_per_user(client):
    token_a = await register_org_admin(client, org_name="Acme", email="a@acme.com")
    token_b = await register_org_admin(client, org_name="Beta", email="b@beta.com")

    created = await client.post("/api/v1/me/projects", headers=auth(token_a), json={"name": "Secret"})
    project_id = created.json()["id"]

    # B cannot read A's personal project (structurally under users/{A}/projects).
    cross = await client.get(f"/api/v1/me/projects/{project_id}", headers=auth(token_b))
    assert cross.status_code == 404
    # ...and B's own list is empty.
    assert (await client.get("/api/v1/me/projects", headers=auth(token_b))).json()["data"] == []


@pytest.mark.asyncio
async def test_personal_project_requires_auth(client):
    unauth = await client.post("/api/v1/me/projects", json={"name": "x"})
    assert unauth.status_code == 401


@pytest.mark.asyncio
async def test_orgless_user_creates_organization_and_becomes_admin(client):
    email = await _seed_orgless_user()
    login = await client.post("/api/v1/auth/login", json={"email": email, "password": "password123"})
    token = login.json()["access_token"]

    before = await _me(client, token)
    assert before["has_organization"] is False

    created = await client.post("/api/v1/me/organization", headers=auth(token), json={"name": "Solo Inc"})
    assert created.status_code == 201, created.text
    assert created.json()["name"] == "Solo Inc"

    after = await _me(client, token)
    assert after["has_organization"] is True
    assert after["org_role"] == "ORG_ADMIN"

    # The same token now reaches the org tenant surface as an admin.
    proj = await client.post("/api/v1/projects", headers=auth(token), json={"name": "Team project"})
    assert proj.status_code == 201, proj.text


@pytest.mark.asyncio
async def test_create_organization_conflicts_when_already_in_org(client):
    token = await register_org_admin(client, org_name="Acme", email="admin@acme.com")
    dup = await client.post("/api/v1/me/organization", headers=auth(token), json={"name": "Another"})
    assert dup.status_code == 409
