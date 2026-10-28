"""Discover every organization and native project accessible to the caller."""
from __future__ import annotations

import uuid

from app.authz.principal import Principal
from app.core.database import Uow
from app.models.base import id_list
from app.models.enums import OrgRole, ProjectRole
from app.models.user import User
from app.repositories.base import memberships_col, projects_col
from app.repositories.org_repo import OrgRepository
from app.repositories.organization_membership_repo import OrganizationMembershipRepository
from app.repositories.tag_repo import load_tags
from app.schemas.me import (
    ContextOrganizationResponse,
    ContextProjectResponse,
    ContextUserResponse,
    MeContextResponse,
    SelectedContextResponse,
)
from app.schemas.tag import TagResponse
from app.services.onboarding_service import (
    DEFAULT_ORG_NAME,
    ensure_default_organization_and_project,
    ensure_default_project_for_org,
)


async def get_context(session: Uow, principal: Principal, user: User) -> MeContextResponse:
    membership_repo = OrganizationMembershipRepository(session)
    memberships = await membership_repo.list_for_user(
        user.id, legacy_user=user
    )
    if not memberships:
        await ensure_default_organization_and_project(session, user)
        memberships = await membership_repo.list_for_user(
            user.id, legacy_user=user
        )

    organizations: list[ContextOrganizationResponse] = []
    for membership in memberships:
        org = await OrgRepository(session).get(membership.org_id)
        if org is None:
            continue
        projects: list[ContextProjectResponse] = []
        if membership.role == OrgRole.ORG_ADMIN:
            project_docs = await session.query(projects_col(org.id), order_by="created_at")
            if not project_docs and org.name == DEFAULT_ORG_NAME:
                default_proj = await ensure_default_project_for_org(session, org, user)
                project_docs = [default_proj.to_doc()]
            for doc in project_docs:
                p_tag_ids = id_list(doc.get("tag_ids"))
                p_tags = await load_tags(session, org.id, p_tag_ids)
                projects.append(
                    ContextProjectResponse(
                        id=doc["id"],
                        name=doc.get("name", ""),
                        role=ProjectRole.PROJECT_ADMIN,
                        tags=[TagResponse.model_validate(t) for t in p_tags],
                    )
                )
        else:
            project_memberships = await session.query(
                memberships_col(org.id), [("user_id", str(user.id))]
            )
            project_memberships.sort(key=lambda row: row.get("created_at"))
            for project_membership in project_memberships:
                doc = await session.get(
                    projects_col(org.id), str(project_membership.get("project_id", ""))
                )
                if doc is not None:
                    p_tag_ids = id_list(doc.get("tag_ids"))
                    p_tags = await load_tags(session, org.id, p_tag_ids)
                    projects.append(
                        ContextProjectResponse(
                            id=doc["id"],
                            name=doc.get("name", ""),
                            role=ProjectRole(project_membership["role"]),
                            tags=[TagResponse.model_validate(t) for t in p_tags],
                        )
                    )
        organizations.append(
            ContextOrganizationResponse(
                id=org.id,
                name=org.name,
                parent_org_id=org.parent_org_id,
                membership_id=membership.id,
                role=membership.role,
                status=membership.status,
                projects=projects,
                tags=[TagResponse.model_validate(t) for t in org.applied_tags],
            )
        )

    selected_org_id = principal.org_id
    selected_project_id = principal.project_id
    if selected_org_id is None and organizations:
        selected_org_id = organizations[0].id
        if organizations[0].projects:
            selected_project_id = organizations[0].projects[0].id

    selected = None
    if selected_org_id is not None:
        selected = SelectedContextResponse(
            organization_id=selected_org_id, project_id=selected_project_id
        )

    return MeContextResponse(
        user=ContextUserResponse(
            id=user.id,
            email=user.email,
            full_name=user.full_name,
            persona=user.persona,
            is_super_admin=user.is_super_admin,
        ),
        organizations=organizations,
        selected=selected,
    )
