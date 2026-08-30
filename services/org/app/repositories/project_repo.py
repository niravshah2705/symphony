"""Project data access (org-scoped) + cascade delete of tasks/memberships."""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.models.base import id_list
from app.models.project import Project
from app.repositories.base import (
    PROJECT_OWNER_INDEX,
    memberships_col,
    paginate,
    projects_col,
    tasks_col,
)
from app.repositories.project_external_grant_repo import cleanup_project_external_grants
from app.repositories.project_invitation_repo import cleanup_project_invitations
from app.repositories.tag_repo import load_tags
from app.schemas.common import PageParams


class ProjectRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def _hydrate(self, org_id: uuid.UUID, project: Project, doc: dict) -> Project:
        project.tags = await load_tags(self.uow, org_id, id_list(doc.get("tag_ids")))
        return self.uow.track(projects_col(org_id), project)

    async def get(self, project_id: uuid.UUID, org_id: uuid.UUID) -> Project | None:
        existing = self.uow.tracked(projects_col(org_id), str(project_id))
        if existing is not None:
            return existing
        doc = await self.uow.get(projects_col(org_id), str(project_id))
        return await self._hydrate(org_id, Project.from_doc(doc), doc) if doc else None

    async def list_in_org(self, org_id: uuid.UUID, params: PageParams) -> tuple[list[Project], int]:
        rows, total = await paginate(self.uow, projects_col(org_id), params)
        return [await self._hydrate(org_id, Project.from_doc(d), d) for d in rows], total

    async def list_for_member(
        self, org_id: uuid.UUID, user_id: uuid.UUID, params: PageParams
    ) -> tuple[list[Project], int]:
        memberships = await self.uow.query(memberships_col(org_id), [("user_id", str(user_id))])
        docs = []
        for m in memberships:
            doc = await self.uow.get(projects_col(org_id), m["project_id"])
            if doc is not None:
                docs.append(doc)
        docs.sort(key=lambda d: d.get("created_at"), reverse=True)
        total = len(docs)
        page = docs[params.offset : params.offset + params.limit]
        return [await self._hydrate(org_id, Project.from_doc(d), d) for d in page], total

    async def add(self, project: Project) -> Project:
        stored = await self.uow.add(projects_col(project.org_id), project)
        await self.ensure_owner_index(project)
        return stored

    async def ensure_owner_index(self, project: Project) -> None:
        """Write the flat project -> owner-org index so a cross-org collaborator
        can locate this project by id (see PROJECT_OWNER_INDEX). Idempotent, so
        it also lazily backfills projects created before the index existed —
        callers that enable cross-org access (grants/invitations) invoke it."""
        await self.uow.db.set(
            PROJECT_OWNER_INDEX, str(project.id), {"owner_org_id": str(project.org_id)}
        )

    async def delete(self, project: Project) -> None:
        db = self.uow.db
        oid, pid = project.org_id, project.id
        for task in await db.query(tasks_col(oid, pid)):
            await db.delete(tasks_col(oid, pid), task["id"])
        for m in await db.query(memberships_col(oid), [("project_id", str(pid))]):
            await db.delete(memberships_col(oid), m["id"])
        # Cross-org collaboration subcollections + the owner index.
        await cleanup_project_invitations(db, oid, pid)
        await cleanup_project_external_grants(db, oid, pid)
        await db.delete(PROJECT_OWNER_INDEX, str(pid))
        self.uow.forget(projects_col(oid), project)
        await db.delete(projects_col(oid), str(pid))
