"""Organization data access + cascade delete of all org-owned data."""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.core.firestore import Db
from app.models.base import id_list
from app.models.organization import Organization
from app.repositories.base import (
    ORGS,
    UNIQUE_EMAILS,
    UNIQUE_EXTERNAL_SUBJECTS,
    USERS,
    memberships_col,
    paginate,
    projects_col,
    tags_col,
    tasks_col,
)
from app.repositories.tag_repo import load_tags
from app.schemas.common import PageParams


async def _delete_all(db: Db, collection: str) -> None:
    for doc in await db.query(collection):
        await db.delete(collection, doc["id"])


class OrgRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def _hydrate(self, org: Organization, doc: dict) -> Organization:
        org.applied_tags = await load_tags(self.uow, org.id, id_list(doc.get("applied_tag_ids")))
        return self.uow.track(ORGS, org)

    async def get(self, org_id: uuid.UUID) -> Organization | None:
        doc = await self.uow.db.get(ORGS, str(org_id))
        return await self._hydrate(Organization.from_doc(doc), doc) if doc else None

    async def get_by_slug(self, slug: str) -> Organization | None:
        rows = await self.uow.db.query(ORGS, [("slug", slug)], limit=1)
        return await self._hydrate(Organization.from_doc(rows[0]), rows[0]) if rows else None

    async def add(self, org: Organization) -> Organization:
        return await self.uow.add(ORGS, org)

    async def list(self, params: PageParams) -> tuple[list[Organization], int]:
        rows, total = await paginate(self.uow.db, ORGS, params)
        return [await self._hydrate(Organization.from_doc(d), d) for d in rows], total

    async def delete(self, org: Organization) -> None:
        db = self.uow.db
        oid = org.id
        for project in await db.query(projects_col(oid)):
            await _delete_all(db, tasks_col(oid, project["id"]))
            await db.delete(projects_col(oid), project["id"])
        await _delete_all(db, memberships_col(oid))
        await _delete_all(db, tags_col(oid))
        for user in await db.query(USERS, [("org_id", str(oid))]):
            if user.get("email"):
                await db.delete(UNIQUE_EMAILS, user["email"])
            if user.get("external_subject"):
                await db.delete(UNIQUE_EXTERNAL_SUBJECTS, user["external_subject"])
            await db.delete(USERS, user["id"])
        self.uow.forget(ORGS, org)
        await db.delete(ORGS, str(oid))
