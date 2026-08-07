"""Authorization guards (FastAPI dependencies).

Every guard derives scope from the authenticated Principal — never from
path/body-supplied org or tenant IDs (cross-tenant-isolation.md). Cross-org or
no-access resources return 404 (not 403) to avoid an existence oracle.
"""
from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_principal
from app.authz.policy import is_org_admin
from app.authz.principal import Principal
from app.core.database import get_session
from app.errors import ForbiddenError, NotFoundError
from app.models.enums import ProjectRole
from app.models.project import Project
from app.models.project_membership import ProjectMembership


@dataclass(frozen=True)
class ProjectContext:
    """A project the caller may access, plus their effective role on it."""

    project: Project
    role: ProjectRole


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
    session: AsyncSession = Depends(get_session),
) -> ProjectContext:
    """Load a project scoped to the caller's org and resolve the effective role.

    404 when the project is not in the caller's org or the caller has no
    membership (no existence oracle). ORG_ADMIN is elevated to PROJECT_ADMIN.
    """
    if principal.org_id is None:
        raise NotFoundError("Project not found")

    project = await session.scalar(
        select(Project).where(
            Project.id == project_id, Project.org_id == principal.org_id
        )
    )
    if project is None:
        raise NotFoundError("Project not found")

    if is_org_admin(principal):
        return ProjectContext(project=project, role=ProjectRole.PROJECT_ADMIN)

    membership = await session.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project_id,
            ProjectMembership.user_id == principal.user_id,
        )
    )
    if membership is None:
        raise NotFoundError("Project not found")
    return ProjectContext(project=project, role=membership.role)


def require_project(
    permission: Callable[[ProjectRole], bool], message: str = "Insufficient project permission"
) -> Callable[[ProjectContext], Awaitable[ProjectContext] | ProjectContext]:
    """Build a dependency that enforces a project-level capability predicate."""

    def dependency(ctx: ProjectContext = Depends(get_project_context)) -> ProjectContext:
        if not permission(ctx.role):
            raise ForbiddenError(message)
        return ctx

    return dependency
