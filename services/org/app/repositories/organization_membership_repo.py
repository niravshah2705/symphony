"""Organization membership persistence and legacy scalar migration."""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.models.enums import MembershipStatus, OrgRole
from app.models.organization_membership import OrganizationMembership
from app.models.user import User
from app.repositories.base import USERS, organization_members_col, user_organizations_col


class OrganizationMembershipRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def get(
        self, org_id: uuid.UUID, user_id: uuid.UUID, *, include_inactive: bool = False
    ) -> OrganizationMembership | None:
        collection = organization_members_col(org_id)
        existing = self.uow.tracked(collection, str(user_id))
        if existing is not None:
            if include_inactive or existing.status == MembershipStatus.ACTIVE:
                return existing
            return None
        doc = await self.uow.get(collection, str(user_id))
        if doc is None:
            return None
        membership = OrganizationMembership.from_doc(doc)
        self.uow.track(collection, membership, str(user_id))
        if include_inactive or membership.status == MembershipStatus.ACTIVE:
            return membership
        return None

    async def ensure_legacy(self, user: User) -> OrganizationMembership | None:
        """Materialize a scalar ``user.org_id/org_role`` as source + user index.

        Existing deployments can be upgraded without a flag-day migration. This
        method is safe to call on every authentication because the transaction
        only writes when the source membership is absent.
        """
        if user.org_id is None:
            return None
        current = await self.get(user.org_id, user.id, include_inactive=True)
        if current is not None:
            # Repair a missing/stale per-user index opportunistically.
            index_doc = await self.uow.get(user_organizations_col(user.id), str(user.org_id))
            if index_doc != current.to_doc():
                await self.uow.db.set(
                    user_organizations_col(user.id), str(user.org_id), current.to_doc()
                )
            return current if current.status == MembershipStatus.ACTIVE else None

        membership = OrganizationMembership(
            org_id=user.org_id,
            user_id=user.id,
            role=user.org_role,
            status=MembershipStatus.ACTIVE,
        )

        async def _migrate(txn):  # type: ignore[no-untyped-def]
            source = organization_members_col(user.org_id)
            existing = await txn.get(source, str(user.id))
            doc = existing or membership.to_doc()
            txn.set(source, str(user.id), doc)
            txn.set(user_organizations_col(user.id), str(user.org_id), doc)
            return doc

        doc = await self.uow.db.run_transaction(_migrate)
        resolved = OrganizationMembership.from_doc(doc)
        self.uow.track(organization_members_col(user.org_id), resolved, str(user.id))
        return resolved if resolved.status == MembershipStatus.ACTIVE else None

    async def add(self, membership: OrganizationMembership) -> OrganizationMembership:
        """Atomically create source/index, preserving an existing membership."""
        org_id, user_id = membership.org_id, membership.user_id
        if org_id is None or user_id is None:
            raise ValueError("Organization membership requires org_id and user_id")

        async def _write(txn):  # type: ignore[no-untyped-def]
            existing = await txn.get(organization_members_col(org_id), str(user_id))
            doc = existing or membership.to_doc()
            txn.set(organization_members_col(org_id), str(user_id), doc)
            txn.set(user_organizations_col(user_id), str(org_id), doc)
            return doc

        doc = await self.uow.db.run_transaction(_write)
        resolved = OrganizationMembership.from_doc(doc)
        return self.uow.track(organization_members_col(org_id), resolved, str(user_id))

    async def update_role(
        self, membership: OrganizationMembership, role: OrgRole
    ) -> OrganizationMembership:
        membership.role = role
        from app.core.timeutils import utcnow

        membership.updated_at = utcnow()

        async def _write(txn):  # type: ignore[no-untyped-def]
            doc = membership.to_doc()
            txn.set(organization_members_col(membership.org_id), str(membership.user_id), doc)
            txn.set(user_organizations_col(membership.user_id), str(membership.org_id), doc)

        await self.uow.db.run_transaction(_write)
        self.uow.track(
            organization_members_col(membership.org_id), membership, str(membership.user_id)
        )
        return membership

    async def remove(self, membership: OrganizationMembership) -> None:
        org_id, user_id = membership.org_id, membership.user_id
        if org_id is None or user_id is None:
            return

        async def _delete(txn):  # type: ignore[no-untyped-def]
            txn.delete(organization_members_col(org_id), str(user_id))
            txn.delete(user_organizations_col(user_id), str(org_id))

        await self.uow.db.run_transaction(_delete)
        self.uow.forget(organization_members_col(org_id), membership, str(user_id))

    async def list_for_user(
        self, user_id: uuid.UUID, *, legacy_user: User | None = None
    ) -> list[OrganizationMembership]:
        if legacy_user is not None:
            await self.ensure_legacy(legacy_user)
        rows = await self.uow.query(user_organizations_col(user_id))
        rows = [
            row
            for row in rows
            if row.get("status", MembershipStatus.ACTIVE.value) == MembershipStatus.ACTIVE.value
        ]
        rows.sort(key=lambda row: row.get("created_at"))
        memberships: list[OrganizationMembership] = []
        for row in rows:
            membership = OrganizationMembership.from_doc(row)
            # The org-side record remains authoritative; ignore orphaned indexes.
            source = await self.get(membership.org_id, user_id)
            if source is not None:
                memberships.append(source)
        return memberships

    async def list_for_org(self, org_id: uuid.UUID) -> list[OrganizationMembership]:
        rows = await self.uow.query(organization_members_col(org_id))
        rows = [
            row
            for row in rows
            if row.get("status", MembershipStatus.ACTIVE.value) == MembershipStatus.ACTIVE.value
        ]
        rows.sort(key=lambda row: row.get("created_at"))
        memberships = [OrganizationMembership.from_doc(row) for row in rows]
        for membership in memberships:
            self.uow.track(organization_members_col(org_id), membership, str(membership.user_id))
        return memberships

    async def count_admins(self, org_id: uuid.UUID) -> int:
        rows = await self.uow.query(organization_members_col(org_id))
        rows = [
            row
            for row in rows
            if row.get("status", MembershipStatus.ACTIVE.value) == MembershipStatus.ACTIVE.value
            and row.get("role") == OrgRole.ORG_ADMIN.value
        ]
        active = 0
        for row in rows:
            user_doc = await self.uow.get(USERS, str(row.get("user_id", "")))
            if user_doc is not None and bool(user_doc.get("is_active", True)):
                active += 1
        return active

    async def rebase_legacy_scalar(self, user: User) -> None:
        """Keep scalar fields as a backward-compatible default context only."""
        memberships = await self.list_for_user(user.id)
        if memberships:
            chosen = memberships[0]
            user.org_id = chosen.org_id
            user.org_role = chosen.role
        else:
            user.org_id = None
            user.org_role = OrgRole.MEMBER
        from app.core.timeutils import utcnow

        user.updated_at = utcnow()
        # The caller normally loaded a tracked user. Support transaction-created
        # users too without requiring a second repository lookup.
        if self.uow.tracked(USERS, str(user.id)) is None:
            self.uow.track(USERS, user)
