from __future__ import annotations

import pytest

from app.models.enums import OrgRole
from app.models.organization import Organization
from app.models.user import User
from app.repositories.base import organization_members_col, user_organizations_col
from app.repositories.org_repo import OrgRepository
from app.repositories.organization_membership_repo import OrganizationMembershipRepository
from app.repositories.user_repo import UserRepository


@pytest.mark.asyncio
async def test_legacy_scalar_membership_is_dual_written_on_read(db_session):
    org = Organization(name="Legacy", slug="opaque")
    await OrgRepository(db_session).add(org)
    user = User(email="legacy@example.com", org_id=org.id, org_role=OrgRole.ORG_ADMIN)
    await UserRepository(db_session).add(user)
    await db_session.commit()

    loaded = await UserRepository(db_session).get_by_id(user.id)
    membership = await OrganizationMembershipRepository(db_session).ensure_legacy(loaded)
    assert membership.role == OrgRole.ORG_ADMIN
    assert await db_session.db.get(organization_members_col(org.id), str(user.id)) is not None
    assert await db_session.db.get(user_organizations_col(user.id), str(org.id)) is not None
