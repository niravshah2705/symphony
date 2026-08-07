"""Reusable request helpers for tests."""
from __future__ import annotations

from httpx import AsyncClient


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def register(
    client: AsyncClient,
    *,
    org_name: str = "Acme",
    email: str = "admin@acme.com",
    password: str = "password123",
    full_name: str = "Acme Admin",
):
    """Register a new org; returns the httpx Response (201 with tokens)."""
    return await client.post(
        "/api/v1/auth/register",
        json={
            "org_name": org_name,
            "email": email,
            "password": password,
            "full_name": full_name,
        },
    )


async def register_org_admin(client: AsyncClient, **kwargs) -> str:
    """Register and return the ORG_ADMIN's access token."""
    resp = await register(client, **kwargs)
    assert resp.status_code == 201, resp.text
    return resp.json()["access_token"]


async def login(client: AsyncClient, email: str, password: str = "password123") -> str:
    r = await client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


async def create_user(
    client: AsyncClient,
    admin_token: str,
    *,
    email: str,
    org_role: str = "MEMBER",
    password: str = "password123",
    full_name: str = "Member",
) -> str:
    """Org-admin creates a user; returns the new user's id."""
    r = await client.post(
        "/api/v1/users",
        headers=auth(admin_token),
        json={
            "email": email,
            "password": password,
            "org_role": org_role,
            "full_name": full_name,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def create_user_and_login(
    client: AsyncClient, admin_token: str, *, email: str, org_role: str = "MEMBER"
) -> tuple[str, str]:
    """Returns (user_id, access_token) for a newly created user."""
    user_id = await create_user(client, admin_token, email=email, org_role=org_role)
    token = await login(client, email)
    return user_id, token


async def create_project(client: AsyncClient, admin_token: str, name: str = "Proj") -> str:
    r = await client.post(
        "/api/v1/projects", headers=auth(admin_token), json={"name": name}
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def add_member(
    client: AsyncClient, admin_token: str, project_id: str, user_id: str, role: str
):
    return await client.post(
        f"/api/v1/projects/{project_id}/members",
        headers=auth(admin_token),
        json={"user_id": user_id, "role": role},
    )


async def create_super_admin(email: str = "root@platform.com", password: str = "password123") -> str:
    """Insert a super-admin directly and return its email (log in for a token)."""
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
            is_super_admin=True,
            is_active=True,
            email_verified=True,
        )
    )
    await uow.commit()
    return email
