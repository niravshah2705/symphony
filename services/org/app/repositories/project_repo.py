"""Project data access (org-scoped)."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.models.project_membership import ProjectMembership
from app.repositories.base import paginate
from app.schemas.common import PageParams


class ProjectRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_in_org(self, project_id: uuid.UUID, org_id: uuid.UUID) -> Project | None:
        return await self.session.scalar(
            select(Project).where(Project.id == project_id, Project.org_id == org_id)
        )

    async def list_in_org(
        self, org_id: uuid.UUID, params: PageParams
    ) -> tuple[list[Project], int]:
        stmt = (
            select(Project)
            .where(Project.org_id == org_id)
            .order_by(Project.created_at.desc())
        )
        return await paginate(self.session, stmt, params)

    async def list_for_member(
        self, org_id: uuid.UUID, user_id: uuid.UUID, params: PageParams
    ) -> tuple[list[Project], int]:
        stmt = (
            select(Project)
            .join(ProjectMembership, ProjectMembership.project_id == Project.id)
            .where(Project.org_id == org_id, ProjectMembership.user_id == user_id)
            .order_by(Project.created_at.desc())
        )
        return await paginate(self.session, stmt, params)

    async def add(self, project: Project) -> Project:
        self.session.add(project)
        await self.session.flush()
        return project

    async def delete(self, project: Project) -> None:
        await self.session.delete(project)
