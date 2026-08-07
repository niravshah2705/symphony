"""Project data access (org-scoped) + cascade delete of tasks/memberships."""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.models.base import id_list
from app.models.project import Project
from app.repositories.base import memberships_col, paginate, projects_col, tasks_col
from app.repositories.tag_repo import load_tags
from app.schemas.common import PageParams


class ProjectRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def _hydrate(self, org_id: uuid.UUID, project: Project, doc: dict) -> Project:
        project.tags = await load_tags(self.uow, org_id, id_list(doc.get("tag_ids")))
        return self.uow.track(projects_col(org_id), project)

    async def get(self, project_id: uuid.UUID, org_id: uuid.UUID) -> Project | None:
        doc = await self.uow.db.get(projects_col(org_id), str(project_id))
        return await self._hydrate(org_id, Project.from_doc(doc), doc) if doc else None

    async def list_in_org(self, org_id: uuid.UUID, params: PageParams) -> tuple[list[Project], int]:
        rows, total = await paginate(self.uow.db, projects_col(org_id), params)
        return [await self._hydrate(org_id, Project.from_doc(d), d) for d in rows], total

    async def list_for_member(
        self, org_id: uuid.UUID, user_id: uuid.UUID, params: PageParams
    ) -> tuple[list[Project], int]:
        memberships = await self.uow.db.query(memberships_col(org_id), [("user_id", str(user_id))])
        docs = []
        for m in memberships:
            doc = await self.uow.db.get(projects_col(org_id), m["project_id"])
            if doc is not None:
                docs.append(doc)
        docs.sort(key=lambda d: d.get("created_at"), reverse=True)
        total = len(docs)
        page = docs[params.offset : params.offset + params.limit]
        return [await self._hydrate(org_id, Project.from_doc(d), d) for d in page], total

    async def add(self, project: Project) -> Project:
        return await self.uow.add(projects_col(project.org_id), project)

    async def delete(self, project: Project) -> None:
        db = self.uow.db
        oid, pid = project.org_id, project.id
        for task in await db.query(tasks_col(oid, pid)):
            await db.delete(tasks_col(oid, pid), task["id"])
        for m in await db.query(memberships_col(oid), [("project_id", str(pid))]):
            await db.delete(memberships_col(oid), m["id"])
        self.uow.forget(projects_col(oid), project)
        await db.delete(projects_col(oid), str(pid))
