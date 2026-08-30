"""Authorization guards (FastAPI dependencies).

Every guard derives scope from the authenticated Principal — never from
path/body-supplied org or tenant IDs (cross-tenant-isolation.md). Cross-org or
no-access resources return 404 (not 403) to avoid an existence oracle.
"""
from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable

from fastapi import Depends

from app.auth.dependencies import get_principal
from app.authz.policy import is_org_admin
from app.authz.principal import Principal
from app.authz.project_access import ProjectContext, resolve_project_access
from app.core.database import Uow, get_session
from app.errors import ForbiddenError, NotFoundError
from app.models.enums import ProjectRole

# ProjectContext is defined in project_access (shared with the auth middleware);
# re-exported here so routes keep importing it from app.authz.guards.
__all__ = [
    "ProjectContext",
    "require_super_admin",
    "require_org_admin",
    "require_org_member",
    "get_project_context",
    "require_project",
]


def require_super_admin(principal: Principal = Depends(get_principal)) -> Principal:
    if not principal.is_super_admin:
        raise ForbiddenError("Super-admin privileges required")
    return principal


def require_org_admin(principal: Principal = Depends(get_principal)) -> Principal:
    if not is_org_admin(principal):
        raise ForbiddenError("Organization admin privileges required")
    return principal


def require_org_member(principal: Principal = Depends(get_principal)) -> Principal:
    """Any user scoped to an org (excludes org-less super-admins)."""
    if principal.org_id is None:
        raise ForbiddenError("Organization membership required")
    return principal


async def get_project_context(
    project_id: uuid.UUID,
    principal: Principal = Depends(get_principal),
    session: Uow = Depends(get_session),
) -> ProjectContext:
    """Resolve the caller's effective role on a project (own-org or cross-org).

    404 (no existence oracle) when the caller has no access. Same-org resolution
    (ORG_ADMIN → PROJECT_ADMIN, explicit membership, ORG_WIDE) and cross-org
    resolution (external grant / cross-org membership) both live in
    ``resolve_project_access``.
    """
    # An explicit validated project selection narrows the request. A caller may
    # not select one project and operate on another path id.
    if principal.project_id is not None and principal.project_id != project_id:
        raise NotFoundError("Project not found")

    ctx = await resolve_project_access(
        session,
        user_id=principal.user_id,
        org_id=principal.org_id,
        org_role=principal.org_role,
        project_id=project_id,
    )
    if ctx is None:
        raise NotFoundError("Project not found")
    return ctx


def require_project(
    permission: Callable[[ProjectRole], bool], message: str = "Insufficient project permission"
) -> Callable[[ProjectContext], Awaitable[ProjectContext] | ProjectContext]:
    """Build a dependency that enforces a project-level capability predicate."""

    def dependency(ctx: ProjectContext = Depends(get_project_context)) -> ProjectContext:
        if not permission(ctx.role):
            raise ForbiddenError(message)
        return ctx

    return dependency
