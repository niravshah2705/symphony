"""Project-invitation persistence with single-use hashed-token indexes.

Mirrors ``InvitationRepository`` one level down (project- rather than
org-scoped). Invitations live at
``organizations/{org_id}/projects/{project_id}/invitations/{id}``; a pending
guard doc and a token index enforce single-use, and the by-email
``email_invitation_index`` is kept in sync inside the same transactions.
"""
from __future__ import annotations

import hashlib
import uuid

from app.core.database import Uow
from app.core.timeutils import ensure_aware
from app.errors import ConflictError
from app.models.enums import InvitationStatus
from app.models.project_invitation import ProjectInvitation
from app.models.project_membership import ProjectMembership
from app.repositories import email_index
from app.repositories.base import (
    PROJECT_INVITATION_TOKENS,
    PROJECT_PENDING_INVITATIONS,
    memberships_col,
    project_invitations_col,
)


def project_pending_guard_id(project_id: uuid.UUID, email: str) -> str:
    return hashlib.sha256(f"{project_id}:{email}".encode("utf-8")).hexdigest()


async def cleanup_project_invitations(db, org_id: uuid.UUID, project_id: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    """Delete all of a project's invitations and their token/pending/email
    guard docs. Best-effort cascade for project/org deletion (mirrors the org
    invitation cleanup in ``OrgRepository.delete``)."""
    collection = project_invitations_col(org_id, project_id)
    for inv in await db.query(collection):
        token_hash = inv.get("token_hash")
        if token_hash:
            await db.delete(PROJECT_INVITATION_TOKENS, token_hash)
        email = inv.get("email")
        if email:
            await db.delete(
                PROJECT_PENDING_INVITATIONS, project_pending_guard_id(project_id, email)
            )
            await email_index.remove_direct(db, email, inv.get("id"))
        await db.delete(collection, inv["id"])


class ProjectInvitationRepository:
    def __init__(self, uow: Uow) -> None:
        self.uow = uow

    async def get(
        self, org_id: uuid.UUID, project_id: uuid.UUID, invitation_id: uuid.UUID
    ) -> ProjectInvitation | None:
        collection = project_invitations_col(org_id, project_id)
        existing = self.uow.tracked(collection, str(invitation_id))
        if existing is not None:
            return existing
        doc = await self.uow.get(collection, str(invitation_id))
        return (
            self.uow.track(collection, ProjectInvitation.from_doc(doc))
            if doc is not None
            else None
        )

    async def list_for_project(
        self, org_id: uuid.UUID, project_id: uuid.UUID
    ) -> list[ProjectInvitation]:
        collection = project_invitations_col(org_id, project_id)
        rows = await self.uow.query(collection, order_by="created_at", desc=True)
        return self.uow.track_all(
            collection, [ProjectInvitation.from_doc(row) for row in rows]
        )

    async def add(self, invitation: ProjectInvitation) -> ProjectInvitation:
        org_id, project_id = invitation.org_id, invitation.project_id
        if org_id is None or project_id is None:
            raise ValueError("Project invitation requires org_id and project_id")
        collection = project_invitations_col(org_id, project_id)
        guard_id = project_pending_guard_id(project_id, invitation.email)
        index_entry = email_index.make_entry(
            kind="project",
            org_id=org_id,
            project_id=project_id,
            invitation_id=invitation.id,
            role=invitation.role.value,
            expires_at=invitation.expires_at,
        )

        async def _create(txn):  # type: ignore[no-untyped-def]
            if await txn.get(PROJECT_PENDING_INVITATIONS, guard_id) is not None:
                return False
            if await txn.get(PROJECT_INVITATION_TOKENS, invitation.token_hash) is not None:
                return False
            # READ before any write (Firestore read-before-write).
            email_entries = await email_index.read_entries(txn, invitation.email)
            index = {
                "org_id": str(org_id),
                "project_id": str(project_id),
                "invitation_id": str(invitation.id),
            }
            txn.set(collection, str(invitation.id), invitation.to_doc())
            txn.set(PROJECT_PENDING_INVITATIONS, guard_id, index)
            txn.set(PROJECT_INVITATION_TOKENS, invitation.token_hash, index)
            email_index.write_add(txn, invitation.email, email_entries, index_entry)
            return True

        if not await self.uow.db.run_transaction(_create):
            raise ConflictError("A pending invitation already exists")
        return self.uow.track(collection, invitation)

    async def close(
        self,
        invitation: ProjectInvitation,
        status: InvitationStatus,
        *,
        accepted_by: uuid.UUID | None = None,
        accepted_at=None,  # type: ignore[no-untyped-def]
    ) -> ProjectInvitation | None:
        org_id, project_id = invitation.org_id, invitation.project_id
        if org_id is None or project_id is None:
            raise ValueError("Project invitation requires org_id and project_id")
        collection = project_invitations_col(org_id, project_id)

        async def _close(txn):  # type: ignore[no-untyped-def]
            live = await txn.get(collection, str(invitation.id))
            # READ before any write (Firestore read-before-write).
            email_entries = await email_index.read_entries(txn, invitation.email)
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
            txn.set(collection, str(invitation.id), closed)
            if invitation.token_hash:
                txn.delete(PROJECT_INVITATION_TOKENS, invitation.token_hash)
            txn.delete(
                PROJECT_PENDING_INVITATIONS,
                project_pending_guard_id(project_id, invitation.email),
            )
            email_index.write_remove(txn, invitation.email, email_entries, invitation.id)
            return True

        if not await self.uow.db.run_transaction(_close):
            return None
        invitation.status = status
        invitation.accepted_by = accepted_by
        invitation.accepted_at = accepted_at
        self.uow.track(collection, invitation)
        return invitation

    async def resolve_token(self, token_hash: str) -> ProjectInvitation | None:
        index = await self.uow.get(PROJECT_INVITATION_TOKENS, token_hash)
        if not index:
            return None
        try:
            org_id = uuid.UUID(str(index["org_id"]))
            project_id = uuid.UUID(str(index["project_id"]))
            invitation_id = uuid.UUID(str(index["invitation_id"]))
        except (KeyError, TypeError, ValueError):
            return None
        invitation = await self.get(org_id, project_id, invitation_id)
        if invitation is None or invitation.token_hash != token_hash:
            return None
        return invitation

    async def accept(
        self,
        invitation: ProjectInvitation,
        membership: ProjectMembership,
        user_id: uuid.UUID,
        accepted_at,
    ) -> bool:  # type: ignore[no-untyped-def]
        """Atomically consume the token and create the project membership.

        The membership is written under the project's OWNER org
        (``memberships_col(owner_org)``) carrying ``member_org_id`` so a
        cross-org or org-less collaborator is resolvable by
        ``get_project_context``. Keyed by ``membership.id`` to match
        ``MembershipRepository`` (which enforces (project, user) uniqueness with
        a service-level pre-check); the single-use token guard makes concurrent
        accepts of the SAME invitation impossible to double-apply.
        """
        org_id, project_id = invitation.org_id, invitation.project_id
        if org_id is None or project_id is None:
            return False
        collection = project_invitations_col(org_id, project_id)
        members = memberships_col(org_id)

        async def _accept(txn):  # type: ignore[no-untyped-def]
            live = await txn.get(collection, str(invitation.id))
            token_index = await txn.get(PROJECT_INVITATION_TOKENS, invitation.token_hash)
            # READ before any write (Firestore read-before-write).
            email_entries = await email_index.read_entries(txn, invitation.email)
            if (
                live is None
                or live.get("status") != InvitationStatus.PENDING.value
                or live.get("token_hash") != invitation.token_hash
                or token_index is None
                or token_index.get("invitation_id") != str(invitation.id)
                or ensure_aware(live.get("expires_at")) is None
                or ensure_aware(live.get("expires_at")) <= accepted_at
            ):
                return False

            invitation.status = InvitationStatus.ACCEPTED
            invitation.accepted_by = user_id
            invitation.accepted_at = accepted_at
            invitation.updated_at = accepted_at
            txn.set(collection, str(invitation.id), invitation.to_doc())
            txn.set(members, str(membership.id), membership.to_doc())
            txn.delete(PROJECT_INVITATION_TOKENS, invitation.token_hash)
            txn.delete(
                PROJECT_PENDING_INVITATIONS,
                project_pending_guard_id(project_id, invitation.email),
            )
            email_index.write_remove(txn, invitation.email, email_entries, invitation.id)
            return True

        accepted = await self.uow.db.run_transaction(_accept)
        if accepted:
            self.uow.track(collection, invitation)
            self.uow.track(members, membership)
        return bool(accepted)
