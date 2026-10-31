"""Explicit self-service organization creation and default workspace provisioning.

An authenticated but org-less user (e.g. a Firebase user JIT-provisioned with
``org_id=None``), or an existing member, creates another organization and
becomes its first ORG_ADMIN. On user login/onboarding, default organization,
default project, and tags (`default=true`, `initialise=false`) are silently created.
"""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.core.timeutils import utcnow
from app.models.enums import MembershipStatus, OrgRole, ProjectRole
from app.models.organization import Organization
from app.models.organization_membership import OrganizationMembership
from app.models.project import Project
from app.models.project_membership import ProjectMembership
from app.models.tag import Tag
from app.models.user import User
from app.repositories.membership_repo import MembershipRepository
from app.repositories.org_repo import OrgRepository
from app.repositories.organization_membership_repo import OrganizationMembershipRepository
from app.repositories.project_repo import ProjectRepository
from app.repositories.tag_repo import TagRepository
from app.schemas.me import CreateOrgRequest
from app.services import provisioning_service
from app.services.common import allocate_org_slug

DEFAULT_ORG_NAME = "default"
DEFAULT_PROJECT_NAME = "default"
DEFAULT_TAG_DEFAULT = "default=true"
DEFAULT_TAG_INITIALISE = "initialise=false"


async def ensure_default_project_for_org(
    session: Uow, org: Organization, user: User
) -> Project:
    """Ensure tags ('default=true', 'initialise=false') and a default project exist in an org."""
    tag_repo = TagRepository(session)
    tag_default = await tag_repo.get_by_name(DEFAULT_TAG_DEFAULT, org.id)
    if tag_default is None:
        tag_default = await tag_repo.add(Tag(org_id=org.id, name=DEFAULT_TAG_DEFAULT))
    tag_init = await tag_repo.get_by_name(DEFAULT_TAG_INITIALISE, org.id)
    if tag_init is None:
        tag_init = await tag_repo.add(Tag(org_id=org.id, name=DEFAULT_TAG_INITIALISE))

    applied_ids = {t.id for t in org.applied_tags}
    if tag_default.id not in applied_ids:
        org.applied_tags.append(tag_default)
    if tag_init.id not in applied_ids:
        org.applied_tags.append(tag_init)

    project_repo = ProjectRepository(session)
    project = Project(
        org_id=org.id,
        name=DEFAULT_PROJECT_NAME,
        tags=[tag_default, tag_init],
    )
    await project_repo.add(project)

    membership_repo = MembershipRepository(session)
    existing_pm = await membership_repo.get(org.id, project.id, user.id)
    if existing_pm is None:
        await membership_repo.add(
            org.id,
            ProjectMembership(
                project_id=project.id,
                user_id=user.id,
                role=ProjectRole.PROJECT_ADMIN,
            ),
        )
    return project


async def ensure_default_organization_and_project(
    session: Uow, user: User
) -> tuple[Organization, Project]:
    """Silently create a default organization, default project, and tags for a user."""
    org_repo = OrgRepository(session)
    org_membership_repo = OrganizationMembershipRepository(session)
    tag_repo = TagRepository(session)
    project_repo = ProjectRepository(session)
    membership_repo = MembershipRepository(session)

    org = Organization(
        name=DEFAULT_ORG_NAME,
        slug=await allocate_org_slug(session),
    )
    await org_repo.add(org)

    tag_default = await tag_repo.add(Tag(org_id=org.id, name=DEFAULT_TAG_DEFAULT))
    tag_init = await tag_repo.add(Tag(org_id=org.id, name=DEFAULT_TAG_INITIALISE))
    org.applied_tags = [tag_default, tag_init]

    project = Project(
        org_id=org.id,
        name=DEFAULT_PROJECT_NAME,
        tags=[tag_default, tag_init],
    )
    await project_repo.add(project)

    await org_membership_repo.add(
        OrganizationMembership(
            org_id=org.id,
            user_id=user.id,
            role=OrgRole.ORG_ADMIN,
            status=MembershipStatus.ACTIVE,
        )
    )

    await membership_repo.add(
        org.id,
        ProjectMembership(
            project_id=project.id,
            user_id=user.id,
            role=ProjectRole.PROJECT_ADMIN,
        ),
    )

    if user.org_id is None:
        user.org_id = org.id
        user.org_role = OrgRole.ORG_ADMIN
        user.updated_at = utcnow()

    await provisioning_service.trigger_provisioning(session, org)
    return org, project


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

    if user.org_id is None:
        user.org_id = org.id
        user.org_role = OrgRole.ORG_ADMIN
        user.updated_at = utcnow()

    # Explicit org creation → provision a dedicated stack (no-op unless enabled).
    await provisioning_service.trigger_provisioning(session, org)
    return org
