"""User data access. Top-level `users/{id}` with an `org_id` field (reads that
are org-scoped verify org_id). Email + external-subject uniqueness is enforced
with atomic guard docs (create-if-absent)."""
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
from app.schemas.common import PageParams


class UserRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def get_by_id(self, user_id: uuid.UUID) -> User | None:
        existing = self.uow.tracked(USERS, str(user_id))
        if existing is not None:
            return existing
        doc = await self.uow.get(USERS, str(user_id))
        return self.uow.track(USERS, User.from_doc(doc)) if doc else None

    async def get_global_by_email(self, email: str) -> User | None:
        """Global lookup — used only by the login/register/create flows."""
        rows = await self.uow.query(USERS, [("email", email)], limit=1)
        return self.uow.track(USERS, User.from_doc(rows[0])) if rows else None

    async def get_by_external_subject(self, subject: str) -> User | None:
        rows = await self.uow.query(
            USERS,
            [("external_subject", subject), ("auth_provider", AuthProvider.EXTERNAL.value)],
            limit=1,
        )
        return self.uow.track(USERS, User.from_doc(rows[0])) if rows else None

    async def get_super_admin(self) -> User | None:
        rows = await self.uow.query(USERS, [("is_super_admin", True)], limit=1)
        return User.from_doc(rows[0]) if rows else None

    async def get_in_org(self, user_id: uuid.UUID, org_id: uuid.UUID) -> User | None:
        user = await self.get_by_id(user_id)
        if user is None:
            return None
        from app.repositories.organization_membership_repo import OrganizationMembershipRepository

        membership = await OrganizationMembershipRepository(self.uow).get(org_id, user_id)
        if membership is None and user.org_id == org_id:
            membership = await OrganizationMembershipRepository(self.uow).ensure_legacy(user)
        return user if membership is not None else None

    async def list_in_org(self, org_id: uuid.UUID, params: PageParams) -> tuple[list[User], int]:
        from app.repositories.organization_membership_repo import OrganizationMembershipRepository

        membership_repo = OrganizationMembershipRepository(self.uow)
        memberships = await membership_repo.list_for_org(org_id)
        # Dual-read legacy scalar users, materializing their membership once.
        legacy = await self.uow.query(USERS, [("org_id", str(org_id))])
        known = {m.user_id for m in memberships}
        for doc in legacy:
            user = self.uow.track(USERS, User.from_doc(doc))
            if user.id not in known:
                migrated = await membership_repo.ensure_legacy(user)
                if migrated is not None:
                    memberships.append(migrated)
                    known.add(user.id)
        memberships.sort(key=lambda m: m.created_at, reverse=True)
        total = len(memberships)
        page = memberships[params.offset : params.offset + params.limit]
        users: list[User] = []
        for membership in page:
            user = await self.get_by_id(membership.user_id)
            if user is not None:
                users.append(user)
        return users, total

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
