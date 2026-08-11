"""Explicit organization creation for org-less and existing users."""
from __future__ import annotations

import pytest

from app.models.enums import OrgRole
from app.models.organization import Organization
from app.models.organization_membership import OrganizationMembership
from app.models.user import User
from app.repositories.org_repo import OrgRepository
from app.repositories.organization_membership_repo import OrganizationMembershipRepository
from app.repositories.user_repo import UserRepository
from app.schemas.me import CreateOrgRequest
from app.services.onboarding_service import create_organization_for_user


@pytest.mark.asyncio
async def test_explicit_create_gives_orgless_user_default_admin_membership(db_session):
    user = User(email="orgless@example.com")
    await UserRepository(db_session).add(user)

    org = await create_organization_for_user(
        db_session, user, CreateOrgRequest(name="Explicit")
    )
    await db_session.commit()

    membership = await OrganizationMembershipRepository(db_session).get(org.id, user.id)
    assert membership is not None
    assert membership.role == OrgRole.ORG_ADMIN
    assert user.org_id == org.id
    assert user.org_role == OrgRole.ORG_ADMIN


@pytest.mark.asyncio
async def test_explicit_create_adds_org_without_changing_existing_default(db_session):
    primary = Organization(name="Primary", slug="opaque-primary")
    await OrgRepository(db_session).add(primary)
    user = User(email="multi@example.com", org_id=primary.id, org_role=OrgRole.MEMBER)
    await UserRepository(db_session).add(user)
    await OrganizationMembershipRepository(db_session).add(
        OrganizationMembership(org_id=primary.id, user_id=user.id, role=OrgRole.MEMBER)
    )

    secondary = await create_organization_for_user(
        db_session, user, CreateOrgRequest(name="Secondary")
    )
    await db_session.commit()

    memberships = await OrganizationMembershipRepository(db_session).list_for_user(user.id)
    assert {membership.org_id for membership in memberships} == {primary.id, secondary.id}
    assert next(m for m in memberships if m.org_id == secondary.id).role == OrgRole.ORG_ADMIN
    assert user.org_id == primary.id
    assert user.org_role == OrgRole.MEMBER
