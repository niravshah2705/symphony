"""Project external-org grant data access.

Stored at
``organizations/{owner_org_id}/projects/{project_id}/external_grants/{collaborator_org_id}``
— the doc id is the collaborator org id, so "already granted" is structural
(create-if-absent) and lookup by collaborator org is a direct get.
"""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.models.project_external_grant import ProjectExternalOrgGrant
from app.repositories.base import project_external_grants_col


async def cleanup_project_external_grants(db, org_id: uuid.UUID, project_id: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    """Delete all of a project's external-org grants. Best-effort cascade for
    project/org deletion. Grants are keyed by ``collaborator_org_id`` (not their
    own ``id``), so deletion must use that field — this helper is the single
    place that encodes that subtlety."""
    collection = project_external_grants_col(org_id, project_id)
    for grant in await db.query(collection):
        await db.delete(collection, grant["collaborator_org_id"])


class ProjectExternalGrantRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def get(
        self, org_id: uuid.UUID, project_id: uuid.UUID, collaborator_org_id: uuid.UUID
    ) -> ProjectExternalOrgGrant | None:
        collection = project_external_grants_col(org_id, project_id)
        existing = self.uow.tracked(collection, str(collaborator_org_id))
        if existing is not None:
            return existing
        doc = await self.uow.get(collection, str(collaborator_org_id))
        return (
            self.uow.track(
                collection, ProjectExternalOrgGrant.from_doc(doc), str(collaborator_org_id)
            )
            if doc is not None
            else None
        )

    async def list_for_project(
        self, org_id: uuid.UUID, project_id: uuid.UUID
    ) -> list[ProjectExternalOrgGrant]:
        collection = project_external_grants_col(org_id, project_id)
        rows = await self.uow.query(collection, order_by="created_at", desc=True)
        grants = [ProjectExternalOrgGrant.from_doc(row) for row in rows]
        for grant in grants:
            self.uow.track(collection, grant, str(grant.collaborator_org_id))
        return grants

    async def add(self, grant: ProjectExternalOrgGrant) -> ProjectExternalOrgGrant:
        collection = project_external_grants_col(grant.owner_org_id, grant.project_id)
        return await self.uow.add(collection, grant, str(grant.collaborator_org_id))

    async def delete(self, grant: ProjectExternalOrgGrant) -> None:
        collection = project_external_grants_col(grant.owner_org_id, grant.project_id)
        self.uow.forget(collection, grant, str(grant.collaborator_org_id))
        await self.uow.db.delete(collection, str(grant.collaborator_org_id))
