"""Project-invitation lifecycle: invite one outside-domain person to a single
project (not the whole org).

Shaped like ``invitation_service`` (org invitations) but project-scoped. Accepting
creates a ``ProjectMembership`` under the project's OWNER org carrying
``member_org_id`` so a cross-org or org-less collaborator is resolvable by
``get_project_context``.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

from app.authz.principal import Principal
from app.core.config import get_settings
from app.core.database import Uow
from app.core.security import generate_verification_token, hash_token
from app.core.timeutils import ensure_aware, utcnow
from app.errors import ConflictError, ForbiddenError, NotFoundError
from app.models.enums import InvitationStatus
from app.models.project import Project
from app.models.project_invitation import ProjectInvitation
from app.models.project_membership import ProjectMembership
from app.models.user import User
from app.repositories.membership_repo import MembershipRepository
from app.repositories.project_invitation_repo import ProjectInvitationRepository
from app.repositories.project_repo import ProjectRepository
from app.repositories.user_repo import UserRepository
from app.services import invitation_notifier
from app.services.common import normalize_email


def generate_invitation_token() -> str:
    """Injection boundary for deterministic tests; returns a CSPRNG token."""
    return generate_verification_token()


async def create_project_invitation(
    session: Uow, principal: Principal, project: Project, data
) -> dict:  # type: ignore[no-untyped-def]
    email = normalize_email(str(data.email))
    user_repo = UserRepository(session)

    # If a user with this email already has a membership on the project, there's
    # nothing to invite.
    existing_user = await user_repo.get_global_by_email(email)
    if existing_user is not None:
        if (
            await MembershipRepository(session).get(project.org_id, project.id, existing_user.id)
            is not None
        ):
            raise ConflictError("User is already a member of this project")

    repo = ProjectInvitationRepository(session)
    now = utcnow()
    for existing in await repo.list_for_project(project.org_id, project.id):
        if existing.email != email or existing.status != InvitationStatus.PENDING:
            continue
        if _is_expired(existing, now):
            existing.updated_at = now
            await repo.close(existing, InvitationStatus.EXPIRED)
        else:
            raise ConflictError("A pending invitation already exists")

    # Ensure the project is locatable cross-org (lazy backfill for projects that
    # predate the owner index) before inviting an outside individual.
    await ProjectRepository(session).ensure_owner_index(project)

    raw_token = generate_invitation_token()
    invitation = ProjectInvitation(
        project_id=project.id,
        org_id=project.org_id,
        email=email,
        role=data.role,
        token_hash=hash_token(raw_token),
        invited_by=principal.user_id,
        expires_at=now + timedelta(days=get_settings().invitation_ttl_days),
    )
    await repo.add(invitation)
    # Commit before any external side effect so a delivery failure cannot hide
    # the persisted invitation (resend remains viable).
    await session.commit()
    delivery_status = await _notify(session, invitation, raw_token, project, principal.user_id)
    return _response(invitation, delivery_status=delivery_status)


async def list_project_invitations(session: Uow, project: Project) -> list[dict]:
    repo = ProjectInvitationRepository(session)
    now = utcnow()
    invitations = await repo.list_for_project(project.org_id, project.id)
    for invitation in invitations:
        if invitation.status == InvitationStatus.PENDING and _is_expired(invitation, now):
            invitation.updated_at = now
            await repo.close(invitation, InvitationStatus.EXPIRED)
    return [_response(invitation) for invitation in invitations]


async def revoke_project_invitation(
    session: Uow, project: Project, invitation_id: uuid.UUID
) -> None:
    repo = ProjectInvitationRepository(session)
    invitation = await repo.get(project.org_id, project.id, invitation_id)
    if invitation is None:
        raise NotFoundError("Invitation not found")
    if invitation.status != InvitationStatus.PENDING:
        raise ConflictError("Invitation is no longer pending")
    invitation.updated_at = utcnow()
    if await repo.close(invitation, InvitationStatus.REVOKED) is None:
        raise ConflictError("Invitation is no longer pending")


async def accept_project_invitation(
    session: Uow, user: User, raw_token: str
) -> dict:
    token_hash = hash_token(raw_token)
    repo = ProjectInvitationRepository(session)
    invitation = await repo.resolve_token(token_hash)
    if invitation is None or invitation.status != InvitationStatus.PENDING:
        raise NotFoundError("Invitation not found")
    now = utcnow()
    if _is_expired(invitation, now):
        invitation.updated_at = now
        await repo.close(invitation, InvitationStatus.EXPIRED)
        raise ConflictError("Invitation has expired")
    if normalize_email(user.email) != invitation.email:
        raise ForbiddenError("Invitation is not valid for this account")

    # Re-verify the target project still exists (mirrors org accept re-reading
    # the org). Invitation cleanup on project/org delete is best-effort, so this
    # closes the window where an accept could create an orphan membership under a
    # deleted project's owner org.
    if await ProjectRepository(session).get(invitation.project_id, invitation.org_id) is None:
        raise NotFoundError("Invitation not found")

    # Already a member (e.g. added directly meanwhile) → nothing to do.
    if (
        await MembershipRepository(session).get(invitation.org_id, invitation.project_id, user.id)
        is not None
    ):
        raise ConflictError("User is already a member of this project")

    membership = ProjectMembership(
        project_id=invitation.project_id,
        user_id=user.id,
        role=invitation.role,
        # The accepting user's home org (None for an org-less individual). This is
        # what lets get_project_context recognize a cross-org member whose
        # principal.org_id differs from the project's owning org.
        member_org_id=user.org_id,
    )
    if not await repo.accept(invitation, membership, user.id, now):
        raise ConflictError("Invitation is no longer available")
    return {
        "invitation_id": invitation.id,
        "invitation_status": invitation.status,
        "project_id": invitation.project_id,
        "organization_id": invitation.org_id,
        "membership": {
            "id": membership.id,
            "project_id": membership.project_id,
            "user_id": membership.user_id,
            "role": membership.role,
            "member_org_id": membership.member_org_id,
        },
    }


def _is_expired(invitation: ProjectInvitation, now) -> bool:  # type: ignore[no-untyped-def]
    expires_at = ensure_aware(invitation.expires_at)
    return expires_at is None or expires_at <= now


async def _notify(
    session: Uow,
    invitation: ProjectInvitation,
    raw_token: str,
    project: Project,
    inviter_id: uuid.UUID,
) -> str:
    inviter = await UserRepository(session).get_by_id(inviter_id)
    variables: dict = {
        "projectName": project.name,
        "invitationToken": raw_token,
        "expiresInMinutes": get_settings().invitation_ttl_days * 24 * 60,
    }
    if inviter is not None:
        variables["inviterName"] = " ".join(str(inviter.full_name or inviter.email).split())[:200]
    payload = {
        "template": "project-invitation",
        "idempotencyKey": f"project-invitation:{invitation.id}",
        "to": invitation.email,
        "variables": variables,
    }
    try:
        queued = await invitation_notifier.publish_invitation(payload)
        return "queued" if queued else "failed"
    except Exception:
        # Never log the exception/payload — either may embed the raw token.
        return "failed"


def _response(
    invitation: ProjectInvitation, *, delivery_status: str | None = None
) -> dict:
    response = {
        "id": invitation.id,
        "project_id": invitation.project_id,
        "organization_id": invitation.org_id,
        "email": invitation.email,
        "role": invitation.role,
        "status": invitation.status,
        "invited_by": invitation.invited_by,
        "expires_at": invitation.expires_at,
        "accepted_by": invitation.accepted_by,
        "accepted_at": invitation.accepted_at,
        "created_at": invitation.created_at,
        "updated_at": invitation.updated_at,
    }
    if delivery_status is not None:
        response["delivery_status"] = delivery_status
    return response
