"""Personal-project business logic.

The owner is always ``principal.user_id`` — never taken from the request body or
path (cross-tenant-isolation.md). Loads that miss (including another user's id)
raise 404 via NotFoundError.
"""
from __future__ import annotations

import uuid

from app.authz.principal import Principal
from app.core.database import Uow
from app.core.timeutils import utcnow
from app.errors import NotFoundError
from app.models.personal_project import PersonalProject
from app.repositories.personal_project_repo import PersonalProjectRepository
from app.schemas.common import PageParams
from app.schemas.project import ProjectCreate, ProjectUpdate


async def create_personal_project(
    session: Uow, principal: Principal, data: ProjectCreate
) -> PersonalProject:
    project = PersonalProject(
        owner_id=principal.user_id,
        name=data.name,
        description=data.description,
    )
    return await PersonalProjectRepository(session).add(project)


async def list_personal_projects(
    session: Uow, principal: Principal, params: PageParams
) -> tuple[list[PersonalProject], int]:
    return await PersonalProjectRepository(session).list_for_owner(principal.user_id, params)


async def get_personal_project(
    session: Uow, principal: Principal, project_id: uuid.UUID
) -> PersonalProject:
    project = await PersonalProjectRepository(session).get(principal.user_id, project_id)
    if project is None:
        raise NotFoundError("Project not found")
    return project


async def update_personal_project(
    session: Uow, project: PersonalProject, data: ProjectUpdate
) -> PersonalProject:
    if data.name is not None:
        project.name = data.name
    if data.description is not None:
        project.description = data.description
    project.updated_at = utcnow()  # tracked object — commit flushes the change
    return project


async def delete_personal_project(session: Uow, project: PersonalProject) -> None:
    await PersonalProjectRepository(session).delete(project)
