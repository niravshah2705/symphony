"""Project external-org grant lifecycle: hand a whole project to another
organization (outsourcing) so every member of that partner org gets access.
"""
from __future__ import annotations

import uuid

from app.authz.principal import Principal
from app.core.database import Uow
from app.errors import ConflictError, NotFoundError, ValidationAppError
from app.models.enums import ProjectRole
from app.models.project import Project
from app.models.project_external_grant import ProjectExternalOrgGrant
from app.repositories.org_repo import OrgRepository
from app.repositories.project_external_grant_repo import ProjectExternalGrantRepository
from app.repositories.project_repo import ProjectRepository


async def create_external_grant(
    session: Uow, principal: Principal, project: Project, data
) -> ProjectExternalOrgGrant:  # type: ignore[no-untyped-def]
    collaborator_org_id = data.collaborator_org_id
    if collaborator_org_id == project.org_id:
        raise ValidationAppError("A project cannot be granted to its own organization")
    # Least privilege: a grant applies to EVERY member of the partner org, so it
    # may not confer PROJECT_ADMIN (which can delete the project, flip access
    # mode, and revoke the owner's own grants). Admin authority to an outside
    # party must be an explicit per-person ProjectInvitation instead.
    if data.default_role == ProjectRole.PROJECT_ADMIN:
        raise ValidationAppError(
            "An external org grant cannot confer PROJECT_ADMIN; use a project invitation"
        )
    if await OrgRepository(session).get(collaborator_org_id) is None:
        raise NotFoundError("Collaborator organization not found")

    repo = ProjectExternalGrantRepository(session)
    if await repo.get(project.org_id, project.id, collaborator_org_id) is not None:
        raise ConflictError("This organization already has access to the project")

    # Ensure the project is locatable cross-org (lazy backfill for projects that
    # predate the owner index) before granting outside access.
    await ProjectRepository(session).ensure_owner_index(project)
    return await repo.add(
        ProjectExternalOrgGrant(
            project_id=project.id,
            owner_org_id=project.org_id,
            collaborator_org_id=collaborator_org_id,
            default_role=data.default_role,
            granted_by=principal.user_id,
        )
    )


async def list_external_grants(
    session: Uow, project: Project
) -> list[ProjectExternalOrgGrant]:
    return await ProjectExternalGrantRepository(session).list_for_project(
        project.org_id, project.id
    )


async def revoke_external_grant(
    session: Uow, project: Project, collaborator_org_id: uuid.UUID
) -> None:
    repo = ProjectExternalGrantRepository(session)
    grant = await repo.get(project.org_id, project.id, collaborator_org_id)
    if grant is None:
        raise NotFoundError("Grant not found")
    await repo.delete(grant)
