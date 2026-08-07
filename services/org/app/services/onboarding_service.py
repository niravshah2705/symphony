"""Self-service organization creation.

An authenticated but org-less user (e.g. a Firebase user JIT-provisioned with
``org_id=None``) creates their own organization and becomes its first
ORG_ADMIN. This is the upgrade path from a private personal workspace to a
shared org (the only way to gain the ability to add other people to projects —
see docs/ACCESS_MODEL.md). Distinct from the super-admin-only
``POST /organizations`` cross-org endpoint.
"""
from __future__ import annotations

from app.core.database import Uow
from app.core.timeutils import utcnow
from app.errors import ConflictError
from app.models.enums import OrgRole
from app.models.organization import Organization
from app.models.user import User
from app.repositories.org_repo import OrgRepository
from app.schemas.me import CreateOrgRequest
from app.services.common import allocate_org_slug


async def create_organization_for_user(
    session: Uow, user: User, data: CreateOrgRequest
) -> Organization:
    if user.org_id is not None:
        raise ConflictError("You already belong to an organization")

    org = Organization(
        name=data.name,
        description=data.description,
        slug=await allocate_org_slug(session),
    )
    await OrgRepository(session).add(org)

    # The caller becomes the org's first admin. `user` was loaded via
    # get_current_user (tracked), so these mutations flush on commit.
    user.org_id = org.id
    user.org_role = OrgRole.ORG_ADMIN
    user.updated_at = utcnow()
    return org
