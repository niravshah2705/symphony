"""Project service (org-scoped)."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.authz.policy import is_org_admin
from app.authz.principal import Principal
from app.models.project import Project
from app.repositories.project_repo import ProjectRepository
from app.schemas.common import PageParams
from app.schemas.project import ProjectCreate, ProjectUpdate


async def create_project(
    session: AsyncSession, principal: Principal, data: ProjectCreate
) -> Project:
    project = Project(
        org_id=principal.org_id, name=data.name, description=data.description
    )
    project.tags = []  # mark the collection loaded so response serialization is safe
    return await ProjectRepository(session).add(project)


async def list_projects(
    session: AsyncSession, principal: Principal, params: PageParams
) -> tuple[list[Project], int]:
    repo = ProjectRepository(session)
    if is_org_admin(principal):
        return await repo.list_in_org(principal.org_id, params)
    return await repo.list_for_member(principal.org_id, principal.user_id, params)


async def update_project(
    session: AsyncSession, project: Project, data: ProjectUpdate
) -> Project:
    if data.name is not None:
        project.name = data.name
    if data.description is not None:
        project.description = data.description
    return project


async def delete_project(session: AsyncSession, project: Project) -> None:
    await ProjectRepository(session).delete(project)
