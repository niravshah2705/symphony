"""Organization data access."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.organization import Organization
from app.repositories.base import paginate
from app.schemas.common import PageParams


class OrgRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, org_id: uuid.UUID) -> Organization | None:
        # Eager-load applied tags so async attach/detach never triggers lazy IO.
        return await self.session.scalar(
            select(Organization)
            .options(selectinload(Organization.applied_tags))
            .where(Organization.id == org_id)
        )

    async def get_by_slug(self, slug: str) -> Organization | None:
        return await self.session.scalar(
            select(Organization).where(Organization.slug == slug)
        )

    async def add(self, org: Organization) -> Organization:
        self.session.add(org)
        await self.session.flush()
        return org

    async def list(self, params: PageParams) -> tuple[list[Organization], int]:
        stmt = select(Organization).order_by(Organization.created_at.desc())
        return await paginate(self.session, stmt, params)

    async def delete(self, org: Organization) -> None:
        await self.session.delete(org)
