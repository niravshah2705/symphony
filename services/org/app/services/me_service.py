"""Self-service `/me` extras: persona capture and pending-invite surfacing.

These operate only on the authenticated caller's own identity/email — never a
path/body-supplied id — so there is no cross-user surface.
"""
from __future__ import annotations

import jwt

from app.auth.idp import decode_idp_token, idp_provider, is_idp_issuer
from app.auth.jwt_local import get_unverified_issuer
from app.core.database import Uow
from app.core.timeutils import ensure_aware, utcnow
from app.errors import ValidationAppError
from app.models.enums import Persona
from app.models.user import LinkedIdentity, User
from app.repositories import email_index
from app.repositories.base import ORGS, projects_col
from app.repositories.user_repo import UserRepository
from app.services.common import normalize_email


async def set_persona(session: Uow, user: User, persona: Persona) -> User:
    """Record the caller's self-declared persona (asked once at onboarding).
    ``user`` is tracked, so the mutation flushes on commit."""
    user.persona = persona
    user.updated_at = utcnow()
    return user


async def link_identity(session: Uow, user: User, token: str) -> LinkedIdentity:
    """Attach a SECONDARY sign-in method to the caller's account, proven by a
    valid external-IdP token for that identity.

    Verifying the token means the caller controls that identity, so linking it is
    legitimate account consolidation. The provider label is derived by the SAME
    ``idp_provider`` the auth middleware uses for dedup lookup, so a later sign-in
    via the linked provider resolves back to this account instead of minting a
    duplicate org-less user (identity dedup, §5).
    """
    try:
        issuer = get_unverified_issuer(token)
    except jwt.PyJWTError:
        raise ValidationAppError("Invalid identity token")
    if not is_idp_issuer(issuer):
        raise ValidationAppError("Only an external identity-provider token can be linked")
    try:
        claims = decode_idp_token(token)
    except jwt.PyJWTError:
        raise ValidationAppError("Invalid identity token")
    subject = claims.get("sub")
    if not subject:
        raise ValidationAppError("Token has no subject")
    if claims.get("email_verified") is not True:
        raise ValidationAppError("Identity email is not verified")
    if str(subject) == (user.external_subject or ""):
        raise ValidationAppError("Identity is already your primary sign-in method")
    return await UserRepository(session).link_identity(user, idp_provider(claims), str(subject))


async def list_pending_invitations(session: Uow, user: User) -> list[dict]:
    """Surface any pending org/project invitation addressed to the caller's
    email (via ``email_invitation_index``). Surfacing only — acceptance still
    consumes the single-use token, so this never grants access by itself.

    Expired entries are filtered out; org/project names are best-effort enriched.
    """
    email = normalize_email(user.email)
    entries = await email_index.get_entries(session.db, email)
    now = utcnow()
    out: list[dict] = []
    for entry in entries:
        expires_at = ensure_aware(entry.get("expires_at"))
        if expires_at is not None and expires_at <= now:
            continue
        org_id = entry.get("org_id")
        org_name = None
        if org_id:
            org_doc = await session.get(ORGS, str(org_id))
            org_name = org_doc.get("name") if isinstance(org_doc, dict) else None
        project_name = None
        project_id = entry.get("project_id")
        if org_id and project_id:
            project_doc = await session.get(projects_col(org_id), str(project_id))
            project_name = project_doc.get("name") if isinstance(project_doc, dict) else None
        out.append(
            {
                "kind": entry.get("kind"),
                "organization_id": org_id,
                "organization_name": org_name,
                "project_id": project_id,
                "project_name": project_name,
                "role": entry.get("role"),
                "expires_at": entry.get("expires_at"),
            }
        )
    return out
