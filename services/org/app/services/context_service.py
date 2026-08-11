"""Discover every organization and native project accessible to the caller."""
from __future__ import annotations

from app.authz.principal import Principal
from app.core.database import Uow
from app.models.enums import OrgRole, ProjectRole
from app.repositories.base import memberships_col, projects_col
from app.repositories.org_repo import OrgRepository
from app.repositories.organization_membership_repo import OrganizationMembershipRepository
from app.schemas.me import (
    ContextOrganizationResponse,
    ContextProjectResponse,
    ContextUserResponse,
    MeContextResponse,
    SelectedContextResponse,
)
from app.models.user import User


async def get_context(session: Uow, principal: Principal, user: User) -> MeContextResponse:
    memberships = await OrganizationMembershipRepository(session).list_for_user(
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
            for doc in project_docs:
                projects.append(
                    ContextProjectResponse(
                        id=doc["id"],
                        name=doc.get("name", ""),
                        role=ProjectRole.PROJECT_ADMIN,
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
                    projects.append(
                        ContextProjectResponse(
                            id=doc["id"],
                            name=doc.get("name", ""),
                            role=ProjectRole(project_membership["role"]),
                        )
                    )
        organizations.append(
            ContextOrganizationResponse(
                id=org.id,
                name=org.name,
                membership_id=membership.id,
                role=membership.role,
                status=membership.status,
                projects=projects,
            )
        )

    selected = None
    if principal.org_id is not None:
        selected = SelectedContextResponse(
            organization_id=principal.org_id, project_id=principal.project_id
        )
    return MeContextResponse(
        user=ContextUserResponse(
            id=user.id,
            email=user.email,
            full_name=user.full_name,
            is_super_admin=user.is_super_admin,
        ),
        organizations=organizations,
        selected=selected,
    )
