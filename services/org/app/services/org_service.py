"""Organization service: tenant self-service (current org) and super-admin
cross-org management.
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.authz.principal import Principal
from app.core.security import hash_password
from app.errors import ConflictError, NotFoundError
from app.models.enums import AuthProvider, OrgRole
from app.models.organization import Organization
from app.models.user import User
from app.repositories.org_repo import OrgRepository
from app.repositories.user_repo import UserRepository
from app.schemas.common import PageParams
from app.schemas.org import OrgCreate, OrgUpdate
from app.services.common import allocate_org_slug, normalize_email


# ---- Tenant self-service (scoped to the caller's own org) -------------------

async def get_current_org(session: AsyncSession, principal: Principal) -> Organization:
    org = await OrgRepository(session).get(principal.org_id) if principal.org_id else None
    if org is None:
        raise NotFoundError("Organization not found")
    return org


async def update_current_org(
    session: AsyncSession, principal: Principal, data: OrgUpdate
) -> Organization:
    org = await get_current_org(session, principal)
    _apply_org_update(org, data)
    return org


async def delete_current_org(session: AsyncSession, principal: Principal) -> None:
    org = await get_current_org(session, principal)
    await OrgRepository(session).delete(org)


# ---- Super-admin cross-org management ---------------------------------------

async def create_org(session: AsyncSession, data: OrgCreate) -> Organization:
    org_repo = OrgRepository(session)
    org = Organization(
        name=data.name,
        description=data.description,
        slug=await allocate_org_slug(session),
    )
    await org_repo.add(org)

    if data.admin_email and data.admin_password:
        user_repo = UserRepository(session)
        email = normalize_email(data.admin_email)
        if await user_repo.get_global_by_email(email) is not None:
            raise ConflictError("Admin email already registered")
        await user_repo.add(
            User(
                org_id=org.id,
                email=email,
                password_hash=hash_password(data.admin_password),
                auth_provider=AuthProvider.LOCAL,
                org_role=OrgRole.ORG_ADMIN,
                is_super_admin=False,
                is_active=True,
                email_verified=False,
            )
        )
    return org


async def list_orgs(
    session: AsyncSession, params: PageParams
) -> tuple[list[Organization], int]:
    return await OrgRepository(session).list(params)


async def get_org(session: AsyncSession, org_id: uuid.UUID) -> Organization:
    org = await OrgRepository(session).get(org_id)
    if org is None:
        raise NotFoundError("Organization not found")
    return org


async def update_org(
    session: AsyncSession, org_id: uuid.UUID, data: OrgUpdate
) -> Organization:
    org = await get_org(session, org_id)
    _apply_org_update(org, data)
    return org


async def delete_org(session: AsyncSession, org_id: uuid.UUID) -> None:
    org = await get_org(session, org_id)
    await OrgRepository(session).delete(org)


def _apply_org_update(org: Organization, data: OrgUpdate) -> None:
    if data.name is not None:
        org.name = data.name
    if data.description is not None:
        org.description = data.description
