"""Project membership data access. Stored at
`organizations/{org_id}/memberships/{id}` with project_id/user_id fields;
(project, user) uniqueness is checked by the service before add (admin action)."""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.models.project_membership import ProjectMembership
from app.models.user import User
from app.repositories.base import memberships_col
from app.repositories.user_repo import UserRepository


class MembershipRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def get(
        self, org_id: uuid.UUID, project_id: uuid.UUID, user_id: uuid.UUID
    ) -> ProjectMembership | None:
        rows = await self.uow.query(
            memberships_col(org_id),
            [("project_id", str(project_id)), ("user_id", str(user_id))],
            limit=1,
        )
        return self.uow.track(memberships_col(org_id), ProjectMembership.from_doc(rows[0])) if rows else None

    async def list_for_project(
        self, org_id: uuid.UUID, project_id: uuid.UUID
    ) -> list[tuple[ProjectMembership, User]]:
        rows = await self.uow.query(
            memberships_col(org_id), [("project_id", str(project_id))], order_by="created_at", desc=True
        )
        users = UserRepository(self.uow)
        out: list[tuple[ProjectMembership, User]] = []
        for r in rows:
            m = ProjectMembership.from_doc(r)
            user = await users.get_by_id(m.user_id)
            if user is not None:
                out.append((m, user))
        return out

    async def add(self, org_id: uuid.UUID, membership: ProjectMembership) -> ProjectMembership:
        return await self.uow.add(memberships_col(org_id), membership)

    async def delete(self, org_id: uuid.UUID, membership: ProjectMembership) -> None:
        self.uow.forget(memberships_col(org_id), membership)
        await self.uow.db.delete(memberships_col(org_id), str(membership.id))
