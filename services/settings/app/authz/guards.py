"""Authorization guards (FastAPI dependencies).

Every guard derives scope from the authenticated Principal — never from
path/body-supplied org or tenant IDs (cross-tenant-isolation.md). Cross-org or
no-access resources return 404 (not 403) to avoid an existence oracle.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from fastapi import Depends

from app.auth.dependencies import get_principal
from app.authz.policy import can_manage_project_settings, is_org_admin
from app.authz.principal import Principal
from app.core.database import Uow, get_session
from app.errors import ForbiddenError, NotFoundError
from app.models.enums import ProjectRole
from app.repositories.membership_repo import MembershipRepository


@dataclass(frozen=True)
class ProjectContext:
    """A project the caller may access, plus their effective role on it. The
    project id is only ever addressed *within* the caller's org (org_id derives
    from the Principal), so a project id from another org can never reach that
    org's data — it addresses a document under the caller's own org namespace."""

    org_id: uuid.UUID
    project_id: uuid.UUID
    role: ProjectRole


def require_org_admin(principal: Principal = Depends(get_principal)) -> Principal:
    if not is_org_admin(principal):
        raise ForbiddenError("Organization admin privileges required")
    return principal


async def get_project_context(
    project_id: uuid.UUID,
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
) -> ProjectContext:
    """Resolve the caller's effective role on a project, org-scoped to the caller.

    404 when the caller is org-less or has no access to the project (no
    existence oracle). ORG_ADMIN is elevated to PROJECT_ADMIN on every project in
    its own org (so the primary flow needs no membership record). A non-admin
    needs a project membership; its absence — including the cross-org case, where
    the membership lives under a different org path — yields 404.

    INTEGRATION NOTE: project memberships are synced from the org service (the
    source of truth for the project/membership graph); this service does not
    create them. See app/models/membership.py.
    """
    if principal.org_id is None:
        raise NotFoundError("Project not found")

    if is_org_admin(principal):
        return ProjectContext(
            org_id=principal.org_id, project_id=project_id, role=ProjectRole.PROJECT_ADMIN
        )

    membership = await MembershipRepository(session).get(
        principal.org_id, project_id, principal.user_id
    )
    if membership is None:
        raise NotFoundError("Project not found")
    return ProjectContext(
        org_id=principal.org_id, project_id=project_id, role=membership.role
    )


def require_project_admin(
    ctx: ProjectContext = Depends(get_project_context),
) -> ProjectContext:
    """Project settings are managed by project admins (ORG_ADMIN elevated)."""
    if not can_manage_project_settings(ctx.role):
        raise ForbiddenError("Project admin privileges required")
    return ctx
