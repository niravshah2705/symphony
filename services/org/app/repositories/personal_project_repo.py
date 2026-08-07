"""Personal-project data access — strictly owner-scoped.

Every method takes the owner id explicitly (the caller passes
``principal.user_id``); the collection path embeds it, so reads/writes can only
ever touch the caller's own projects. A project belonging to another user is not
merely filtered out — it is under a different path and cannot be reached, so a
cross-user lookup returns ``None`` (the route maps that to 404, no existence
oracle). See cross-tenant-isolation.md.
"""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.models.personal_project import PersonalProject
from app.repositories.base import paginate, personal_projects_col
from app.schemas.common import PageParams


class PersonalProjectRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def get(self, owner_id: uuid.UUID, project_id: uuid.UUID) -> PersonalProject | None:
        col = personal_projects_col(owner_id)
        existing = self.uow.tracked(col, str(project_id))
        if existing is not None:
            return existing
        doc = await self.uow.get(col, str(project_id))
        return self.uow.track(col, PersonalProject.from_doc(doc)) if doc else None

    async def list_for_owner(
        self, owner_id: uuid.UUID, params: PageParams
    ) -> tuple[list[PersonalProject], int]:
        col = personal_projects_col(owner_id)
        rows, total = await paginate(self.uow, col, params)
        return self.uow.track_all(col, [PersonalProject.from_doc(d) for d in rows]), total

    async def add(self, project: PersonalProject) -> PersonalProject:
        return await self.uow.add(personal_projects_col(project.owner_id), project)

    async def delete(self, project: PersonalProject) -> None:
        col = personal_projects_col(project.owner_id)
        await self.uow.db.delete(col, str(project.id))
        self.uow.forget(col, project)
