"""Project-membership data access (org-scoped, structural isolation).

Memberships live under ``organizations/{org_id}/memberships`` so a lookup for
another org is unreachable from the caller's org path. Synced from the org
service; the settings service only reads them (see app/models/membership.py)."""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.models.membership import ProjectMembership, membership_doc_id
from app.repositories.base import memberships_col


class MembershipRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def get(
        self, org_id: uuid.UUID, project_id: uuid.UUID, user_id: uuid.UUID
    ) -> ProjectMembership | None:
        doc = await self.uow.get(
            memberships_col(org_id), membership_doc_id(project_id, user_id)
        )
        return ProjectMembership.from_doc(doc) if doc else None

    async def add(self, membership: ProjectMembership) -> ProjectMembership:
        return await self.uow.add(
            memberships_col(membership.org_id),
            membership,
            membership_doc_id(membership.project_id, membership.user_id),
        )
