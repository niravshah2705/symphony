"""Organization invitation persistence with single-use hashed-token indexes."""
from __future__ import annotations

import hashlib
import uuid

from app.core.database import Uow
from app.core.timeutils import ensure_aware
from app.errors import ConflictError
from app.models.enums import InvitationStatus
from app.models.organization_invitation import OrganizationInvitation
from app.models.organization_membership import OrganizationMembership
from app.models.user import User
from app.repositories.base import (
    INVITATION_TOKENS,
    ORGS,
    PENDING_INVITATIONS,
    USERS,
    invitations_col,
    organization_members_col,
    user_organizations_col,
)


def pending_guard_id(org_id: uuid.UUID, email: str) -> str:
    return hashlib.sha256(f"{org_id}:{email}".encode("utf-8")).hexdigest()


class InvitationRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def get(
        self, org_id: uuid.UUID, invitation_id: uuid.UUID
    ) -> OrganizationInvitation | None:
        collection = invitations_col(org_id)
        existing = self.uow.tracked(collection, str(invitation_id))
        if existing is not None:
            return existing
        doc = await self.uow.get(collection, str(invitation_id))
        return (
            self.uow.track(collection, OrganizationInvitation.from_doc(doc))
            if doc is not None
            else None
        )

    async def list_for_org(self, org_id: uuid.UUID) -> list[OrganizationInvitation]:
        rows = await self.uow.query(invitations_col(org_id), order_by="created_at", desc=True)
        invitations = [OrganizationInvitation.from_doc(row) for row in rows]
        return self.uow.track_all(invitations_col(org_id), invitations)

    async def add(self, invitation: OrganizationInvitation) -> OrganizationInvitation:
        org_id = invitation.org_id
        if org_id is None:
            raise ValueError("Invitation requires org_id")
        guard_id = pending_guard_id(org_id, invitation.email)

        async def _create(txn):  # type: ignore[no-untyped-def]
            if await txn.get(PENDING_INVITATIONS, guard_id) is not None:
                return False
            if await txn.get(INVITATION_TOKENS, invitation.token_hash) is not None:
                return False
            doc = invitation.to_doc()
            txn.set(invitations_col(org_id), str(invitation.id), doc)
            txn.set(
                PENDING_INVITATIONS,
                guard_id,
                {"org_id": str(org_id), "invitation_id": str(invitation.id)},
            )
            txn.set(
                INVITATION_TOKENS,
                invitation.token_hash,
                {"org_id": str(org_id), "invitation_id": str(invitation.id)},
            )
            return True

        if not await self.uow.db.run_transaction(_create):
            raise ConflictError("A pending invitation already exists")
        return self.uow.track(invitations_col(org_id), invitation)

    async def rotate_token(
        self, invitation: OrganizationInvitation, new_token_hash: str
    ) -> OrganizationInvitation:
        org_id = invitation.org_id
        if org_id is None:
            raise ValueError("Invitation requires org_id")
        old_hash = invitation.token_hash

        async def _rotate(txn):  # type: ignore[no-untyped-def]
            live = await txn.get(invitations_col(org_id), str(invitation.id))
            old_index = await txn.get(INVITATION_TOKENS, old_hash)
            new_index = await txn.get(INVITATION_TOKENS, new_token_hash)
            if (
                live is None
                or live.get("status") != InvitationStatus.PENDING.value
                or live.get("token_hash") != old_hash
                or old_index is None
                or new_index is not None
            ):
                return False
            txn.delete(INVITATION_TOKENS, old_hash)
            invitation.token_hash = new_token_hash
            doc = invitation.to_doc()
            txn.set(invitations_col(org_id), str(invitation.id), doc)
            txn.set(
                INVITATION_TOKENS,
                new_token_hash,
                {"org_id": str(org_id), "invitation_id": str(invitation.id)},
            )
            return True

        if not await self.uow.db.run_transaction(_rotate):
            raise ConflictError("Could not rotate invitation token")
        self.uow.track(invitations_col(org_id), invitation)
        return invitation

    async def close(
        self,
        invitation: OrganizationInvitation,
        status: InvitationStatus,
        *,
        accepted_by: uuid.UUID | None = None,
        accepted_at=None,  # type: ignore[no-untyped-def]
    ) -> OrganizationInvitation | None:
        org_id = invitation.org_id
        if org_id is None:
            raise ValueError("Invitation requires org_id")
        async def _close(txn):  # type: ignore[no-untyped-def]
            live = await txn.get(invitations_col(org_id), str(invitation.id))
            if (
                live is None
                or live.get("status") != InvitationStatus.PENDING.value
                or live.get("token_hash") != invitation.token_hash
            ):
                return False
            closed = dict(live)
            closed["status"] = status.value
            closed["accepted_by"] = str(accepted_by) if accepted_by is not None else None
            closed["accepted_at"] = accepted_at
            closed["updated_at"] = invitation.updated_at
            txn.set(invitations_col(org_id), str(invitation.id), closed)
            if invitation.token_hash:
                txn.delete(INVITATION_TOKENS, invitation.token_hash)
            txn.delete(PENDING_INVITATIONS, pending_guard_id(org_id, invitation.email))
            return True

        if not await self.uow.db.run_transaction(_close):
            return None
        invitation.status = status
        invitation.accepted_by = accepted_by
        invitation.accepted_at = accepted_at
        self.uow.track(invitations_col(org_id), invitation)
        return invitation

    async def resolve_token(self, token_hash: str) -> OrganizationInvitation | None:
        index = await self.uow.get(INVITATION_TOKENS, token_hash)
        if not index:
            return None
        try:
            org_id = uuid.UUID(str(index["org_id"]))
            invitation_id = uuid.UUID(str(index["invitation_id"]))
        except (KeyError, TypeError, ValueError):
            return None
        invitation = await self.get(org_id, invitation_id)
        if invitation is None or invitation.token_hash != token_hash:
            return None
        return invitation

    async def accept(
        self,
        invitation: OrganizationInvitation,
        membership: OrganizationMembership,
        user: User,
        accepted_at,
    ) -> bool:  # type: ignore[no-untyped-def]
        """Atomically consume the token and create both membership records."""
        org_id = invitation.org_id
        if org_id is None:
            return False

        async def _accept(txn):  # type: ignore[no-untyped-def]
            live = await txn.get(invitations_col(org_id), str(invitation.id))
            token_index = await txn.get(INVITATION_TOKENS, invitation.token_hash)
            source = organization_members_col(org_id)
            existing_membership = await txn.get(source, str(user.id))
            user_doc = await txn.get(USERS, str(user.id))
            org_doc = await txn.get(ORGS, str(org_id))
            if (
                live is None
                or live.get("status") != InvitationStatus.PENDING.value
                or live.get("token_hash") != invitation.token_hash
                or token_index is None
                or token_index.get("org_id") != str(org_id)
                or token_index.get("invitation_id") != str(invitation.id)
                or ensure_aware(live.get("expires_at")) is None
                or ensure_aware(live.get("expires_at")) <= accepted_at
                or existing_membership is not None
                or user_doc is None
                or not bool(user_doc.get("is_active", True))
                or org_doc is None
            ):
                return False

            invitation.status = InvitationStatus.ACCEPTED
            invitation.accepted_by = user.id
            invitation.accepted_at = accepted_at
            invitation.updated_at = accepted_at
            membership_doc = membership.to_doc()
            txn.set(source, str(user.id), membership_doc)
            txn.set(user_organizations_col(user.id), str(org_id), membership_doc)
            txn.set(invitations_col(org_id), str(invitation.id), invitation.to_doc())
            txn.delete(INVITATION_TOKENS, invitation.token_hash)
            txn.delete(PENDING_INVITATIONS, pending_guard_id(org_id, invitation.email))

            # Keep the legacy scalar as a default context for old consumers,
            # without changing it when the user already has an organization.
            if user_doc is not None and not user_doc.get("org_id"):
                user_doc["org_id"] = str(org_id)
                user_doc["org_role"] = membership.role.value
                user_doc["updated_at"] = accepted_at
                txn.set(USERS, str(user.id), user_doc)
            return True

        accepted = await self.uow.db.run_transaction(_accept)
        if accepted:
            self.uow.track(invitations_col(org_id), invitation)
            self.uow.track(organization_members_col(org_id), membership, str(user.id))
            if user.org_id is None:
                user.org_id = org_id
                user.org_role = membership.role
                user.updated_at = accepted_at
        return bool(accepted)
