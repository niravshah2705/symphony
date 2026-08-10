"""Self-service organization creation.

An authenticated but org-less user (e.g. a Firebase user JIT-provisioned with
``org_id=None``) creates their own organization and becomes its first
ORG_ADMIN. This is the upgrade path from a private personal workspace to a
shared org (the only way to gain the ability to add other people to projects —
see docs/ACCESS_MODEL.md). Distinct from the super-admin-only
``POST /organizations`` cross-org endpoint.
"""
from __future__ import annotations

import uuid

from app.core.database import Uow
from app.core.timeutils import utcnow
from app.errors import ConflictError
from app.models.enums import OrgRole
from app.models.organization import Organization
from app.models.user import User
from app.repositories.base import USER_ORG_LOCKS
from app.repositories.org_repo import OrgRepository
from app.schemas.me import CreateOrgRequest
from app.services.common import allocate_org_slug

# Cap the derived workspace name well under the org-name max (200) to leave room
# for the possessive suffix.
_MAX_WORKSPACE_BASE = 180


async def create_organization_for_user(
    session: Uow, user: User, data: CreateOrgRequest
) -> Organization:
    if user.org_id is not None:
        raise ConflictError("You already belong to an organization")

    org = Organization(
        name=data.name,
        description=data.description,
        slug=await allocate_org_slug(session),
    )
    await OrgRepository(session).add(org)

    # The caller becomes the org's first admin. `user` was loaded via
    # get_current_user (tracked), so these mutations flush on commit.
    user.org_id = org.id
    user.org_role = OrgRole.ORG_ADMIN
    user.updated_at = utcnow()
    return org


def derive_workspace_name(user: User) -> str:
    """A friendly pseudo-name for an auto-provisioned workspace.

    Prefers the first token of the display name, else the email local-part, so a
    Firebase user lands in a recognizable "<name>'s Workspace" instead of an
    opaque id. Deterministic for a given user (two concurrent first requests
    derive the same name). Never feeds the opaque `slug` — display only, so it
    adds no org-enumeration surface (core/security.py).
    """
    full = (user.full_name or "").strip()
    if full:
        base = full.split()[0]
    else:
        email = (user.email or "").strip()
        base = email.split("@", 1)[0] if email else ""
    base = (base or "My").strip()[:_MAX_WORKSPACE_BASE].strip()
    return f"{base}'s Workspace"


async def ensure_org_for_user(session: Uow, user: User) -> Organization:
    """Idempotently ensure an org-less user has a (pseudo) workspace org.

    Unlike ``create_organization_for_user`` (the explicit, name-it UI path that
    409s if the user already has an org), this is the lazy auto path invoked by
    the deployment resolver: it returns the existing org when present and never
    raises on re-call. Pseudo workspaces stay on the SHARED stack — this does NOT
    trigger per-tenant provisioning.

    One-org-per-user is enforced with an atomic create-if-absent lock keyed by
    the user id (mirrors the email/external-subject guards in user_repo.add), so
    two concurrent first requests cannot each mint an org.
    """
    if user.org_id is not None:
        return await OrgRepository(session).get(user.org_id)

    org = Organization(
        name=derive_workspace_name(user),
        slug=await allocate_org_slug(session),
    )
    won = await session.db.create(USER_ORG_LOCKS, str(user.id), {"org_id": str(org.id)})
    if not won:
        # A concurrent request already claimed this user's workspace. Adopt the
        # winner's org id from the lock; reflect membership on this session's user
        # record too (idempotent). If the winner's org doc hasn't flushed yet
        # (a narrow window), fall back to a transient org carrying the same
        # deterministic name + authoritative id — the next call reads the persisted one.
        lock = await session.db.get(USER_ORG_LOCKS, str(user.id))
        org_id = uuid.UUID(lock["org_id"]) if lock and lock.get("org_id") else org.id
        if user.org_id != org_id:
            user.org_id = org_id
            user.org_role = OrgRole.ORG_ADMIN
            user.updated_at = utcnow()
        existing = await OrgRepository(session).get(org_id)
        return existing or Organization(name=derive_workspace_name(user), id=org_id)

    await OrgRepository(session).add(org)
    user.org_id = org.id
    user.org_role = OrgRole.ORG_ADMIN
    user.updated_at = utcnow()
    return org
