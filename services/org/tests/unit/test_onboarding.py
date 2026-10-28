"""Explicit organization creation for org-less and existing users."""
from __future__ import annotations

import pytest

from app.models.enums import OrgRole, ProjectRole
from app.models.organization import Organization
from app.models.organization_membership import OrganizationMembership
from app.models.user import User
from app.repositories.membership_repo import MembershipRepository
from app.repositories.org_repo import OrgRepository
from app.repositories.organization_membership_repo import OrganizationMembershipRepository
from app.repositories.user_repo import UserRepository
from app.schemas.me import CreateOrgRequest
from app.services.context_service import get_context
from app.services.onboarding_service import (
    DEFAULT_ORG_NAME,
    DEFAULT_PROJECT_NAME,
    DEFAULT_TAG_DEFAULT,
    DEFAULT_TAG_INITIALISE,
    create_organization_for_user,
    ensure_default_organization_and_project,
)


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


@pytest.mark.asyncio
async def test_ensure_default_organization_and_project_creates_defaults_with_tags(db_session):
    user = User(email="newuser@example.com")
    await UserRepository(db_session).add(user)

    org, project = await ensure_default_organization_and_project(db_session, user)
    await db_session.commit()

    assert org.name == DEFAULT_ORG_NAME
    assert project.name == DEFAULT_PROJECT_NAME
    assert isinstance(org.id, type(user.id))
    assert isinstance(project.id, type(user.id))

    org_tag_names = {t.name for t in org.applied_tags}
    assert org_tag_names == {DEFAULT_TAG_DEFAULT, DEFAULT_TAG_INITIALISE}

    proj_tag_names = {t.name for t in project.tags}
    assert proj_tag_names == {DEFAULT_TAG_DEFAULT, DEFAULT_TAG_INITIALISE}

    membership = await OrganizationMembershipRepository(db_session).get(org.id, user.id)
    assert membership is not None
    assert membership.role == OrgRole.ORG_ADMIN

    proj_member = await MembershipRepository(db_session).get(org.id, project.id, user.id)
    assert proj_member is not None
    assert proj_member.role == ProjectRole.PROJECT_ADMIN


@pytest.mark.asyncio
async def test_context_silently_creates_default_org_and_project_for_orgless_user(db_session):
    from app.authz.principal import Principal

    user = User(email="fresh@example.com")
    await UserRepository(db_session).add(user)
    await db_session.commit()

    principal = Principal(user_id=user.id, org_id=None, org_role=OrgRole.MEMBER, is_super_admin=False, email=user.email)
    context = await get_context(db_session, principal, user)

    assert len(context.organizations) == 1
    org_res = context.organizations[0]
    assert org_res.name == "default"
    assert {t.name for t in org_res.tags} == {"default=true", "initialise=false"}
    assert len(org_res.projects) == 1
    proj_res = org_res.projects[0]
    assert proj_res.name == "default"
    assert {t.name for t in proj_res.tags} == {"default=true", "initialise=false"}
