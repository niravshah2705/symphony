"""Explicit, authenticated organization invitation lifecycle."""
from __future__ import annotations

from datetime import timedelta

from app.authz.principal import Principal
from app.core.config import get_settings
from app.core.database import Uow
from app.core.security import generate_verification_token, hash_token
from app.core.timeutils import ensure_aware, utcnow
from app.errors import ConflictError, ForbiddenError, NotFoundError
from app.models.enums import InvitationStatus
from app.models.organization_invitation import OrganizationInvitation
from app.models.organization_membership import OrganizationMembership
from app.models.user import User
from app.repositories.invitation_repo import InvitationRepository
from app.repositories.org_repo import OrgRepository
from app.repositories.user_repo import UserRepository
from app.schemas.invitation import InvitationCreate
from app.services import invitation_notifier
from app.services.common import normalize_email


def generate_invitation_token() -> str:
    """Injection boundary for deterministic tests; returns a CSPRNG token."""
    return generate_verification_token()


async def create_invitation(
    session: Uow, principal: Principal, data: InvitationCreate
) -> dict:
    org = await _selected_org(session, principal)
    email = normalize_email(str(data.email))
    user_repo = UserRepository(session)
    existing_user = await user_repo.get_global_by_email(email)
    if (
        existing_user is not None
        and await user_repo.get_in_org(existing_user.id, org.id) is not None
    ):
        raise ConflictError("User is already a member of this organization")

    repo = InvitationRepository(session)
    now = utcnow()
    for existing in await repo.list_for_org(org.id):
        if existing.email != email or existing.status != InvitationStatus.PENDING:
            continue
        if _is_expired(existing, now):
            existing.updated_at = now
            await repo.close(existing, InvitationStatus.EXPIRED)
        else:
            raise ConflictError("A pending invitation already exists")

    raw_token = generate_invitation_token()
    invitation = OrganizationInvitation(
        org_id=org.id,
        email=email,
        role=data.org_role,
        token_hash=hash_token(raw_token),
        invited_by=principal.user_id,
        expires_at=now + timedelta(days=get_settings().invitation_ttl_days),
    )
    await repo.add(invitation)
    # Explicitly flush/commit before any external side effect. A delivery failure
    # cannot roll back or hide the persisted invitation, so resend remains viable.
    await session.commit()
    delivery_status = await _notify(
        session, invitation, raw_token, org.name, principal.user_id, existing_user
    )
    return _response(invitation, delivery_status=delivery_status)


async def list_invitations(session: Uow, principal: Principal) -> list[dict]:
    org = await _selected_org(session, principal)
    repo = InvitationRepository(session)
    now = utcnow()
    invitations = await repo.list_for_org(org.id)
    for invitation in invitations:
        if invitation.status == InvitationStatus.PENDING and _is_expired(invitation, now):
            invitation.updated_at = now
            await repo.close(invitation, InvitationStatus.EXPIRED)
    return [_response(invitation) for invitation in invitations]


async def resend_invitation(
    session: Uow, principal: Principal, invitation_id
) -> dict:  # type: ignore[no-untyped-def]
    org = await _selected_org(session, principal)
    repo = InvitationRepository(session)
    invitation = await repo.get(org.id, invitation_id)
    if invitation is None:
        raise NotFoundError("Invitation not found")
    await _require_pending(repo, invitation)

    raw_token = generate_invitation_token()
    invitation.delivery_attempt += 1
    invitation.expires_at = utcnow() + timedelta(days=get_settings().invitation_ttl_days)
    invitation.updated_at = utcnow()
    await repo.rotate_token(invitation, hash_token(raw_token))
    await session.commit()
    recipient_user = await UserRepository(session).get_global_by_email(invitation.email)
    delivery_status = await _notify(
        session, invitation, raw_token, org.name, principal.user_id, recipient_user
    )
    return _response(invitation, delivery_status=delivery_status)


async def revoke_invitation(
    session: Uow, principal: Principal, invitation_id
) -> None:  # type: ignore[no-untyped-def]
    org = await _selected_org(session, principal)
    repo = InvitationRepository(session)
    invitation = await repo.get(org.id, invitation_id)
    if invitation is None:
        raise NotFoundError("Invitation not found")
    await _require_pending(repo, invitation)
    invitation.updated_at = utcnow()
    if await repo.close(invitation, InvitationStatus.REVOKED) is None:
        raise ConflictError("Invitation is no longer pending")


async def accept_invitation(
    session: Uow, principal: Principal, user: User, raw_token: str
) -> dict:
    token_hash = hash_token(raw_token)
    repo = InvitationRepository(session)
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
    org = await OrgRepository(session).get(invitation.org_id)
    if org is None:
        raise NotFoundError("Invitation not found")

    membership = OrganizationMembership(
        org_id=org.id, user_id=user.id, role=invitation.role
    )
    if not await repo.accept(invitation, membership, user, now):
        raise ConflictError("Invitation is no longer available")
    return {
        "invitation_id": invitation.id,
        "invitation_status": invitation.status,
        "organization": {"id": org.id, "name": org.name},
        "membership": {
            "id": membership.id,
            "role": membership.role,
            "status": membership.status,
        },
    }


async def _selected_org(session: Uow, principal: Principal):  # type: ignore[no-untyped-def]
    if principal.org_id is None:
        raise NotFoundError("Organization not found")
    org = await OrgRepository(session).get(principal.org_id)
    if org is None:
        raise NotFoundError("Organization not found")
    return org


async def _require_pending(
    repo: InvitationRepository, invitation: OrganizationInvitation
) -> None:
    if invitation.status != InvitationStatus.PENDING:
        raise ConflictError("Invitation is no longer pending")
    now = utcnow()
    if _is_expired(invitation, now):
        invitation.updated_at = now
        await repo.close(invitation, InvitationStatus.EXPIRED)
        raise ConflictError("Invitation has expired")


def _is_expired(invitation: OrganizationInvitation, now) -> bool:  # type: ignore[no-untyped-def]
    expires_at = ensure_aware(invitation.expires_at)
    return expires_at is None or expires_at <= now


async def _notify(
    session: Uow,
    invitation: OrganizationInvitation,
    raw_token: str,
    organization_name: str,
    inviter_id,
    recipient_user: User | None,
) -> str:  # type: ignore[no-untyped-def]
    inviter = await UserRepository(session).get_by_id(inviter_id)
    variables: dict = {
        "organizationName": organization_name,
        "invitationToken": raw_token,
        "expiresInMinutes": get_settings().invitation_ttl_days * 24 * 60,
    }
    if inviter is not None:
        variables["inviterName"] = _notification_name(inviter.full_name or inviter.email)
    if recipient_user is not None and recipient_user.full_name:
        variables["recipientName"] = _notification_name(recipient_user.full_name)
    payload = {
        "template": "invitation",
        "idempotencyKey": (
            f"organization-invitation:{invitation.id}:{invitation.delivery_attempt}"
        ),
        "to": invitation.email,
        "variables": variables,
    }
    try:
        queued = await invitation_notifier.publish_invitation(payload)
        return "queued" if queued else "failed"
    except Exception:
        # Never log the exception/payload: adapters may embed the raw token in
        # either. The persisted invitation remains available for resend.
        return "failed"


def _notification_name(value: str) -> str:
    """Fit IdP-provided names to the email service's bounded text contract."""
    return " ".join(str(value).split())[:200]


def _response(
    invitation: OrganizationInvitation, *, delivery_status: str | None = None
) -> dict:
    response = {
        "id": invitation.id,
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
