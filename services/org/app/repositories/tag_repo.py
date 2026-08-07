"""Tag data access (org-scoped vocabulary)."""
from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.tag import Tag
from app.repositories.base import paginate
from app.schemas.common import PageParams


class TagRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_in_org(self, tag_id: uuid.UUID, org_id: uuid.UUID) -> Tag | None:
        return await self.session.scalar(
            select(Tag).where(Tag.id == tag_id, Tag.org_id == org_id)
        )

    async def get_by_name(self, name: str, org_id: uuid.UUID) -> Tag | None:
        return await self.session.scalar(
            select(Tag).where(Tag.name == name, Tag.org_id == org_id)
        )

    async def get_many_in_org(
        self, tag_ids: Sequence[uuid.UUID], org_id: uuid.UUID
    ) -> list[Tag]:
        if not tag_ids:
            return []
        rows = await self.session.scalars(
            select(Tag).where(Tag.id.in_(list(tag_ids)), Tag.org_id == org_id)
        )
        return list(rows)

    async def list_in_org(
        self, org_id: uuid.UUID, params: PageParams
    ) -> tuple[list[Tag], int]:
        stmt = select(Tag).where(Tag.org_id == org_id).order_by(Tag.name.asc())
        return await paginate(self.session, stmt, params)

    async def add(self, tag: Tag) -> Tag:
        self.session.add(tag)
        await self.session.flush()
        return tag

    async def delete(self, tag: Tag) -> None:
        await self.session.delete(tag)
