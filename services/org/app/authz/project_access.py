"""Resolve a caller's effective access to a project — including cross-org.

This is the single place that answers *"can this user reach this project, and as
what role?"*. It is shared by ``guards.get_project_context`` (route authz) and the
auth middleware's project-selection validation so the two never diverge.

Resolution order (first match wins; ``None`` → caller has no access → 404):

1. **Own org (fast path, unchanged behavior).** The project lives under the
   caller's selected org. ORG_ADMIN → PROJECT_ADMIN; an explicit
   ``ProjectMembership`` → its role; otherwise ``ORG_WIDE`` access mode grants
   every org member DEVELOPER, and ``INVITE_ONLY`` denies.
2. **Cross-org (new).** The project is owned by a *different* org, located via
   the flat ``project_owner_index``. Access is granted only by an explicit
   record under the owner org:
   - a ``ProjectMembership`` carrying ``member_org_id`` (an outside individual or
     cross-org collaborator who accepted a ``ProjectInvitation``), or
   - a ``ProjectExternalOrgGrant`` for the caller's whole org (outsourcing).

Org isolation is preserved: a caller with no such record gets ``None`` (→ 404),
never an existence oracle (CLAUDE.md invariant #1).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from app.models.enums import OrgRole, ProjectAccessMode, ProjectRole
from app.models.project import Project
from app.repositories.base import PROJECT_OWNER_INDEX
from app.repositories.membership_repo import MembershipRepository
from app.repositories.project_external_grant_repo import ProjectExternalGrantRepository
from app.repositories.project_repo import ProjectRepository


@dataclass(frozen=True)
class ProjectContext:
    """A project the caller may access, plus their effective role on it."""

    project: Project
    role: ProjectRole


def _is_org_admin(org_id: uuid.UUID | None, org_role: OrgRole) -> bool:
    return org_id is not None and org_role == OrgRole.ORG_ADMIN


async def resolve_project_access(
    uow,  # app.core.database.Uow (untyped to avoid an import cycle)
    *,
    user_id: uuid.UUID,
    org_id: uuid.UUID | None,
    org_role: OrgRole,
    project_id: uuid.UUID,
) -> ProjectContext | None:
    # 1. Fast path: the caller's own org owns the project.
    if org_id is not None:
        project = await ProjectRepository(uow).get(project_id, org_id)
        if project is not None:
            return await _resolve_same_org(uow, project, user_id, org_id, org_role)

    # 2. Cross-org path: find the owning org through the flat index.
    owner_org_id = await _owner_org(uow, project_id)
    if owner_org_id is None or owner_org_id == org_id:
        return None
    project = await ProjectRepository(uow).get(project_id, owner_org_id)
    if project is None:
        return None

    # 2a. An outside individual / cross-org collaborator with an explicit
    #     membership under the owner org (member_org_id set on accept).
    membership = await MembershipRepository(uow).get(owner_org_id, project_id, user_id)
    if membership is not None:
        return ProjectContext(project=project, role=membership.role)

    # 2b. The caller's whole org was granted access (outsourcing).
    if org_id is not None:
        grant = await ProjectExternalGrantRepository(uow).get(owner_org_id, project_id, org_id)
        if grant is not None:
            return ProjectContext(project=project, role=grant.default_role)

    return None


async def _resolve_same_org(
    uow,  # type: ignore[no-untyped-def]
    project: Project,
    user_id: uuid.UUID,
    org_id: uuid.UUID,
    org_role: OrgRole,
) -> ProjectContext | None:
    if _is_org_admin(org_id, org_role):
        return ProjectContext(project=project, role=ProjectRole.PROJECT_ADMIN)
    membership = await MembershipRepository(uow).get(org_id, project.id, user_id)
    if membership is not None:
        return ProjectContext(project=project, role=membership.role)
    if project.access_mode == ProjectAccessMode.ORG_WIDE:
        return ProjectContext(project=project, role=ProjectRole.DEVELOPER)
    return None


async def _owner_org(uow, project_id: uuid.UUID) -> uuid.UUID | None:  # type: ignore[no-untyped-def]
    doc = await uow.get(PROJECT_OWNER_INDEX, str(project_id))
    if not isinstance(doc, dict):
        return None
    try:
        return uuid.UUID(str(doc["owner_org_id"]))
    except (KeyError, TypeError, ValueError):
        return None
