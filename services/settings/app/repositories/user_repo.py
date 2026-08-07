"""User data access. Top-level `users/{id}` with an `org_id` field. Email +
external-subject uniqueness is enforced with atomic guard docs (create-if-absent)
so JIT provisioning is race-safe, exactly as in the org service."""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.errors import ConflictError
from app.models.enums import AuthProvider
from app.models.user import User
from app.repositories.base import (
    UNIQUE_EMAILS,
    UNIQUE_EXTERNAL_SUBJECTS,
    USERS,
)


class UserRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def get_by_id(self, user_id: uuid.UUID) -> User | None:
        existing = self.uow.tracked(USERS, str(user_id))
        if existing is not None:
            return existing
        doc = await self.uow.get(USERS, str(user_id))
        return self.uow.track(USERS, User.from_doc(doc)) if doc else None

    async def get_by_external_subject(self, subject: str) -> User | None:
        rows = await self.uow.query(
            USERS,
            [("external_subject", subject), ("auth_provider", AuthProvider.EXTERNAL.value)],
            limit=1,
        )
        return self.uow.track(USERS, User.from_doc(rows[0])) if rows else None

    async def add(self, user: User) -> User:
        # Atomic uniqueness guards (email is immutable post-create, so no upkeep).
        if user.email and not await self.uow.db.create(
            UNIQUE_EMAILS, user.email, {"user_id": str(user.id)}
        ):
            raise ConflictError("Email already registered")
        if user.external_subject and not await self.uow.db.create(
            UNIQUE_EXTERNAL_SUBJECTS, user.external_subject, {"user_id": str(user.id)}
        ):
            raise ConflictError("External subject already registered")
        return await self.uow.add(USERS, user)
