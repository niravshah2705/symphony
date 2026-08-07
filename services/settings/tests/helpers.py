"""Reusable test helpers.

The settings service has no register/login surface (it authenticates identities
the platform already provisioned), so tests seed users/memberships directly into
the in-memory store and mint a local access token for them — the same store the
app reads via the `client` fixture's `set_db(InMemoryDb())`.
"""
from __future__ import annotations

import uuid

from app.auth.jwt_local import create_access_token
from app.core.database import new_uow
from app.models.enums import AuthProvider, OrgRole, ProjectRole
from app.models.membership import ProjectMembership
from app.models.user import User
from app.repositories.membership_repo import MembershipRepository
from app.repositories.user_repo import UserRepository


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def token_for(user: User) -> str:
    return create_access_token(
        user_id=user.id,
        org_id=user.org_id,
        org_role=user.org_role.value,
        is_super_admin=user.is_super_admin,
        email=user.email,
    )


async def seed_user(
    *,
    email: str,
    org_id: uuid.UUID | None = None,
    org_role: OrgRole = OrgRole.MEMBER,
    is_super_admin: bool = False,
) -> User:
    uow = new_uow()
    user = User(
        email=email,
        org_id=org_id,
        org_role=org_role,
        is_super_admin=is_super_admin,
        auth_provider=AuthProvider.LOCAL,
        is_active=True,
        email_verified=True,
    )
    await UserRepository(uow).add(user)
    await uow.commit()
    return user


async def make_user(
    *,
    email: str,
    org_id: uuid.UUID | None = None,
    org_role: OrgRole = OrgRole.MEMBER,
) -> tuple[User, str]:
    """Seed a user and return (user, bearer token)."""
    user = await seed_user(email=email, org_id=org_id, org_role=org_role)
    return user, token_for(user)


async def seed_membership(
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
    role: ProjectRole = ProjectRole.PROJECT_ADMIN,
) -> ProjectMembership:
    uow = new_uow()
    membership = ProjectMembership(
        org_id=org_id, project_id=project_id, user_id=user_id, role=role
    )
    await MembershipRepository(uow).add(membership)
    await uow.commit()
    return membership
