"""Explicit self-service organization creation.

An authenticated but org-less user (e.g. a Firebase user JIT-provisioned with
``org_id=None``), or an existing member, creates another organization and
becomes its first ORG_ADMIN. Distinct from the super-admin-only
``POST /organizations`` cross-org endpoint.
"""
from __future__ import annotations

from app.core.database import Uow
from app.core.timeutils import utcnow
from app.models.enums import OrgRole
from app.models.organization import Organization
from app.models.organization_membership import OrganizationMembership
from app.models.user import User
from app.repositories.org_repo import OrgRepository
from app.repositories.organization_membership_repo import OrganizationMembershipRepository
from app.schemas.me import CreateOrgRequest
from app.services import provisioning_service
from app.services.common import allocate_org_slug


async def create_organization_for_user(
    session: Uow, user: User, data: CreateOrgRequest
) -> Organization:
    org = Organization(
        name=data.name,
        description=data.description,
        slug=await allocate_org_slug(session),
    )
    await OrgRepository(session).add(org)
    await OrganizationMembershipRepository(session).add(
        OrganizationMembership(org_id=org.id, user_id=user.id, role=OrgRole.ORG_ADMIN)
    )

    # The caller becomes the org's first admin. `user` was loaded via
    # get_current_user (tracked), so these mutations flush on commit.
    if user.org_id is None:
        user.org_id = org.id
        user.org_role = OrgRole.ORG_ADMIN
        user.updated_at = utcnow()
    # Explicit org creation → provision a dedicated stack (no-op unless enabled).
    await provisioning_service.trigger_provisioning(session, org)
    return org
