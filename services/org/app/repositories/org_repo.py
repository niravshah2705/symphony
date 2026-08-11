"""Organization data access + cascade delete of org-owned data.

Global user identities survive tenant deletion; only the deleted tenant's
organization/project memberships are removed.
"""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.core.firestore import Db
from app.models.base import id_list
from app.models.organization import Organization
from app.repositories.base import (
    INVITATION_TOKENS,
    ORGS,
    PENDING_INVITATIONS,
    USERS,
    USER_ORG_LOCKS,
    invitations_col,
    memberships_col,
    organization_members_col,
    paginate,
    projects_col,
    tags_col,
    tasks_col,
)
from app.repositories.invitation_repo import pending_guard_id
from app.repositories.organization_membership_repo import OrganizationMembershipRepository
from app.repositories.user_repo import UserRepository
from app.repositories.tag_repo import load_tags
from app.schemas.common import PageParams


async def _delete_all(db: Db, collection: str) -> None:
    for doc in await db.query(collection):
        await db.delete(collection, doc["id"])


class OrgRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def _hydrate(self, org: Organization, doc: dict) -> Organization:
        org.applied_tags = await load_tags(self.uow, org.id, id_list(doc.get("applied_tag_ids")))
        return self.uow.track(ORGS, org)

    async def get(self, org_id: uuid.UUID) -> Organization | None:
        existing = self.uow.tracked(ORGS, str(org_id))
        if existing is not None:
            return existing
        doc = await self.uow.get(ORGS, str(org_id))
        return await self._hydrate(Organization.from_doc(doc), doc) if doc else None

    async def get_by_slug(self, slug: str) -> Organization | None:
        rows = await self.uow.query(ORGS, [("slug", slug)], limit=1)
        return await self._hydrate(Organization.from_doc(rows[0]), rows[0]) if rows else None

    async def add(self, org: Organization) -> Organization:
        return await self.uow.add(ORGS, org)

    async def list(self, params: PageParams) -> tuple[list[Organization], int]:
        rows, total = await paginate(self.uow, ORGS, params)
        return [await self._hydrate(Organization.from_doc(d), d) for d in rows], total

    async def delete(self, org: Organization) -> None:
        db = self.uow.db
        oid = org.id
        for project in await db.query(projects_col(oid)):
            await _delete_all(db, tasks_col(oid, project["id"]))
            await db.delete(projects_col(oid), project["id"])
        await _delete_all(db, memberships_col(oid))
        await _delete_all(db, tags_col(oid))

        # Materialize any untouched legacy scalar members so the same cleanup
        # path handles old and new data, then remove only this membership/index.
        membership_repo = OrganizationMembershipRepository(self.uow)
        for user_doc in await db.query(USERS, [("org_id", str(oid))]):
            user = await UserRepository(self.uow).get_by_id(uuid.UUID(user_doc["id"]))
            if user is not None:
                await membership_repo.ensure_legacy(user)
        member_user_ids: set[uuid.UUID] = set()
        for member_doc in await db.query(organization_members_col(oid)):
            member_user_ids.add(uuid.UUID(member_doc["user_id"]))
            membership = await membership_repo.get(
                oid, uuid.UUID(member_doc["user_id"]), include_inactive=True
            )
            if membership is None:
                continue
            user = await UserRepository(self.uow).get_by_id(membership.user_id)
            await membership_repo.remove(membership)
            if user is not None:
                if user.managed_by_org_id == oid:
                    user.managed_by_org_id = None
                if user.org_id == oid:
                    await membership_repo.rebase_legacy_scalar(user)

        # Invitations and their lookup/uniqueness guards are tenant-owned.
        for invitation in await db.query(invitations_col(oid)):
            token_hash = invitation.get("token_hash")
            if token_hash:
                await db.delete(INVITATION_TOKENS, token_hash)
            email = invitation.get("email")
            if email:
                await db.delete(PENDING_INVITATIONS, pending_guard_id(oid, email))
            await db.delete(invitations_col(oid), invitation["id"])
        for user_id in member_user_ids:
            lock = await db.get(USER_ORG_LOCKS, str(user_id))
            if lock and lock.get("org_id") == str(oid):
                await db.delete(USER_ORG_LOCKS, str(user_id))
        self.uow.forget(ORGS, org)
        await db.delete(ORGS, str(oid))
