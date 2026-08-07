"""Project membership data access."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project_membership import ProjectMembership
from app.models.user import User


class MembershipRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(
        self, project_id: uuid.UUID, user_id: uuid.UUID
    ) -> ProjectMembership | None:
        return await self.session.scalar(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.user_id == user_id,
            )
        )

    async def list_for_project(
        self, project_id: uuid.UUID
    ) -> list[tuple[ProjectMembership, User]]:
        rows = await self.session.execute(
            select(ProjectMembership, User)
            .join(User, User.id == ProjectMembership.user_id)
            .where(ProjectMembership.project_id == project_id)
            .order_by(ProjectMembership.created_at.asc())
        )
        return [(m, u) for m, u in rows.all()]

    async def add(self, membership: ProjectMembership) -> ProjectMembership:
        self.session.add(membership)
        await self.session.flush()
        return membership

    async def delete(self, membership: ProjectMembership) -> None:
        await self.session.delete(membership)
