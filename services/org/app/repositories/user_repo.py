"""User data access. Reads are org-scoped unless explicitly global (login)."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.repositories.base import paginate
from app.schemas.common import PageParams


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_global_by_email(self, email: str) -> User | None:
        """Global lookup — used only by the login/register flow."""
        return await self.session.scalar(select(User).where(User.email == email))

    async def get_in_org(self, user_id: uuid.UUID, org_id: uuid.UUID) -> User | None:
        return await self.session.scalar(
            select(User).where(User.id == user_id, User.org_id == org_id)
        )

    async def list_in_org(
        self, org_id: uuid.UUID, params: PageParams
    ) -> tuple[list[User], int]:
        stmt = (
            select(User)
            .where(User.org_id == org_id)
            .order_by(User.created_at.desc())
        )
        return await paginate(self.session, stmt, params)

    async def add(self, user: User) -> User:
        self.session.add(user)
        await self.session.flush()
        return user
