"""Tag data access (org-scoped vocabulary).

A tag lives at ``organizations/{org_id}/tags/{id}``. Name uniqueness within the
org is a best-effort query check (create/update are admin-only). Tag ids
referenced by projects/tasks/orgs that no longer exist are simply skipped on
hydration, so deleting a tag needs no association scrubbing.
"""
from __future__ import annotations

import uuid
from collections.abc import Sequence

from app.core.database import Uow
from app.models.tag import Tag
from app.repositories.base import paginate, tags_col
from app.schemas.common import PageParams


async def load_tags(uow: Uow, org_id: uuid.UUID, ids: Sequence[uuid.UUID]) -> list[Tag]:
    """Hydrate tag objects by id, preserving order and skipping missing ones."""
    out: list[Tag] = []
    for tid in ids:
        doc = await uow.get(tags_col(org_id), str(tid))
        if doc is not None:
            out.append(Tag.from_doc(doc))
    return out


class TagRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def get_in_org(self, tag_id: uuid.UUID, org_id: uuid.UUID) -> Tag | None:
        doc = await self.uow.get(tags_col(org_id), str(tag_id))
        return self.uow.track(tags_col(org_id), Tag.from_doc(doc)) if doc else None

    async def get_by_name(self, name: str, org_id: uuid.UUID) -> Tag | None:
        rows = await self.uow.query(tags_col(org_id), [("name", name)], limit=1)
        return Tag.from_doc(rows[0]) if rows else None

    async def get_many_in_org(self, ids: Sequence[uuid.UUID], org_id: uuid.UUID) -> list[Tag]:
        return await load_tags(self.uow, org_id, list(dict.fromkeys(ids)))

    async def list_in_org(self, org_id: uuid.UUID, params: PageParams) -> tuple[list[Tag], int]:
        rows, total = await paginate(self.uow, tags_col(org_id), params)
        return self.uow.track_all(tags_col(org_id), [Tag.from_doc(d) for d in rows]), total

    async def add(self, tag: Tag) -> Tag:
        return await self.uow.add(tags_col(tag.org_id), tag)

    async def delete(self, tag: Tag) -> None:
        self.uow.forget(tags_col(tag.org_id), tag)
        await self.uow.db.delete(tags_col(tag.org_id), str(tag.id))
